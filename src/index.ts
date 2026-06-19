/**
 * PromptScope - Cloudflare Worker
 *
 * Single Worker handles:
 *   - Static assets (public/) via ASSETS binding
 *   - /api/analyze, /api/share, /api/license, /api/checkout
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
// Upper bound on a request body we'll read. A 32k-char prompt is ~128 KB of
// UTF-8 plus JSON escaping; 512 KB leaves generous headroom while rejecting
// obviously-abusive payloads before we parse them.
const MAX_BODY_BYTES = 512 * 1024;
const MAX_SHARE_ID_CHARS = 64;
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

// ---------------------------------------------------------------------------
// Structured logging
//
// Every line is a single JSON object so Cloudflare Workers observability /
// Logpush can index fields directly. NEVER log secrets — no license keys, no
// prompt text. We log lengths, hashes, and outcomes instead.
// ---------------------------------------------------------------------------

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Extract a safe, bounded message from an unknown thrown value for logging.
function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 500 ? `${msg.slice(0, 500)}…` : msg;
}

function emitLog(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  let line: string;
  try {
    line = JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields });
  } catch {
    // Defensive: a non-serializable field must never take down a request.
    line = JSON.stringify({ level, event, ts: new Date().toISOString(), log_error: 'unserializable fields' });
  }
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

interface RequestContext {
  reqId: string;
  method: string;
  path: string;
  log: (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;
}

function makeContext(req: Request, url: URL): RequestContext {
  // Prefer Cloudflare's ray id so logs correlate with the CF dashboard;
  // fall back to a UUID for local `wrangler dev`.
  const reqId = req.headers.get('cf-ray') ?? crypto.randomUUID();
  const method = req.method;
  const path = url.pathname;
  return {
    reqId,
    method,
    path,
    log: (level, event, fields = {}) => emitLog(level, event, { request_id: reqId, method, path, ...fields }),
  };
}

// ---------------------------------------------------------------------------
// Response + input-validation helpers
// ---------------------------------------------------------------------------

function jsonError(ctx: RequestContext, error: string, status: number, extra: Record<string, unknown> = {}): Response {
  // request_id is additive — existing clients read `error`; new clients can
  // quote request_id when reporting problems.
  return Response.json({ error, request_id: ctx.reqId, ...extra }, {
    status,
    headers: { 'x-request-id': ctx.reqId },
  });
}

function methodNotAllowed(ctx: RequestContext, allow: string): Response {
  return jsonError(ctx, 'method not allowed', 405, { allow });
}

type BodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response };

// Reads and validates a JSON request body: enforces a size cap before parsing,
// rejects malformed JSON, and requires a plain object (not an array/primitive).
async function readJsonObject(req: Request, ctx: RequestContext): Promise<BodyResult> {
  const contentLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    ctx.log('warn', 'body_too_large', { content_length: contentLength, limit: MAX_BODY_BYTES });
    return { ok: false, response: jsonError(ctx, 'request body too large', 413) };
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return { ok: false, response: jsonError(ctx, 'invalid JSON', 400) };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, response: jsonError(ctx, 'request body must be a JSON object', 400) };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

type PromptResult =
  | { ok: true; prompt: string }
  | { ok: false; response: Response };

// Validates the `prompt` field strictly: it must be a non-empty string within
// the char limit. We do NOT coerce objects/numbers via String() — that would
// silently analyze "[object Object]".
function validatePrompt(body: Record<string, unknown>, ctx: RequestContext): PromptResult {
  const value = body.prompt;
  if (typeof value !== 'string') {
    return { ok: false, response: jsonError(ctx, 'prompt must be a string', 400) };
  }
  if (value.length === 0) {
    return { ok: false, response: jsonError(ctx, 'missing prompt', 400) };
  }
  if (value.length > MAX_PROMPT_CHARS) {
    return { ok: false, response: jsonError(ctx, `prompt exceeds ${MAX_PROMPT_CHARS} chars`, 400) };
  }
  return { ok: true, prompt: value };
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

async function rateCheck(ip: string, env: Env): Promise<{ allowed: boolean; remaining: number }> {
  const key = `rl:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const current = Number(await env.RATE_KV.get(key) ?? 0);
  if (current >= FREE_DAILY_LIMIT) return { allowed: false, remaining: 0 };
  await env.RATE_KV.put(key, String(current + 1), { expirationTtl: 60 * 60 * 26 });
  return { allowed: true, remaining: FREE_DAILY_LIMIT - current - 1 };
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function handleAnalyze(req: Request, env: Env, ctx: RequestContext): Promise<Response> {
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
  if (req.method !== 'POST') return methodNotAllowed(ctx, 'GET, POST');

  const parsedBody = await readJsonObject(req, ctx);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;

  const promptResult = validatePrompt(body, ctx);
  if (!promptResult.ok) return promptResult.response;
  const prompt = promptResult.prompt;

  const licenseAccess = await validateLemonLicense(licenseKeyFromRequest(req, body), env);
  const isPro = licenseAccess.isPro;

  let remaining: number | undefined;
  if (!isPro) {
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const rl = await rateCheck(ip, env);
    if (!rl.allowed) {
      ctx.log('info', 'rate_limited', { char_count: prompt.length });
      return jsonError(ctx, 'daily free quota exhausted; upgrade to Pro for unlimited analysis', 429, {
        upgrade_url: upgradeHref(env),
        ...(licenseAccess.error ? { license_error: licenseAccess.error } : {}),
      });
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
    // Log the real cause server-side; return a generic message so we don't
    // leak provider internals / stack details to clients.
    ctx.log('error', 'inference_failed', { stage: 'analyze', error: errorMessage(err) });
    return jsonError(ctx, 'inference failed', 502);
  }

  const raw = aiResp?.response ?? aiResp?.result ?? aiResp ?? '';
  const parsed = tryParseJson(raw);
  if (!parsed || typeof parsed.score !== 'number') {
    ctx.log('warn', 'malformed_output', { raw_type: typeof raw });
    return jsonError(ctx, 'analysis output malformed', 502);
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
    } catch (err) {
      ctx.log('warn', 'inference_failed', { stage: 'rewrite', error: errorMessage(err) });
      rewrite_error = 'rewrite unavailable';
    }
  }

  ctx.log('info', 'analyze_ok', { plan: isPro ? 'pro' : 'free', score: parsed.score, char_count: prompt.length });

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

async function handleLicense(req: Request, env: Env, ctx: RequestContext): Promise<Response> {
  if (req.method === 'GET') {
    return Response.json({
      auth_header: 'x-promptscope-license',
      body_field: 'license_key',
      upgrade_url: upgradeHref(env),
      cache_ttl_seconds: LICENSE_CACHE_TTL_SECONDS,
    });
  }
  if (req.method !== 'POST') return methodNotAllowed(ctx, 'GET, POST');

  const parsedBody = await readJsonObject(req, ctx);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;

  const access = await validateLemonLicense(normalizeLicenseKey(body.license_key ?? body.licenseKey), env);
  ctx.log('info', 'license_check', { valid: access.isPro, source: access.source });
  const status = access.isPro ? 200 : 401;
  const licenseInfo = publicLicense(access);
  return Response.json({
    valid: access.isPro,
    plan: access.isPro ? 'pro' : 'free',
    upgrade_url: upgradeHref(env),
    ...(licenseInfo ? { license: licenseInfo } : {}),
  }, { status });
}

async function handleShare(req: Request, env: Env, ctx: RequestContext): Promise<Response> {
  if (req.method === 'POST') {
    const parsedBody = await readJsonObject(req, ctx);
    if (!parsedBody.ok) return parsedBody.response;

    const promptResult = validatePrompt(parsedBody.body, ctx);
    if (!promptResult.ok) return promptResult.response;

    const id = newId();
    try {
      await env.SHARE_KV.put(id, promptResult.prompt, { expirationTtl: SHARE_TTL_SECONDS });
    } catch (err) {
      ctx.log('error', 'share_put_failed', { error: errorMessage(err) });
      return jsonError(ctx, 'could not save share link', 502);
    }
    ctx.log('info', 'share_created', { id, char_count: promptResult.prompt.length });
    return Response.json({ id, expires_in_seconds: SHARE_TTL_SECONDS });
  }
  if (req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('id');
    if (!id || id.length > MAX_SHARE_ID_CHARS || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      return jsonError(ctx, 'invalid id', 400);
    }
    let prompt: string | null;
    try {
      prompt = await env.SHARE_KV.get(id);
    } catch (err) {
      ctx.log('error', 'share_get_failed', { id, error: errorMessage(err) });
      return jsonError(ctx, 'could not load share link', 502);
    }
    if (!prompt) return jsonError(ctx, 'not found or expired', 404);
    return Response.json({ id, prompt });
  }
  return methodNotAllowed(ctx, 'GET, POST');
}

async function handleCheckout(req: Request, env: Env, ctx: RequestContext): Promise<Response> {
  const url = upgradeUrl(env);
  if (!url) {
    return jsonError(ctx, 'upgrade link is not configured', 503, { required_var: 'LEMONSQUEEZY_CHECKOUT_URL' });
  }
  if (req.method === 'GET') return Response.redirect(url, 303);
  if (req.method === 'POST') return Response.json({ checkout_url: url, upgrade_url: url });
  return methodNotAllowed(ctx, 'GET, POST');
}

function handleApiIndex(env: Env): Response {
  return Response.json({
    name: 'PromptScope API',
    endpoints: {
      analyze: 'POST /api/analyze',
      license: 'POST /api/license',
      share: 'POST /api/share',
      checkout: 'GET /api/checkout',
    },
    free_limit: '5 / IP / day',
    pro_auth_header: 'x-promptscope-license',
    upgrade_url: upgradeHref(env),
  });
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Non-API paths are static assets — pass straight through untouched.
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(req);
    }

    const ctx = makeContext(req, url);
    const startedMs = Date.now();
    try {
      let resp: Response;
      switch (url.pathname) {
        case '/api': resp = handleApiIndex(env); break;
        case '/api/analyze': resp = await handleAnalyze(req, env, ctx); break;
        case '/api/license': resp = await handleLicense(req, env, ctx); break;
        case '/api/share': resp = await handleShare(req, env, ctx); break;
        case '/api/checkout': resp = await handleCheckout(req, env, ctx); break;
        default: resp = jsonError(ctx, 'not found', 404); break;
      }
      // Stamp every API response with the trace id. Redirects (3xx) carry an
      // immutable Headers guard, so skip them to avoid throwing.
      if (resp.status < 300 || resp.status >= 400) resp.headers.set('x-request-id', ctx.reqId);
      ctx.log('info', 'request', { status: resp.status, duration_ms: Date.now() - startedMs });
      return resp;
    } catch (err) {
      // Last line of defense: any uncaught throw becomes a clean 500 with a
      // request id the user can quote, while the stack stays in our logs only.
      ctx.log('error', 'unhandled_error', {
        error: errorMessage(err),
        stack: err instanceof Error ? err.stack : undefined,
        duration_ms: Date.now() - startedMs,
      });
      return jsonError(ctx, 'internal error', 500);
    }
  },
};
