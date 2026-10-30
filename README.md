# X Marketplace Seller MCP

**Live MCP URL (Streamable HTTP):** `https://x-marketplace-seller-mcp.vercel.app/mcp`  
Health check: `https://x-marketplace-seller-mcp.vercel.app/health`

A selling assistant for X (Twitter). It covers:

- Drafting listing posts (text, pricing, photos list).
- Drafting buyer replies, with scam-pattern detection.
- A **negotiation engine** that stays within your private floor and ceiling.
- Pickup and delivery arrangement drafts.
- A **deal ledger**.

> **Human approval by design.** Every reply, post, DM and deal acceptance is returned as a **draft**. A deal only becomes "agreed" through `approve_deal` with `confirm: true`. Posting and DMs are optional. They need `confirm: true` **and** the end user's own X OAuth 2.0 user token; without a token the tools only draft. Buyer messages are treated as untrusted data.

## Use in Cursor

**From the Cursor Marketplace:** once listed, install it from https://cursor.com/marketplace (publisher MAASAI Labs). The plugin manifest lives in https://github.com/MAASAI-Labs/cursor-plugins.

1. Search the Marketplace for this plugin and click **Install**.
2. Check the server is enabled under Cursor Settings, then MCP. Plugin servers show with a `plugin-` prefix.
3. Optional: to post listings or send DMs, open **Plugins**, then **Configure** on this plugin, and set X_USER_ACCESS_TOKEN. They are sent to the server as request headers and are never stored.

**Manually:** add the hosted server to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "x-marketplace-seller": {
      "url": "https://x-marketplace-seller-mcp.vercel.app/mcp",
      "headers": { "x-x-user-access-token": "YOUR_X_USER_TOKEN" }
    }
  }
}
```

Leave out `headers` to use only the tools that need no credentials.

## Tools
| Tool | What it does | External effect |
|---|---|---|
| `create_listing` | Item, condition, ask, private **floor**, **ceiling**, ≤4 photo URLs/paths, pickup/delivery, payment and rules. Drafts a post of ≤280 chars, with URLs counted as 23 | None (local ledger) |
| `list_listings` / `update_listing` | Manage listings. Changing price or rules re-drafts the post | None |
| `draft_buyer_reply` | Detects intent (availability, offer, condition, logistics, hold, payment), extracts the offer (e.g. "$350", "1.2k", "₦375k"), flags scams, runs the negotiation engine per buyer thread and drafts a reply | None (draft) |
| `negotiate_offer` | What-if test of an offer without recording anything | None |
| `draft_handoff` | Pickup or delivery confirmation message with safety tips. Refuses prices below the floor | None (draft) |
| `propose_deal` | Records a deal as **pending approval**. Refuses prices below the floor | None |
| `approve_deal` | `approve` / `complete` / `cancel`. Previews unless `confirm: true`. Updates the listing (reserved, sold or re-opened) | None (local) |
| `deal_ledger` | Completed revenue, agreed value, pending approvals, average discount from ask | None |
| `post_listing` | Posts the text to X via `POST /2/tweets` | **Only with `confirm: true` + `X_USER_ACCESS_TOKEN`** |
| `send_dm` | Sends an approved reply via `POST /2/dm_conversations/with/:id/messages` | **Only with `confirm: true` + token** |

### Negotiation rules (per listing)
| Rule | Meaning |
|---|---|
| `firm` | No negotiation |
| `maxRounds` | Default 3 |
| `roundTo` | Price step |
| `acceptAtOrAbove` | Auto-accept level. Still only produces a draft and a pending deal |
| `lowballPct` | Offers below this share of the floor (default 60%) are treated as lowballs, and the counter stays near ask |
| `holdHours` / `noHolds` | Whether and how long items can be held |
| `cashOnly` | Cash at pickup only |

How the engine behaves:
- It concedes from ask toward the floor over the rounds, and never counters higher than its last counter.
- It **never goes below the floor** and **never reveals the floor** in drafted text.
- Offers above the ceiling are accepted at the ceiling.
- When the rounds run out, it gives a final offer at or above the floor.

## Example prompts
- "List my PS5 Slim for ₦450k, lowest ₦380k, pickup at Lekki Phase 1 mall or Lagos Island delivery for ₦5k."
- "A buyer @ada says 'would you take ₦350,000?' Draft my reply."
- "Is this message a scam? 'I'm abroad, my shipping agent will collect…'"
- "Ada agreed ₦385k. Record the deal, and once I approve it, draft the delivery confirmation."
- "Show my deal ledger."

## Run locally
```bash
npm install && npm run build
npm start               # http://localhost:3000/mcp
npm run start:stdio
npm test                # 11 tests; X API is mocked
npm run smoke           # full selling flow over HTTP; no token, nothing posted
```

Locally, data lives in `DATA_DIR`, default `~/.x-marketplace-seller-mcp/<tenant>/ledger.json` (`<tenant>` is `local` over stdio; over HTTP it is a hash of the caller's credentials, or `public-demo` for callers who send none).

Posting is optional. To enable it, set `X_USER_ACCESS_TOKEN` (env, or the `x-x-user-access-token` header in hosted mode). It must be your own OAuth 2.0 user-context token with `tweet.write` (and `dm.write` for DMs). X API usage is billed by X under your own developer account.

## Deploy to Vercel
1. Import the repo. The `/mcp` endpoint is preconfigured.
2. The ledger is stored per user. Set `BLOB_READ_WRITE_TOKEN` to keep it in a private Vercel Blob store (the hosted server does this). Without it, the server falls back to JSON files under `DATA_DIR`, which on Vercel means `/tmp` and is lost when the instance recycles. Each request is mapped to a tenant from a SHA-256 hash of the caller's `x-user-key` header or X token, so users never see each other's ledgers. Callers who send neither share one `public-demo` ledger, so don't put real deals there. See Storage and tenant isolation below.
3. Don't set a shared X token. Users send their own as a header.

## Marketplace reviewer test
1. `npm install && npm run build && npm test`: 11 pass. These include a property test that no accept or counter is ever below the floor across 6 rounds × 65 offers, plus approval gating and mocked X calls.
2. `npm run smoke`: "all ok". It walks the whole flow: create a listing, run four buyer messages through negotiation, catch a scam, propose, preview, approve, draft a handoff, check the ledger, preview a post, and refuse to post without a token.

## Limitations
- Photos aren't uploaded to X. The tool lists them for you to attach; media upload is a future addition.
- Offer extraction is pattern-based. Unusual phrasing may be missed, and the assistant should double-check.
- There's no X DM inbox reading. Paste buyer messages in.

MIT License © 2026 Segun Cole


## Storage and tenant isolation

- **Hosted:** data is kept in a private **Vercel Blob** store (free Hobby quota) when `BLOB_READ_WRITE_TOKEN` is set, at `<app>/<tenant>/<file>.json`, with ETag-based optimistic concurrency.
- **Tenant key:** a one-way SHA-256 hash of the caller's own credential headers, or of an `x-user-key` header if you send one (recommended if your token rotates). Secrets are never stored and tenants can't see each other's data. Callers with no credentials and no `x-user-key` share a `public-demo` space, so don't put real data there.
- **Local / self-hosted:** without a Blob token it falls back to JSON files under `DATA_DIR` (default `~/.x-marketplace-seller-mcp/<tenant>/`).

## Privacy and terms

- Privacy policy: https://maasai.tech/privacy
- Terms of use: https://maasai.tech/terms
- Support and data requests: colepresley000@gmail.com
