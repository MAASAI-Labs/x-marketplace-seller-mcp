import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
/** Tiny JSON-file store. Local: ~/.<app>/ (override with DATA_DIR). On serverless, /tmp is ephemeral: point DATA_DIR at durable storage. */
export function jsonStore<T>(app: string, file: string, empty: () => T) {
  const p = () => path.join(process.env.DATA_DIR || (process.env.VERCEL ? `/tmp/${app}` : path.join(os.homedir(), `.${app}`)), file);
  let q: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<T> => { try { return JSON.parse(await fs.readFile(p(), "utf8")) as T; } catch { return empty(); } };
  const update = <R>(fn: (d: T) => R | Promise<R>): Promise<R> => { const r = q.then(async () => { const d = await read(); const out = await fn(d); await fs.mkdir(path.dirname(p()), { recursive: true }); await fs.writeFile(p(), JSON.stringify(d, null, 2)); return out; }); q = r.catch(() => {}); return r; };
  return { read, update, path: p };
}
export const newId = (pfx: string) => `${pfx}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
