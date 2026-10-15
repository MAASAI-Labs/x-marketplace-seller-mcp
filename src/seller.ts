import { jsonStore, newId } from "./store.js";

export interface Rules { firm?: boolean; maxRounds?: number; roundTo?: number; acceptAtOrAbove?: number; lowballPct?: number; holdHours?: number; noHolds?: boolean; cashOnly?: boolean }
export interface Listing { id: string; title: string; description?: string; condition: string; category?: string; currency: string; ask: number; floor: number; ceiling: number; quantity: number; photos: string[]; location?: string; pickup?: string[]; delivery?: { available: boolean; fee?: number; areas?: string }; payment: string[]; tags: string[]; rules: Rules; status: "draft" | "posted" | "reserved" | "sold" | "withdrawn"; postText: string; postedId?: string; createdAt: string }
export interface Thread { key: string; listingId: string; buyer: string; rounds: number; lastCounter?: number; lastOffer?: number; history: { at: string; who: "buyer" | "seller"; amount?: number; text: string }[] }
export interface Deal { id: string; listingId: string; buyer: string; price: number; currency: string; quantity: number; handoff?: string; status: "pending_approval" | "agreed" | "completed" | "cancelled"; createdAt: string; approvedAt?: string; completedAt?: string; notes?: string }
export interface Db { listings: Listing[]; threads: Thread[]; deals: Deal[] }
export const db = jsonStore<Db>("x-marketplace-seller-mcp", "ledger.json", () => ({ listings: [], threads: [], deals: [] }));

