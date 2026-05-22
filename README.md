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
| Side-by-side comparison    | —    | ✓ |
| Team workspace             | —    | ✓ |
| **Price**                  | $0   | **$19 / month** |

**Pay any rail:** GitHub Sponsors, crypto, BMC, latent Stripe.

## Stack

- Cloudflare Workers (compute + assets)
- Cloudflare Workers AI — `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- Cloudflare KV — rate limiting, share permalinks, pro authValues
- Stripe Checkout (latent) for Pro subscriptions
- USDC for crypto fallback

## Self-host

PromptScope is MIT-licensed. Fork the repo, deploy to your own Cloudflare account.
The whole thing runs on Cloudflare's free tier for low traffic; Workers AI has a
daily free quota that covers light hobbyist use.

```bash
# Create KV namespaces (record IDs to wrangler.toml)
wrangler kv namespace create RATE_KV
wrangler kv namespace create SHARE_KV
wrangler kv namespace create PROMPTSCOPE_PRO_TOKENS

# Deploy
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
