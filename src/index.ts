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
}

const FREE_DAILY_LIMIT = 5;
const MAX_PROMPT_CHARS = 32_000;
const SHARE_TTL_SECONDS = 60 * 60 * 24 * 30;

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

async function handleCheckout(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const baseUrl = env.PROMPTSCOPE_BASE_URL ?? new URL(req.url).origin;
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID_PRO) {
    return Response.json({
      error: 'checkout not configured',
      message: 'Stripe activation pending — pay via crypto fallback for now (see /api/payment-info).',
    }, { status: 503 });
  }
  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('line_items[0][price]', env.STRIPE_PRICE_ID_PRO);
  params.append('line_items[0][quantity]', '1');
  params.append('success_url', `${baseUrl}/?upgrade=success&session={CHECKOUT_SESSION_ID}`);
  params.append('cancel_url', `${baseUrl}/?upgrade=cancelled`);
  params.append('automatic_tax[enabled]', 'true');
  params.append('billing_address_collection', 'auto');
  params.append('allow_promotion_codes', 'true');
  let resp: Response;
  try {
    resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
  } catch (err) { return Response.json({ error: `network: ${(err as Error).message}` }, { status: 502 }); }
  const data: any = await resp.json();
  if (!resp.ok) {
    return Response.json({
      error: data?.error?.message ?? `Stripe ${resp.status}`,
      code: data?.error?.code,
      message: 'Checkout temporarily unavailable. Try crypto payment below.',
    }, { status: resp.status });
  }
  return Response.json({ checkout_url: data.url, session_id: data.id });
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
    if (url.pathname === '/api/payment-info') return handlePaymentInfo(req, env);

    // Static assets — passthrough
    return env.ASSETS.fetch(req);
  },
};
