/**
 * PromptScope - Cloudflare Worker
 *
 * Single Worker handles:
 *   - Static assets (public/) via ASSETS binding
 *   - /api/analyze, /api/share, /api/license, /api/account, /api/checkout
 */

interface Env {
  AI: any;
  ASSETS: Fetcher;
  RATE_KV: KVNamespace;
  SHARE_KV: KVNamespace;
  // Existing KV binding now stores short-lived Lemon Squeezy license validation cache.
  PROMPTSCOPE_PRO_TOKENS: KVNamespace;
  LEMONSQUEEZY_CHECKOUT_URL?: string;
  LEMONSQUEEZY_PRODUCT_ID?: string;
  LEMONSQUEEZY_VARIANT_ID?: string;
  LEMONSQUEEZY_ALLOWED_PRODUCT_IDS?: string;
  LEMONSQUEEZY_ALLOWED_VARIANT_IDS?: string;
}

const FREE_DAILY_LIMIT = 5;
const MAX_PROMPT_CHARS = 32_000;
const SHARE_TTL_SECONDS = 60 * 60 * 24 * 30;
const LICENSE_CACHE_TTL_SECONDS = 10 * 60;
const MAX_LICENSE_KEY_CHARS = 256;
const LEMON_LICENSE_VALIDATE_URL = 'https://api.lemonsqueezy.com/v1/licenses/validate';

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

interface LemonValidateResponse {
  valid?: boolean;
  error?: string | null;
  license_key?: {
    id?: number | string;
    status?: string;
    key?: string;
    activation_limit?: number;
    activation_usage?: number;
    expires_at?: string | null;
  };
  meta?: {
    store_id?: number | string;
    order_id?: number | string;
    order_item_id?: number | string;
    product_id?: number | string;
    product_name?: string;
    variant_id?: number | string;
    variant_name?: string;
    customer_id?: number | string;
    customer_name?: string;
    customer_email?: string;
  };
}

interface LicenseAccess {
  isPro: boolean;
  status?: string;
  expiresAt?: string | null;
  productName?: string;
  variantName?: string;
  source?: 'cache' | 'lemonsqueezy';
  error?: string;
}

function approxTokens(s: string): number { return Math.ceil(s.length / 4); }

