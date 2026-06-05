/**
 * PromptScope — Cloudflare Worker (replaces Pages Functions setup)
 *
 * Single Worker handles:
 *   - Static assets (public/) via ASSETS binding
 *   - /api/analyze, /api/share, /api/checkout, /api/payment-info
 */

interface Env {
  AI: any;
  ASSETS: Fetcher;
  RATE_KV: KVNamespace;
  SHARE_KV: KVNamespace;
  PROMPTSCOPE_PRO_TOKENS: KVNamespace;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_ID_PRO?: string;
  PROMPTSCOPE_BASE_URL?: string;
  CRYPTO_PAY_ADDRESS?: string;
  CRYPTO_CHAIN?: string;
  // Shared fleet money rail. PAYRAIL is a service binding (preferred — a direct
  // internal worker→worker call that skips the public edge, so it dodges both the
  // *.workers.dev same-zone restriction and edge bot-management). PAYRAIL_URL is the
  // public-hostname fallback (used when the binding is absent, e.g. local/standby).
  // SHIP_HMAC_SECRET (a wrangler secret, unset by default) signs receipt writes.
  PAYRAIL?: Fetcher;
  PAYRAIL_URL?: string;
  SHIP_HMAC_SECRET?: string;
}

const FREE_DAILY_LIMIT = 5;
const MAX_PROMPT_CHARS = 32_000;
const SHARE_TTL_SECONDS = 60 * 60 * 24 * 30;

// === payrail (shared fleet money rail) ===
// promptscope plugs into the live payrail Worker instead of re-implementing
// "wallet unset / no checkout". payrail returns where to send money + a memo
// (quote_id); the buyer pays on-chain, then /api/confirm records the receipt.
const PAYRAIL_DEFAULT = 'https://payrail.ivixivi.workers.dev';
const PRO_PRICE = '19';
const PENDING_TTL_SECONDS = 604800; // 7 days

interface PayrailQuote {
  quote_id: string;
  pay_to: { rail: string; chain: string; asset: string; address: string; amount: string } | null;
  checkout: string | null;
  instructions: string;
  expires_in_seconds: number;
}

// Single egress point to payrail. Prefers the service binding (an internal
// worker→worker call that never touches the public edge → immune to both the
// *.workers.dev same-zone restriction and edge bot-management). Falls back to the
// public hostname with a browser UA so even the fallback clears bot filters. When
// the binding is used the host in the URL is ignored — only path/query/method/body.
function payrailFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  if (env.PAYRAIL) return env.PAYRAIL.fetch(new Request(`https://payrail${path}`, init));
  const base = env.PAYRAIL_URL ?? PAYRAIL_DEFAULT;
  const headers = new Headers(init?.headers);
  if (!headers.has('user-agent')) {
    headers.set('user-agent', 'Mozilla/5.0 (compatible; promptscope/1.0; +https://promptscope.ivixivi.workers.dev)');
  }
  return fetch(base + path, { ...init, headers });
}

async function payrailQuote(env: Env): Promise<PayrailQuote> {
  const qs = new URLSearchParams({
    ship: 'promptscope',
    sku: 'promptscope:pro',
    amount: PRO_PRICE,
    currency: 'USDC',
  });
  const r = await payrailFetch(env, `/pay?${qs.toString()}`);
  if (!r.ok) throw new Error(`payrail /pay ${r.status}`);
  return r.json();
}

