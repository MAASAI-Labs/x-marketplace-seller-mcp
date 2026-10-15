import { describe, it, expect, afterEach } from "vitest";
import { jsonStore, withTenant, tenantId, _setBackend, ConflictError, DEMO_TENANT, type Backend } from "../src/store.js";

function memBackend(conflicts = 0): Backend & { files: Map<string, string>; writes: number } {
  const files = new Map<string, string>(); let v = 0; let left = conflicts;
  const etags = new Map<string, string>();
  return { files, writes: 0,
    async read(k) { const d = files.get(k); return d === undefined ? null : { data: d, etag: etags.get(k) }; },
    async write(k, d, etag) { this.writes++; if (left > 0) { left--; throw new ConflictError("x"); } if (etags.has(k) && etag !== etags.get(k)) throw new ConflictError("stale"); files.set(k, d); etags.set(k, String(++v)); } };
}
afterEach(() => _setBackend(null));

describe("tenant-isolated store", () => {
  it("hashes credentials into an opaque tenant id and never embeds secrets", () => {
    const a = tenantId({ TOKEN: "secret-abc" });
    expect(a).toMatch(/^t_[0-9a-f]{32}$/);
    expect(a).not.toContain("secret");
    expect(tenantId({ TOKEN: "secret-abc" })).toBe(a);
    expect(tenantId({ TOKEN: "other" })).not.toBe(a);
    expect(tenantId({ TOKEN: undefined })).toBe(DEMO_TENANT);
  });
  it("keeps each tenant's data separate", async () => {
    const mem = memBackend(); _setBackend(mem);
    const s = jsonStore<{ items: string[] }>("app", "data.json", () => ({ items: [] }));
    await withTenant("t_alice", () => s.update(d => { d.items.push("alice-item"); }));
    await withTenant("t_bob", () => s.update(d => { d.items.push("bob-item"); }));
    expect(await withTenant("t_alice", () => s.read())).toEqual({ items: ["alice-item"] });
    expect(await withTenant("t_bob", () => s.read())).toEqual({ items: ["bob-item"] });
    expect([...mem.files.keys()].sort()).toEqual(["t_alice/data.json", "t_bob/data.json"]);
  });
  it("retries on a concurrent-write conflict without losing updates", async () => {
    const mem = memBackend(2); _setBackend(mem);
    const s = jsonStore<{ n: number }>("app", "c.json", () => ({ n: 0 }));
    await withTenant("t_x", () => Promise.all([s.update(d => { d.n++; }), s.update(d => { d.n++; })]));
    expect(await withTenant("t_x", () => s.read())).toEqual({ n: 2 });
  });
});
