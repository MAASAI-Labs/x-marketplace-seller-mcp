import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs"; import os from "node:os"; import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import * as S from "../src/seller.js";

let calls: { url: string; body: any; auth?: string }[] = [];
const mock = (async (url: string, init: any) => { calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
  return new Response(JSON.stringify(url.endsWith("/tweets") ? { data: { id: "1888", text: "x" } } : { data: { dm_event_id: "dm1" } }), { status: 201 }); }) as unknown as typeof fetch;
async function client(creds: Record<string, string> = {}) { const [a, b] = InMemoryTransport.createLinkedPair(); await createServer(creds, mock).connect(a); const c = new Client({ name: "t", version: "1" }); await c.connect(b); return c; }
const txt = (r: any) => r.content[0].text as string;
const json = (r: any) => JSON.parse(r.content[1].text.replace(/^```json\n|\n```$/g, ""));
const L: S.Listing = { id: "l1", title: "iPhone 13 128GB", condition: "Good", currency: "USD", ask: 400, floor: 320, ceiling: 450, quantity: 1, photos: [], payment: ["cash"], tags: [], rules: { maxRounds: 3, roundTo: 5 }, status: "posted", postText: "", createdAt: "" };
beforeEach(() => { calls = []; process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "xs-")); delete process.env.X_USER_ACCESS_TOKEN; });