// HMAC-SHA256 hex, byte-identical to payrail's hmac() so timingSafeEqual passes.
// Only used when SHIP_HMAC_SECRET is set (payrail has none today → optional).
async function hmacHex(secret: string, message: string): Promise<string> { // allow-secret (param name, not a value)
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const SYSTEM_PROMPT = `You are PromptScope, an expert in LLM system-prompt design.

You analyze a system prompt and return JSON with this exact shape:
{
  "score": <number 0..10>,
  "anti_patterns": [{"name": "<short label>", "fix": "<one-sentence fix>"}, ...],
  "strengths": ["<short string>", ...]
}

Look for these anti-patterns:
- Vague instructions ("be helpful", "use good judgment")
- Role/persona contradictions
- Missing output format / schema
- Persona declared before task (slows model)
- Walls of text without structure
- Capability over-claims ("you can do anything")
- Missing examples (when task is non-obvious)
- Missing explicit constraints / refusal cases
- Ambiguous tool-use assumptions
- Excessive boilerplate
- Conflicting instructions

Strengths to credit:
- Clear role and task definition
- Explicit output schema
- Few-shot examples present
- Boundary cases named
- Concise, structured prose
- Tool use guidance is specific

Score guideline: 0=incoherent, 5=passable, 7=production-ready, 9=excellent, 10=exemplary.
Return ONLY valid JSON, no markdown, no preamble.`;

function approxTokens(s: string): number { return Math.ceil(s.length / 4); }

function tryParseJson(s: unknown): any | null {
  if (s == null) return null;
  // Workers AI may return objects directly when response_format is JSON.
  if (typeof s === 'object') return s;
  const str = typeof s === 'string' ? s : String(s);
  const cleaned = str.replace(/^```json\s*|\s*```$/g, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

async function rateCheck(ip: string, env: Env): Promise<{ allowed: boolean; remaining: number }> {
  const key = `rl:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const current = Number(await env.RATE_KV.get(key) ?? 0);
  if (current >= FREE_DAILY_LIMIT) return { allowed: false, remaining: 0 };
  await env.RATE_KV.put(key, String(current + 1), { expirationTtl: 60 * 60 * 26 });
  return { allowed: true, remaining: FREE_DAILY_LIMIT - current - 1 };
}

async function isProAuth(value: string | undefined, env: Env): Promise<boolean> {
  if (!value) return false;
  return (await env.PROMPTSCOPE_PRO_TOKENS.get(value)) === 'active';
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function handleAnalyze(req: Request, env: Env): Promise<Response> {
  if (req.method === 'GET') {
    return Response.json({
      description: 'PromptScope analyze API',
      method: 'POST /api/analyze',
      body: { prompt: 'string up to 32k chars' },
      auth_header_optional: 'x-promptscope-key',  // value: pro membership key
      free_limit: '5 / IP / day',
    });
  }
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }

  const prompt = String(body?.prompt ?? '');
  if (!prompt) return Response.json({ error: 'missing prompt' }, { status: 400 });
  if (prompt.length > MAX_PROMPT_CHARS) {
    return Response.json({ error: `prompt exceeds ${MAX_PROMPT_CHARS} chars` }, { status: 400 });
  }

  const proAuth = req.headers.get('x-promptscope-token') ?? undefined;
  const isPro = await isProAuth(proAuth, env);

  let remaining: number | undefined;
  if (!isPro) {
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const rl = await rateCheck(ip, env);
    if (!rl.allowed) {
      return Response.json({ error: 'daily free quota exhausted; upgrade to Pro for unlimited' }, { status: 429 });
    }
    remaining = rl.remaining;
  }

  let aiResp: any;
  try {
    aiResp = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Analyze this system prompt:\n\n---\n${prompt}\n---` },
      ],
      max_tokens: 1500,
    });
  } catch (err) {
    return Response.json({ error: `inference failed: ${(err as Error).message}` }, { status: 500 });
  }

  const raw = aiResp?.response ?? aiResp?.result ?? aiResp ?? '';
  const parsed = tryParseJson(raw);
  if (!parsed || typeof parsed.score !== 'number') {
    return Response.json({
      error: 'analysis output malformed',
      raw_type: typeof raw,
      raw_preview: typeof raw === 'string' ? raw.slice(0, 500) : JSON.stringify(raw).slice(0, 500),
    }, { status: 502 });
  }

  let suggested_rewrite: string | undefined;
  if (isPro) {
    try {
      const rewriteResp = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          { role: 'system', content: 'You are an expert prompt engineer. Rewrite the user-provided system prompt to remove anti-patterns, improve structure, and tighten language. Preserve all original intent. Return ONLY the rewritten prompt.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 1500,
      });
      suggested_rewrite = String(rewriteResp?.response ?? rewriteResp?.result ?? '').trim();
    } catch {}
  }

  return Response.json({
    score: Math.max(0, Math.min(10, parsed.score)),
    token_count: approxTokens(prompt),
    char_count: prompt.length,
    anti_patterns: Array.isArray(parsed.anti_patterns) ? parsed.anti_patterns.slice(0, 12) : [],
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 8) : [],
    ...(suggested_rewrite && { suggested_rewrite }),
    ...(remaining !== undefined && { quota_remaining: remaining }),
  });
}

async function handleShare(req: Request, env: Env): Promise<Response> {
  if (req.method === 'POST') {
    let body: any;
    try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
    const prompt = String(body?.prompt ?? '');
    if (!prompt) return Response.json({ error: 'missing prompt' }, { status: 400 });
    if (prompt.length > MAX_PROMPT_CHARS) return Response.json({ error: 'prompt too long' }, { status: 400 });
    const id = newId();
    await env.SHARE_KV.put(id, prompt, { expirationTtl: SHARE_TTL_SECONDS });
    return Response.json({ id, expires_in_seconds: SHARE_TTL_SECONDS });
  }
  if (req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('id');
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return Response.json({ error: 'invalid id' }, { status: 400 });
    const prompt = await env.SHARE_KV.get(id);
    if (!prompt) return Response.json({ error: 'not found or expired' }, { status: 404 });
    return Response.json({ id, prompt });
  }
  return new Response('method not allowed', { status: 405 });
}

