# PromptScope

> Free + paid LLM system-prompt analyzer. Paste a system prompt; get a structured critique — anti-patterns, score, suggested rewrite.

**Live:** https://promptscope.ivixivi.workers.dev

## What it does

Reads an LLM system prompt and returns:

- **Score (0–10)** — how production-ready it is
- **Anti-patterns** — vague instructions, missing output schemas, persona-before-task, capability over-claims
- **Strengths** — what the prompt is doing well
- **Suggested rewrite** (Pro tier) — a structurally improved version preserving intent

Runs on Cloudflare Workers AI. The prompt is not stored unless a share-link is generated.

## Pricing

|                            | Free | Pro |
|----------------------------|------|-----|
| Analyses per day           | 5    | Unlimited |
| Suggested rewrites         | —    | ✓ |
| API access                 | —    | ✓ |
| Shareable permalinks       | ✓    | ✓ |
| **Price**                  | $0   | **$19 / month** |

**Checkout:** Lemon Squeezy. Pro access is unlocked by a Lemon Squeezy license key.

## Dashboard

A minimal usage/status dashboard lives at **`/dashboard`** (linked from the footer).
It shows analyses today and all-time, the Pro-vs-free split, share links, rewrites,
approximate tokens analyzed, a 14-day analyses sparkline, and operational counters
(including free-quota hits and license-check outcomes).

Metrics are best-effort counters kept in the existing `RATE_KV` namespace (keys
prefixed `m:`, separate from the `rl:` rate-limit keys) and incremented off the
response path via `ctx.waitUntil`, so they add no user-facing latency. No prompt
content is recorded — only event counts. Raw numbers are served as JSON at
**`GET /api/stats`**.

## Stack

- Cloudflare Workers (compute + assets)
- Cloudflare Workers AI — `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- Cloudflare KV — rate limiting, share permalinks, short-lived license validation cache
- Lemon Squeezy License API — Pro license validation

## Self-host

PromptScope is MIT-licensed. Fork the repo, deploy to your own Cloudflare account.
The whole thing runs on Cloudflare's free tier for low traffic; Workers AI has a
daily free quota that covers light hobbyist use.

```bash
# Create KV namespaces (record IDs to wrangler.toml)
wrangler kv namespace create RATE_KV
wrangler kv namespace create SHARE_KV
wrangler kv namespace create PROMPTSCOPE_PRO_TOKENS
```

Configure the Lemon Squeezy upgrade link:

```toml
[vars]
LEMONSQUEEZY_CHECKOUT_URL = "https://your-store.lemonsqueezy.com/buy/..."

# Optional, but recommended for production:
LEMONSQUEEZY_PRODUCT_ID = "123456"
LEMONSQUEEZY_VARIANT_ID = "123456"
```

Pro API calls use the license header:

```bash
curl https://promptscope.ivixivi.workers.dev/api/analyze \
  -H "Content-Type: application/json" \
  -H "x-promptscope-license: $LEMONSQUEEZY_LICENSE_KEY" \
  -d '{"prompt":"You are a helpful assistant."}'
```

## Auth & first-party API keys

Two independent ways to authenticate to the API:

1. **Lemon Squeezy license key** — for paying customers (`x-promptscope-license`).
2. **First-party API keys** (`psk_...`) — issued by you, the operator, for CLI
   scripts, internal services, or partners. Verified on `/api/analyze`.

API keys are administered through `/api/keys`, which is gated by a single
secret, `ADMIN_TOKEN`. Configure it once:

```bash
# Production — stored encrypted by Cloudflare, never in the repo:
wrangler secret put ADMIN_TOKEN

# Local dev — copy the template and fill it in (.dev.vars is gitignored):
cp .dev.vars.example .dev.vars
```

If `ADMIN_TOKEN` is unset, `/api/keys` returns `503` and no keys can be issued —
the rest of the app keeps working.

**Issue a key** (returns the plaintext `psk_...` exactly once — store it now):

```bash
curl -X POST https://promptscope.ivixivi.workers.dev/api/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"ci-pipeline","plan":"pro"}'
# -> {"api_key":"psk_...","id":"<id>","plan":"pro","createdAt":"..."}
```

`plan` is `pro` (unlimited + suggested rewrites) or `free` (5 analyses/day, metered
per key instead of per IP); it defaults to `pro`.

**List keys** (metadata only — the plaintext key is never recoverable) and
**revoke** by id:

```bash
curl https://promptscope.ivixivi.workers.dev/api/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl -X DELETE https://promptscope.ivixivi.workers.dev/api/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"<key id>"}'
```

**Call the API with an issued key** — either header form works:

```bash
curl https://promptscope.ivixivi.workers.dev/api/analyze \
  -H "Content-Type: application/json" \
  -H "x-promptscope-api-key: $PROMPTSCOPE_API_KEY" \
  -d '{"prompt":"You are a helpful assistant."}'
# or: -H "Authorization: Bearer $PROMPTSCOPE_API_KEY"
```

Keys are stored only as SHA-256 hashes in the `PROMPTSCOPE_PRO_TOKENS` KV
namespace; the plaintext never touches storage or logs. A revoked key fails
verification immediately and the caller falls back to the anonymous free tier.

Run the auth smoke test (no external deps, needs Node ≥ 23):

```bash
npm test
```

Deploy:

```bash
wrangler deploy
```

## Sister products

PromptScope is part of an intelligence portfolio:

- [EdgarFlash](https://edgarflash.ivixivi.workers.dev) — Real-time SEC EDGAR alerts
- [WriteLens](https://writelens.ivixivi.workers.dev) — Pay-per-call text quality scoring
- [BountyScope](https://bountyscope.ivixivi.workers.dev) — Bug-bounty intel + smart-contract analyzer
- [TrendPulse](https://trendpulse.ivixivi.workers.dev) — Daily emerging-tech digest
- [VulnPulse](https://vulnpulse.ivixivi.workers.dev) — Defender-side CVE feed

## License

MIT — see [LICENSE](./LICENSE).