function tryParseJson(s: unknown): any | null {
  if (s == null) return null;
  // Workers AI may return objects directly when response_format is JSON.
  if (typeof s === 'object') return s;
  const str = typeof s === 'string' ? s : String(s);
  const cleaned = str.replace(/^```json\s*|\s*```$/g, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

function upgradeUrl(env: Env): string | undefined {
  const value = env.LEMONSQUEEZY_CHECKOUT_URL?.trim();
  if (!value) return undefined;
  return /^https:\/\/.+/i.test(value) ? value : undefined;
}

function upgradeHref(env: Env): string {
  return upgradeUrl(env) ?? '/api/checkout';
}

function normalizeLicenseKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function licenseKeyFromRequest(req: Request, body?: any): string | undefined {
  return normalizeLicenseKey(
    req.headers.get('x-promptscope-license') ??
    req.headers.get('x-promptscope-key') ??
    req.headers.get('x-promptscope-token') ??
    body?.license_key ??
    body?.licenseKey,
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function configuredIds(primary?: string, csv?: string): Set<string> {
  const values = [
    ...(primary ? [primary] : []),
    ...(csv ? csv.split(/[,\s]+/) : []),
  ]
    .map(v => v.trim())
    .filter(Boolean);
  return new Set(values);
}

function idAllowed(actual: number | string | undefined, allowed: Set<string>): boolean {
  if (allowed.size === 0) return true;
  if (actual == null) return false;
  return allowed.has(String(actual));
}

function licenseScopeError(data: LemonValidateResponse, env: Env): string | undefined {
  const productIds = configuredIds(env.LEMONSQUEEZY_PRODUCT_ID, env.LEMONSQUEEZY_ALLOWED_PRODUCT_IDS);
  const variantIds = configuredIds(env.LEMONSQUEEZY_VARIANT_ID, env.LEMONSQUEEZY_ALLOWED_VARIANT_IDS);

  if (!idAllowed(data.meta?.product_id, productIds)) return 'license is for a different product';
  if (!idAllowed(data.meta?.variant_id, variantIds)) return 'license is for a different plan';
  return undefined;
}

function licenseExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false;
  const expiresMs = Date.parse(expiresAt);
  return Number.isFinite(expiresMs) && expiresMs <= Date.now();
}

function publicLicense(access: LicenseAccess): Record<string, unknown> | undefined {
  if (!access.isPro && !access.error) return undefined;
  if (!access.isPro) return { valid: false, error: access.error };
  return {
    valid: true,
    status: access.status,
    expires_at: access.expiresAt ?? null,
    product_name: access.productName,
    variant_name: access.variantName,
    source: access.source,
  };
}

async function readCachedLicense(env: Env, cacheKey: string): Promise<LicenseAccess | undefined> {
  const raw = await env.PROMPTSCOPE_PRO_TOKENS.get(cacheKey).catch(() => null);
  if (!raw) return undefined;
  try {
    const cached = JSON.parse(raw) as LicenseAccess;
    if (cached?.isPro && !licenseExpired(cached.expiresAt)) return { ...cached, source: 'cache' };
  } catch {}
  return undefined;
}

async function cacheLicense(env: Env, cacheKey: string, access: LicenseAccess): Promise<void> {
  if (!access.isPro) return;
  const expiryMs = access.expiresAt ? Date.parse(access.expiresAt) : NaN;
  const secondsUntilExpiry = Number.isFinite(expiryMs)
    ? Math.floor((expiryMs - Date.now()) / 1000)
    : LICENSE_CACHE_TTL_SECONDS;
  const ttl = Math.min(LICENSE_CACHE_TTL_SECONDS, secondsUntilExpiry);
  if (ttl <= 0) return;
  await env.PROMPTSCOPE_PRO_TOKENS.put(cacheKey, JSON.stringify({
    isPro: true,
    status: access.status,
    expiresAt: access.expiresAt ?? null,
    productName: access.productName,
    variantName: access.variantName,
  }), { expirationTtl: ttl }).catch(() => undefined);
}

async function validateLemonLicense(licenseKey: string | undefined, env: Env): Promise<LicenseAccess> {
  if (!licenseKey) return { isPro: false };
  if (licenseKey.length > MAX_LICENSE_KEY_CHARS) {
    return { isPro: false, error: 'license key is too long' };
  }

  const cacheKey = `ls:${await sha256Hex(licenseKey)}`;
  const cached = await readCachedLicense(env, cacheKey);
  if (cached) return cached;

  const form = new URLSearchParams({ license_key: licenseKey });
  let resp: Response;
  try {
    resp = await fetch(LEMON_LICENSE_VALIDATE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
  } catch {
    return { isPro: false, error: 'license check unavailable' };
  }

  const data = await resp.json().catch(() => null) as LemonValidateResponse | null;
  if (!resp.ok) {
    return { isPro: false, error: data?.error ?? `license check failed (${resp.status})` };
  }
  if (!data?.valid) {
    return { isPro: false, error: data?.error ?? 'license is not valid' };
  }

  const status = String(data.license_key?.status ?? '').toLowerCase();
  if (status && status !== 'active' && status !== 'inactive') {
    return { isPro: false, error: `license is ${status}` };
  }
  if (licenseExpired(data.license_key?.expires_at)) {
    return { isPro: false, error: 'license is expired' };
  }

  const scopeError = licenseScopeError(data, env);
  if (scopeError) return { isPro: false, error: scopeError };

  const access: LicenseAccess = {
    isPro: true,
    status: status || 'valid',
    expiresAt: data.license_key?.expires_at ?? null,
    productName: data.meta?.product_name,
    variantName: data.meta?.variant_name,
    source: 'lemonsqueezy',
  };
  await cacheLicense(env, cacheKey, access);
  return access;
}

function rateLimitKey(ip: string): string {
  return `rl:${ip}:${new Date().toISOString().slice(0, 10)}`;
}

async function readFreeUsage(ip: string, env: Env): Promise<{ used: number; remaining: number; limit: number }> {
  const stored = Number(await env.RATE_KV.get(rateLimitKey(ip)) ?? 0);
  const used = Number.isFinite(stored) && stored > 0 ? Math.min(stored, FREE_DAILY_LIMIT) : 0;
  return {
    used,
    remaining: Math.max(0, FREE_DAILY_LIMIT - used),
    limit: FREE_DAILY_LIMIT,
  };
}

async function rateCheck(ip: string, env: Env): Promise<{ allowed: boolean; remaining: number }> {
  const key = rateLimitKey(ip);
  const stored = Number(await env.RATE_KV.get(key) ?? 0);
  const current = Number.isFinite(stored) && stored > 0 ? stored : 0;
  if (current >= FREE_DAILY_LIMIT) return { allowed: false, remaining: 0 };
  await env.RATE_KV.put(key, String(current + 1), { expirationTtl: 60 * 60 * 26 });
  return { allowed: true, remaining: FREE_DAILY_LIMIT - current - 1 };
}

function accountEntitlements(isPro: boolean): Record<string, unknown> {
  return {
    analyses_per_day: isPro ? 'unlimited' : FREE_DAILY_LIMIT,
    suggested_rewrite: isPro,
    api_access: isPro,
    shareable_permalinks: true,
    max_prompt_chars: MAX_PROMPT_CHARS,
  };
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
      body: { prompt: 'string up to 32k chars', license_key: 'optional Lemon Squeezy license key' },
      auth_header_optional: 'x-promptscope-license',
      license_endpoint: 'POST /api/license',
      free_limit: '5 / IP / day',
      advanced_features: ['suggested_rewrite'],
      upgrade_url: upgradeHref(env),
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

  const licenseAccess = await validateLemonLicense(licenseKeyFromRequest(req, body), env);
  const isPro = licenseAccess.isPro;

  let remaining: number | undefined;
  if (!isPro) {
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const rl = await rateCheck(ip, env);
    if (!rl.allowed) {
      return Response.json({
        error: 'daily free quota exhausted; upgrade to Pro for unlimited analysis',
        upgrade_url: upgradeHref(env),
        ...(licenseAccess.error ? { license_error: licenseAccess.error } : {}),
      }, { status: 429 });
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
  let rewrite_error: string | undefined;
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
    } catch {
      rewrite_error = 'rewrite unavailable';
    }
  }

  const licenseInfo = publicLicense(licenseAccess);
  return Response.json({
    score: Math.max(0, Math.min(10, parsed.score)),
    token_count: approxTokens(prompt),
    char_count: prompt.length,
    plan: isPro ? 'pro' : 'free',
    anti_patterns: Array.isArray(parsed.anti_patterns) ? parsed.anti_patterns.slice(0, 12) : [],
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.slice(0, 8) : [],
    advanced_features: {
      suggested_rewrite: {
        locked: !isPro,
        upgrade_url: !isPro ? upgradeHref(env) : undefined,
      },
    },
    ...(suggested_rewrite ? { suggested_rewrite } : {}),
    ...(rewrite_error ? { rewrite_error } : {}),
    ...(remaining !== undefined ? { quota_remaining: remaining } : {}),
    ...(licenseAccess.error ? { license_error: licenseAccess.error } : {}),
    ...(licenseInfo ? { license: licenseInfo } : {}),
  });
}

async function handleLicense(req: Request, env: Env): Promise<Response> {
  if (req.method === 'GET') {
    return Response.json({
      auth_header: 'x-promptscope-license',
      body_field: 'license_key',
      upgrade_url: upgradeHref(env),
      cache_ttl_seconds: LICENSE_CACHE_TTL_SECONDS,
    });
  }
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const body = await req.json().catch(() => null) as { license_key?: string; licenseKey?: string } | null;
  if (!body) return Response.json({ error: 'invalid JSON' }, { status: 400 });

  const access = await validateLemonLicense(normalizeLicenseKey(body.license_key ?? body.licenseKey), env);
  const status = access.isPro ? 200 : 401;
  const licenseInfo = publicLicense(access);
  return Response.json({
    valid: access.isPro,
    plan: access.isPro ? 'pro' : 'free',
    upgrade_url: upgradeHref(env),
    ...(licenseInfo ? { license: licenseInfo } : {}),
  }, { status });
}

async function handleAccount(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  let body: any;
  if (req.method === 'POST') {
    body = await req.json().catch(() => undefined);
    if (body === undefined) return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const licenseKey = licenseKeyFromRequest(req, body);
  const access = await validateLemonLicense(licenseKey, env);
  const isPro = access.isPro;
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  const freeUsage = isPro ? undefined : await readFreeUsage(ip, env);
  const licenseInfo = publicLicense(access);
  const origin = new URL(req.url).origin;

  return Response.json({
    plan: isPro ? 'pro' : 'free',
    valid_license: isPro,
    license: licenseInfo ?? { valid: false },
    entitlements: accountEntitlements(isPro),
    usage: isPro
      ? { analyses_today: null, quota_remaining: null, quota_limit: null, quota_label: 'Unlimited' }
      : {
          analyses_today: freeUsage?.used ?? 0,
          quota_remaining: freeUsage?.remaining ?? FREE_DAILY_LIMIT,
          quota_limit: freeUsage?.limit ?? FREE_DAILY_LIMIT,
        },
    api: {
      analyze_endpoint: `${origin}/api/analyze`,
      auth_header: 'x-promptscope-license',
      body: { prompt: `string up to ${MAX_PROMPT_CHARS} chars` },
    },
    upgrade_url: upgradeHref(env),
    ...(access.error ? { license_error: access.error } : {}),
  }, { status: access.error && licenseKey ? 401 : 200 });
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
  const url = upgradeUrl(env);
  if (!url) {
    return Response.json({
      error: 'upgrade link is not configured',
      required_var: 'LEMONSQUEEZY_CHECKOUT_URL',
    }, { status: 503 });
  }
  if (req.method === 'GET') return Response.redirect(url, 303);
  if (req.method === 'POST') return Response.json({ checkout_url: url, upgrade_url: url });
  return new Response('method not allowed', { status: 405 });
}

function handleApiIndex(env: Env): Response {
  return Response.json({
    name: 'PromptScope API',
    endpoints: {
      analyze: 'POST /api/analyze',
      license: 'POST /api/license',
      account: 'GET /api/account',
      share: 'POST /api/share',
      checkout: 'GET /api/checkout',
    },
    free_limit: '5 / IP / day',
    pro_auth_header: 'x-promptscope-license',
    upgrade_url: upgradeHref(env),
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/api') return handleApiIndex(env);
    if (url.pathname === '/api/analyze') return handleAnalyze(req, env);
    if (url.pathname === '/api/license') return handleLicense(req, env);
    if (url.pathname === '/api/account') return handleAccount(req, env);
    if (url.pathname === '/api/share') return handleShare(req, env);
    if (url.pathname === '/api/checkout') return handleCheckout(req, env);

    // Static assets passthrough.
    return env.ASSETS.fetch(req);
  },
};
