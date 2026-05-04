# PromptScope

Free + paid LLM system-prompt analyzer. Paste a system prompt; get back a structured critique — anti-patterns, score, suggested rewrite.

Live: **promptscope.pages.dev** (deploying)

## What it does

Reads your LLM system prompt and returns:

- **Score (0–10)** — how production-ready it is
- **Anti-patterns** — specific issues like vague instructions, missing output schemas, persona-before-task, capability over-claims
- **Strengths** — what the prompt is doing well
- **Suggested rewrite** (Pro tier) — a structurally improved version preserving original intent

Runs on Cloudflare Workers AI. No third-party LLM provider; your prompt is not stored unless you generate a share-link.

## Pricing

| | Free | Pro |
|---|---|---|
| Analyses per day | 5 | Unlimited |
| Suggested rewrites | — | ✓ |
| API access | — | ✓ |
| Shareable permalinks | ✓ | ✓ |
| Side-by-side comparison | — | ✓ |
| Team workspace | — | ✓ |
| Price | $0 | **$19 / month** |

## Stack

- Cloudflare Pages (static frontend)
- Cloudflare Pages Functions (`functions/api/*`)
- Cloudflare Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`)
- Cloudflare KV (rate limiting, share permalinks, pro tokens)
- Stripe Checkout for Pro subscriptions
- USDC on Base as crypto fallback

## Develop

```bash
pnpm install
pnpm run dev
# visit http://localhost:8788
```

## Deploy

One-time setup:

```bash
# Create KV namespaces (records IDs to wrangler.toml)
wrangler kv namespace create RATE_KV
wrangler kv namespace create SHARE_KV
wrangler kv namespace create PROMPTSCOPE_PRO_TOKENS

# Set secrets
wrangler pages secret put STRIPE_SECRET_KEY --project-name=promptscope
wrangler pages secret put STRIPE_PRICE_ID_PRO --project-name=promptscope
wrangler pages secret put CRYPTO_PAY_ADDRESS --project-name=promptscope
```

Recurring deploy:

```bash
pnpm run deploy
```

## Self-host

PromptScope is MIT-licensed. Fork the repo, deploy to your own Cloudflare account. The whole thing runs on Cloudflare's free tier for low traffic; Workers AI has a daily free quota that covers light hobbyist use.

## License

MIT — © 2026 PromptScope contributors.