const money = (n: number, c: string) => `${({ USD: "$", GBP: "£", EUR: "€", NGN: "₦" } as Record<string, string>)[c] ?? c + " "}${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
export { money };
/** X counts URLs as 23 chars; emoji/CJK weigh 2. Approximation of twitter-text weighting. */
export function xLength(t: string) { let n = 0; const s = t.replace(/https?:\/\/\S+/g, "x".repeat(23)); for (const ch of s) n += /[\u1100-\uFFFF\u{10000}-\u{10FFFF}]/u.test(ch) && !/[\u2000-\u206F]/.test(ch) ? 2 : 1; return n; }

export function buildPostText(l: Pick<Listing, "title" | "condition" | "currency" | "ask" | "location" | "pickup" | "delivery" | "tags" | "quantity">, style: "short" | "detailed" = "short", highlights: string[] = []) {
  const parts = [`For sale: ${l.title}`, `${money(l.ask, l.currency)}${l.quantity > 1 ? ` each (${l.quantity} available)` : ""} · ${l.condition}`];
  if (style === "detailed" && highlights.length) parts.push(highlights.map(h => `• ${h}`).join("\n"));
  const where = [l.location && `📍 ${l.location}`, l.pickup?.length && "pickup", l.delivery?.available && `delivery${l.delivery.fee ? ` (+${money(l.delivery.fee, l.currency)})` : ""}`].filter(Boolean).join(" · ");
  if (where) parts.push(where);
  parts.push("DM if interested.");
  let text = parts.join("\n");
  const tags = l.tags.map(t => "#" + t.replace(/[^\p{L}\p{N}_]/gu, "")).filter(t => t.length > 1).join(" ");
  if (tags && xLength(text + "\n" + tags) <= 280) text += "\n" + tags;
  while (xLength(text) > 280 && style === "detailed") return buildPostText(l, "short");
  return text;
}

export function validateListing(a: { ask: number; floor: number; ceiling?: number; photos?: string[] }) {
  const ceiling = a.ceiling ?? a.ask;
  if (a.floor <= 0 || a.ask <= 0) throw new Error("Prices must be positive.");
  if (a.floor > a.ask) throw new Error("Floor (lowest you'll accept) can't be above the asking price.");
  if (ceiling < a.ask) throw new Error("Ceiling can't be below the asking price.");
  if ((a.photos?.length ?? 0) > 4) throw new Error("X allows at most 4 images per post.");
  for (const p of a.photos ?? []) if (!/^(https:\/\/|\/|\.\/|~\/|[A-Za-z]:\\)/.test(p) || !/\.(jpe?g|png|webp|gif)(\?.*)?$/i.test(p)) throw new Error(`Photo "${p}" must be an https URL or file path ending in .jpg/.png/.webp/.gif.`);
  return ceiling;
}

// ---------- Buyer message analysis ----------
const SCAM: [RegExp, string][] = [
  [/(verification|verify|confirm(ation)?)\s*code|google voice|6[- ]?digit code/i, "Asks for a verification code (account-takeover scam)."],
  [/cashier'?s? check|money order|certified check|western union|moneygram|wire transfer/i, "Unusual payment method commonly used in fraud."],
  [/(over ?pay|send (you )?more|refund the (rest|difference)|extra (money|amount))/i, "Overpayment / refund-the-difference pattern."],
  [/shipping (agent|company) will|my (mover|agent|courier) will (pick|collect)|i'?m (out of (the )?(country|town)|overseas|on a ship|deployed)/i, "Remote buyer with third-party pickup (common scam)."],
  [/(gift ?cards?|itunes|steam card|crypto|bitcoin|usdt)/i, "Gift card / crypto payment request."],
  [/(whatsapp|telegram|text me at|email me at|contact me on)/i, "Wants to move off-platform immediately."],
  [/(click|open) (this|the) link|bit\.ly|tinyurl|paypal.*(invoice|link)/i, "Asks you to open a payment/verification link."],
];
export function analyseBuyer(text: string, l?: Listing) {
  const t = text.toLowerCase();
  const amounts = [...text.matchAll(/(?:[$£€₦]\s?(\d[\d,]*(?:\.\d+)?)\s*(k)?|(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:usd|dollars|bucks|naira|gbp|eur|pounds|euros|ngn)\b|(?:offer|do|pay|give( you)?|for|take|at)\s+(\d[\d,]*(?:\.\d+)?)\s*(k)?\b)/gi)]
    .map(m => { const raw = m[1] ?? m[3] ?? m[6]; const k = m[2] ?? m[4] ?? m[7]; return Number(raw.replace(/,/g, "")) * (k ? 1000 : 1); }).filter(n => n > 0);
  const intents: string[] = [];
  if (/still (available|for sale|have)|is (this|it) available|available\?/i.test(t)) intents.push("availability");
  if (amounts.length || /offer|would you (take|do|accept)|lowest|best price|negotiable|discount|cheaper/i.test(t)) intents.push(amounts.length ? "offer" : "price_question");
  if (/condition|scratch|damage|work(s|ing)|battery|original|receipt|warranty|defect/i.test(t)) intents.push("condition");
  if (/pick ?up|collect|meet|where are you|location|deliver|ship|post(age)?/i.test(t)) intents.push("logistics");
  if (/hold|reserve|save it|keep it for/i.test(t)) intents.push("hold_request");
  if (/pay|payment|transfer|cash|card|venmo|zelle|paypal|bank/i.test(t)) intents.push("payment");
  const flags = SCAM.filter(([re]) => re.test(text)).map(([, why]) => why);
  return { intents: intents.length ? intents : ["general"], offer: amounts.length ? amounts[amounts.length - 1] : null, scamFlags: flags, listingTitle: l?.title };
}

// ---------- Negotiation engine ----------
export type Decision = { action: "accept" | "counter" | "final_offer" | "decline" | "hold_firm"; price: number | null; reason: string };
const roundUp = (n: number, step: number) => Math.ceil(n / step) * step;
/** Never below floor, never reveals floor, concedes linearly from ask toward floor over maxRounds. */
export function negotiate(l: Listing, offer: number, round: number, lastCounter?: number, qty = 1): Decision {
  const r = l.rules; const step = r.roundTo ?? (l.ask >= 1000 ? 10 : l.ask >= 100 ? 5 : 1); const maxRounds = r.maxRounds ?? 3;
  const ask = l.ask, floor = l.floor;
  if (!(offer > 0)) return { action: "decline", price: null, reason: "No valid amount in the offer." };
  if (offer >= ask) return { action: "accept", price: Math.min(offer, l.ceiling), reason: offer > l.ceiling ? `Offer above your ceiling: accept at ceiling ${l.ceiling}, don't overcharge.` : "Offer meets the asking price." };
  if (r.firm) return { action: "hold_firm", price: ask, reason: "Listing is marked firm (no negotiation)." };
  if (r.acceptAtOrAbove && offer >= r.acceptAtOrAbove) return { action: "accept", price: offer, reason: `Offer is at/above your auto-accept level (${r.acceptAtOrAbove}).` };
  const lowball = offer < floor * (r.lowballPct ?? 0.6);
  // our target for this round
  const target = Math.max(floor, roundUp(ask - (ask - floor) * Math.min(1, round / (maxRounds + 1)), step));
  if (offer >= target && offer >= floor) return { action: "accept", price: offer, reason: `Offer ≥ this round's target (${target}) and ≥ floor.` };
  if (round > maxRounds) return offer >= floor ? { action: "accept", price: offer, reason: "Rounds exhausted, offer is above floor." } : { action: "final_offer", price: Math.max(floor, roundUp(floor, step)), reason: "Rounds exhausted: final offer at your floor (not disclosed as floor)." };
  let counter = Math.max(target, roundUp(offer + (ask - offer) * 0.5, step), floor);
  if (lastCounter) counter = Math.min(counter, lastCounter); // never go back up
  if (counter <= offer) return { action: "accept", price: offer, reason: "Offer is at/above what we'd counter with." };
  if (lowball && round === 1) return { action: "counter", price: Math.min(ask, lastCounter ?? ask), reason: `Lowball (< ${Math.round((r.lowballPct ?? 0.6) * 100)}% of floor): hold near asking.` };
  return { action: round === maxRounds ? "final_offer" : "counter", price: counter, reason: `Round ${round}/${maxRounds}: concede toward floor without going below it.` };
}