// Buy route. Gets a live quote from the shared payrail rail and returns a 402
// carrying the on-chain address + memo (quote_id). The buyer pays, then POSTs
// the tx hash to /api/confirm to mint a Pro token. No more "wired-but-unset" 503.
async function handleCheckout(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let q: PayrailQuote;
  try {
    q = await payrailQuote(env);
  } catch (err) {
    return Response.json({ error: 'rail_unavailable', detail: String(err) }, { status: 502 });
  }
  await env.PROMPTSCOPE_PRO_TOKENS.put(
    `pending:${q.quote_id}`,
    JSON.stringify({ tier: 'pro', quote_id: q.quote_id, created_at: new Date().toISOString() }),
    { expirationTtl: PENDING_TTL_SECONDS },
  );
  return Response.json({
    status: 'payment_required',
    tier: 'pro',
    quote_id: q.quote_id,
    pay_to: q.pay_to,
    confirm_url: '/api/confirm',
    instructions: q.instructions,
    expires_in_seconds: q.expires_in_seconds,
  }, { status: 402 });
}

// A buyer who paid posts { quote_id, tx_hash }. We forward it to payrail
// /receipt — the receipt's payer_ref == tx_hash is the TIER-1 artifact — then
// mint an active Pro token (the 'active' convention isProAuth() checks) and
// return it to the client so they can use it as x-promptscope-token.
async function handleConfirm(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const body = await req.json().catch(() => null) as { quote_id?: string; tx_hash?: string } | null;
  if (!body?.quote_id || !body?.tx_hash) {
    return Response.json({ error: 'quote_id and tx_hash required' }, { status: 400 });
  }
  const pendingRaw = await env.PROMPTSCOPE_PRO_TOKENS.get(`pending:${body.quote_id}`);
  if (!pendingRaw) return Response.json({ error: 'quote_not_found_or_expired' }, { status: 404 });

  const payload = JSON.stringify({
    quote_id: body.quote_id,
    ship: 'promptscope',
    sku: 'promptscope:pro',
    amount: PRO_PRICE,
    currency: 'USDC',
    rail: 'crypto',
    tx_hash: body.tx_hash,
  });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.SHIP_HMAC_SECRET) headers['x-payrail-signature'] = await hmacHex(env.SHIP_HMAC_SECRET, payload);

  const rr = await payrailFetch(env, '/receipt', { method: 'POST', headers, body: payload });
  if (!rr.ok) {
    return Response.json(
      { error: 'receipt_rejected', status: rr.status, detail: await rr.text().catch(() => '') },
      { status: 502 },
    );
  }
  const receiptResp = await rr.json().catch(() => ({})) as { ok?: boolean; receipt?: unknown };

  // Mint the active Pro token. isProAuth() checks PROMPTSCOPE_PRO_TOKENS.get(token) === 'active'.
  const token = newId(); // allow-secret (runtime-minted random id, not a value)
  await env.PROMPTSCOPE_PRO_TOKENS.put(token, 'active');
  await env.PROMPTSCOPE_PRO_TOKENS.delete(`pending:${body.quote_id}`);
  return Response.json({ ok: true, tier: 'pro', token, receipt: receiptResp.receipt }, { status: 201 });
}

// Poll payment status by proxying payrail's public receipt lookup.
async function handlePayStatus(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const quoteId = url.searchParams.get('quote_id');
  if (!quoteId) return Response.json({ error: 'quote_id required' }, { status: 400 });
  const r = await payrailFetch(env, `/receipt/${encodeURIComponent(quoteId)}`);
  if (r.status === 404) return Response.json({ paid: false, quote_id: quoteId });
  if (!r.ok) return Response.json({ error: 'status_unavailable', status: r.status }, { status: 502 });
  return Response.json({ paid: true, receipt: await r.json() });
}

async function handlePaymentInfo(req: Request, env: Env): Promise<Response> {
  return Response.json({
    crypto_address: env.CRYPTO_PAY_ADDRESS ?? null,
    crypto_chain: env.CRYPTO_CHAIN ?? 'base',
    crypto_token: 'USDC',
    pro_price_usd: 19,
    note: 'Send exactly $19 USDC. Email the tx hash + a return-email to claim a Pro token.',
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/api/analyze') return handleAnalyze(req, env);
    if (url.pathname === '/api/share')   return handleShare(req, env);
    if (url.pathname === '/api/checkout') return handleCheckout(req, env);
    if (url.pathname === '/api/confirm') return handleConfirm(req, env);
    if (url.pathname === '/api/pay-status') return handlePayStatus(req, env);
    if (url.pathname === '/api/payment-info') return handlePaymentInfo(req, env);

    // Static assets — passthrough
    return env.ASSETS.fetch(req);
  },
};