describe("negotiation engine", () => {
  it("never counters or accepts below floor across many offers/rounds", () => {
    for (let r = 1; r <= 6; r++) for (let o = 50; o <= 500; o += 7) { const d = S.negotiate(L, o, r); if (d.price !== null && d.action !== "decline") expect(d.price).toBeGreaterThanOrEqual(L.floor); if (d.action === "accept") expect(o).toBeGreaterThanOrEqual(L.floor); }
  });
  it("accepts at ask, caps at ceiling", () => { expect(S.negotiate(L, 400, 1)).toMatchObject({ action: "accept", price: 400 }); expect(S.negotiate(L, 500, 1).price).toBe(450); });
  it("concedes monotonically and ends with a final offer", () => {
    const c1 = S.negotiate(L, 300, 1); const c2 = S.negotiate(L, 300, 2, c1.price!); const c3 = S.negotiate(L, 300, 3, c2.price!);
    expect(c1.action).toBe("counter"); expect(c2.price!).toBeLessThanOrEqual(c1.price!); expect(c3.action).toBe("final_offer"); expect(S.negotiate(L, 300, 4).action).toBe("final_offer");
    expect(S.negotiate(L, 330, 4).action).toBe("accept");
  });
  it("lowballs hold near ask; firm listings hold firm; auto-accept works", () => {
    expect(S.negotiate(L, 100, 1)).toMatchObject({ action: "counter", price: 400 });
    expect(S.negotiate({ ...L, rules: { firm: true } }, 390, 1).action).toBe("hold_firm");
    expect(S.negotiate({ ...L, rules: { acceptAtOrAbove: 360 } }, 365, 1).action).toBe("accept");
  });
  it("draft text never reveals the floor", () => { for (let o = 100; o < 400; o += 25) expect(S.replyText("offer", L, S.negotiate(L, o, 1))).not.toMatch(/floor|lowest I'd accept is \$320/i); });
});

describe("buyer analysis", () => {
  it("extracts offers in many formats", () => { expect(S.analyseBuyer("would you take $350?").offer).toBe(350); expect(S.analyseBuyer("I can do 300 cash today").offer).toBe(300); expect(S.analyseBuyer("offer 1.2k").offer).toBe(1200); expect(S.analyseBuyer("is it still available?").intents).toContain("availability"); });
  it("flags scams", () => { expect(S.analyseBuyer("I'll send a cashier's check, my shipping agent will pick up").scamFlags.length).toBeGreaterThanOrEqual(2); expect(S.analyseBuyer("send me the 6 digit code to verify you're real").scamFlags.length).toBeGreaterThan(0); });
  it("post text fits 280 with URL weighting", () => { const t = S.buildPostText({ ...L, location: "Lagos", tags: ["iphone", "forsale"] }); expect(S.xLength(t)).toBeLessThanOrEqual(280); expect(S.xLength("https://a.very.long.example.com/path/xyz")).toBe(23); });
  it("validates listings", () => { expect(() => S.validateListing({ ask: 100, floor: 120 })).toThrow(/Floor/); expect(() => S.validateListing({ ask: 100, floor: 50, photos: ["a", "b", "c", "d", "e"] })).toThrow(/4 images/); expect(() => S.validateListing({ ask: 100, floor: 50, photos: ["http://x/a.jpg"] })).toThrow(); });
});

describe("MCP flow: everything is a draft until approved", () => {
  it("listing → buyer replies with rounds → propose → approve(confirm) → complete → ledger", async () => {
    const c = await client();
    const r = json(await c.callTool({ name: "create_listing", arguments: { title: "iPhone 13 128GB", condition: "Good", ask: 400, floor: 320, photos: ["https://img.example.com/1.jpg"], location: "Yaba, Lagos", pickup: ["Yaba mall entrance"], payment: ["cash", "bank transfer"], rules: { maxRounds: 3, roundTo: 5 } } }));
    const id = r.listing.id;
    const d1 = await c.callTool({ name: "draft_buyer_reply", arguments: { listingId: id, buyer: "@tobi", message: "would you take $300?" } });
    expect(txt(d1)).toMatch(/needs your approval/); expect(json(d1).decision.action).toBe("counter"); expect(json(d1).rounds).toBe(1);
    const d2 = json(await c.callTool({ name: "draft_buyer_reply", arguments: { listingId: id, buyer: "@tobi", message: "ok $340 final" } }));
    expect(d2.rounds).toBe(2);
    const scam = await c.callTool({ name: "draft_buyer_reply", arguments: { listingId: id, buyer: "@x", message: "I'm overseas, my courier will collect, I'll pay with gift cards" } });
    expect(txt(scam)).toMatch(/Scam signals/);
    expect((await c.callTool({ name: "propose_deal", arguments: { listingId: id, buyer: "@tobi", price: 300 } }) as any).isError).toBe(true);
    const deal = json(await c.callTool({ name: "propose_deal", arguments: { listingId: id, buyer: "@tobi", price: 350 } })).deal;
    expect(deal.status).toBe("pending_approval");
    expect(txt(await c.callTool({ name: "approve_deal", arguments: { dealId: deal.id, action: "approve" } }))).toMatch(/Preview/);
    expect((await S.db.read()).deals[0].status).toBe("pending_approval");
    await c.callTool({ name: "approve_deal", arguments: { dealId: deal.id, action: "approve", confirm: true } });
    expect((await S.db.read()).listings[0].status).toBe("reserved");
    const h = txt(await c.callTool({ name: "draft_handoff", arguments: { listingId: id, mode: "pickup", price: 350, buyer: "@tobi", when: "Sat 2pm" } }));
    expect(h).toMatch(/Yaba mall entrance/); expect(h).toMatch(/Safety/);
    await c.callTool({ name: "approve_deal", arguments: { dealId: deal.id, action: "complete", confirm: true } });
    const led = txt(await c.callTool({ name: "deal_ledger", arguments: { status: "all" } }));
    expect(led).toMatch(/Completed revenue: \*\*\$350\*\*/); expect(led).toMatch(/12\.5%/);
    expect((await S.db.read()).listings[0].status).toBe("sold");
    expect(calls).toHaveLength(0);
  });
  it("post_listing / send_dm: preview without confirm; confirm needs the user's own token; mocked X call", async () => {
    const c0 = await client(); const id = json(await c0.callTool({ name: "create_listing", arguments: { title: "Desk lamp", condition: "Like new", ask: 25, floor: 15 } })).listing.id;
    expect(txt(await c0.callTool({ name: "post_listing", arguments: { listingId: id } }))).toMatch(/Preview: not posted/);
    const noTok: any = await c0.callTool({ name: "post_listing", arguments: { listingId: id, confirm: true } }); expect(noTok.isError).toBe(true); expect(txt(noTok)).toMatch(/own X OAuth/);
    expect(calls).toHaveLength(0);
    const c = await client({ X_USER_ACCESS_TOKEN: "user-tok" });
    expect(txt(await c.callTool({ name: "post_listing", arguments: { listingId: id, confirm: true } }))).toMatch(/1888/);
    expect(calls[0]).toMatchObject({ url: "https://api.x.com/2/tweets", auth: "Bearer user-tok" });
    expect(txt(await c.callTool({ name: "send_dm", arguments: { participantId: "12345", text: "hi" } }))).toMatch(/not sent/); expect(calls).toHaveLength(1);
    await c.callTool({ name: "send_dm", arguments: { participantId: "12345", text: "hi", confirm: true } }); expect(calls[1].url).toBe("https://api.x.com/2/dm_conversations/with/12345/messages");
  });
});