export function replyText(kind: string, l: Listing, d?: Decision, extra: { buyer?: string; tone?: "friendly" | "brief" } = {}) {
  const hi = extra.buyer ? `Hi ${extra.buyer.replace(/^@/, "")}, ` : "Hi, ";
  const p = (n: number) => money(n, l.currency);
  switch (kind) {
    case "availability": return `${hi}yes, the ${l.title} is still available (${p(l.ask)}).${l.location ? ` I'm in ${l.location}.` : ""} When would you like to see it?`;
    case "condition": return `${hi}it's in ${l.condition} condition.${l.description ? ` ${l.description.slice(0, 160)}` : ""} Happy to send more photos or show it working at pickup.`;
    case "logistics": return `${hi}${l.pickup?.length ? `pickup is at ${l.pickup.join(" or ")}` : "pickup is in a public place we agree on"}${l.delivery?.available ? `; delivery is possible${l.delivery.areas ? ` within ${l.delivery.areas}` : ""}${l.delivery.fee ? ` for ${p(l.delivery.fee)}` : ""}` : ""}. What works for you?`;
    case "hold_request": return l.rules.noHolds ? `${hi}sorry, I can't hold items. It's first come, first served on pickup/payment.` : `${hi}I can hold it for ${l.rules.holdHours ?? 24} hours once we agree a time. After that it goes to the next buyer.`;
    case "payment": return `${hi}I accept ${l.payment.join(", ")}${l.rules.cashOnly ? " (cash only, at pickup)" : ""}. Payment at handover, please.`;
    case "price_question": return l.rules.firm ? `${hi}the price is firm at ${p(l.ask)}.` : `${hi}it's ${p(l.ask)}. I'm open to reasonable offers. What did you have in mind?`;
    case "scam": return `${hi}thanks, but I only do local pickup/agreed delivery with payment at handover through ${l.payment.join(" or ")}. I don't share codes, use links or accept overpayments.`;
  }
  if (!d) return `${hi}thanks for your message about the ${l.title}.`;
  switch (d.action) {
    case "accept": return `${hi}${p(d.price!)} works for me. Let's arrange ${l.pickup?.length || l.delivery?.available ? "pickup/delivery" : "a handover"}. When suits you?`;
    case "counter": return `${hi}thanks for the offer. I can't go that low, but I could do ${p(d.price!)}.`;
    case "final_offer": return `${hi}the lowest I can go is ${p(d.price!)}. That's my final price.`;
    case "hold_firm": return `${hi}thanks, but the price is firm at ${p(l.ask)}.`;
    default: return `${hi}thanks, but I'll have to pass on that offer.`;
  }
}

export function handoffText(l: Listing, a: { mode: "pickup" | "delivery"; buyer?: string; when?: string; place?: string; price: number; fee?: number }) {
  const hi = a.buyer ? `Hi ${a.buyer.replace(/^@/, "")}, ` : "Hi, ";
  const total = a.price + (a.mode === "delivery" ? a.fee ?? l.delivery?.fee ?? 0 : 0);
  const pay = l.payment.join(" or ");
  const lines = a.mode === "pickup"
    ? [`${hi}confirming pickup of the ${l.title} for ${money(a.price, l.currency)}.`, `📍 ${a.place ?? l.pickup?.[0] ?? "a busy public place (e.g. a mall entrance or police-station safe-exchange zone)"}`, `🕒 ${a.when ?? "[time to agree]"}`, `💳 Payment at handover: ${pay}.`, "Feel free to check it over before paying. Please message if you're running late."]
    : [`${hi}confirming delivery of the ${l.title}.`, `Item: ${money(a.price, l.currency)} + delivery ${money(total - a.price, l.currency)} = ${money(total, l.currency)}`, `📦 Address: [buyer to confirm]`, `🕒 ${a.when ?? "[delivery window to agree]"}`, `💳 Payment: ${pay}, on delivery or before dispatch as agreed.`];
  const safety = ["Meet in a well-lit public place; bring someone if you can.", "Don't hand over the item before payment clears; don't accept overpayments or share codes.", ...(a.mode === "delivery" ? ["Use tracked delivery and keep proof of dispatch."] : [])];
  return { text: lines.join("\n"), total, safety };
}
export const newDealId = () => newId("deal");
export const newListingId = () => newId("lst");
