import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Tenant-isolated JSON store.
 * - Durable backend: Vercel Blob (private) when BLOB_READ_WRITE_TOKEN is set, at `<app>/<tenant>/<file>`,
 *   with ETag optimistic concurrency (retries on conflict).
 * - Fallback: local JSON files under DATA_DIR or ~/.<app>/<tenant>/ (or /tmp on serverless without Blob; ephemeral).
 * The tenant is a one-way SHA-256 hash of the caller's credentials (or `x-user-key` header), so tenants never see each
 * other's data and no secret is stored in the key. Callers with no credentials share the `public-demo` tenant.
 */
const tenantCtx = new AsyncLocalStorage<string>();
export const DEMO_TENANT = "public-demo";
export function tenantId(parts: Record<string, string | undefined>): string {
  const vals = Object.keys(parts).sort().filter(k => parts[k]).map(k => `${k}=${parts[k]}`);
  return vals.length ? "t_" + createHash("sha256").update(vals.join("\n")).digest("hex").slice(0, 32) : DEMO_TENANT;
}
export function withTenant<R>(tenant: string, fn: () => R): R { return tenantCtx.run(tenant, fn); }
export const currentTenant = () => tenantCtx.getStore() ?? process.env.STORE_TENANT ?? "local";
export const storeBackend = () => (process.env.BLOB_READ_WRITE_TOKEN ? "vercel-blob" : "local-json");

export interface Backend { read(key: string): Promise<{ data: string; etag?: string } | null>; write(key: string, data: string, etag?: string): Promise<void>; }
export class ConflictError extends Error {}

const localBackend = (app: string): Backend => {
  const base = () => process.env.DATA_DIR || (process.env.VERCEL ? `/tmp/${app}` : path.join(os.homedir(), `.${app}`));
  return {
    async read(key) { try { return { data: await fs.readFile(path.join(base(), key), "utf8") }; } catch { return null; } },
    async write(key, data) { const p = path.join(base(), key); await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, data); },
  };
};
const normEtag = (e?: string | null) => (e ?? "").replace(/^W\//, "").replace(/"/g, "");
const blobBackend = (app: string): Backend => ({
  async read(key) {
    const { get, head, BlobNotFoundError } = await import("@vercel/blob");
    // Authoritative ETag from the Blob API (same format put/ifMatch use); the content GET can lag right after a write.
    let meta: { etag: string } | null = null;
    try { meta = await head(`${app}/${key}`); } catch (e) { if (e instanceof BlobNotFoundError) return null; throw e; }
    for (let i = 0; i < 6; i++) {
      const r = await get(`${app}/${key}`, { access: "private", useCache: false });
      if (r?.stream) {
        const data = await new Response(r.stream as ReadableStream).text();
        if (normEtag(r.blob.etag) === normEtag(meta.etag) || i === 5) return { data, etag: meta.etag };
      }
      await new Promise(res => setTimeout(res, 100 * (i + 1)));
    }
    return null;
  },
  async write(key, data, etag) {
    const { put, BlobPreconditionFailedError } = await import("@vercel/blob");
    try { await put(`${app}/${key}`, data, { access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true, ...(etag ? { ifMatch: etag } : {}) }); }
    catch (e) { if (e instanceof BlobPreconditionFailedError) throw new ConflictError("store conflict"); throw e; }
  },
});

let backendOverride: Backend | null = null;
export function _setBackend(b: Backend | null) { backendOverride = b; }

export function jsonStore<T>(app: string, file: string, empty: () => T) {
  const backend = () => backendOverride ?? (process.env.BLOB_READ_WRITE_TOKEN ? blobBackend(app) : localBackend(app));
  const key = (tenant = currentTenant()) => `${tenant.replace(/[^a-zA-Z0-9_-]/g, "_")}/${file}`;
  const queues = new Map<string, Promise<unknown>>();
  const load = async (k: string) => { const r = await backend().read(k); return { d: r ? (JSON.parse(r.data) as T) : empty(), etag: r?.etag }; };
  const read = async (): Promise<T> => (await load(key())).d;
  const update = <R>(fn: (d: T) => R | Promise<R>): Promise<R> => {
    const k = key();
    const run = async (): Promise<R> => {
      for (let attempt = 0; ; attempt++) {
        const { d, etag } = await load(k);
        const out = await fn(d);
        try { await backend().write(k, JSON.stringify(d, null, 2), etag); return out; }
        catch (e) { if (!(e instanceof ConflictError) || attempt >= 4) throw e; await new Promise(r => setTimeout(r, 50 * (attempt + 1))); }
      }
    };
    const r = (queues.get(k) ?? Promise.resolve()).then(run);
    queues.set(k, r.catch(() => {}));
    return r;
  };
  return { read, update, key, path: () => key() };
}
export const newId = (pfx: string) => `${pfx}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
