/**
 * PromptScope - Cloudflare Worker
 *
 * Single Worker handles:
 *   - Static assets (public/) via ASSETS binding
 *   - /api/analyze, /api/share, /api/license, /api/checkout
 *   - /api/keys — first-party API-key issuance + verification (admin-gated)
 */

interface Env {
  AI: any;
  ASSETS: Fetcher;
  RATE_KV: KVNamespace;
  SHARE_KV: KVNamespace;
  // KV binding stores the short-lived Lemon Squeezy license validation cache
  // (prefix `ls:`) and first-party API-key records (prefix `ak:`).
  PROMPTSCOPE_PRO_TOKENS: KVNamespace;
  LEMONSQUEEZY_CHECKOUT_URL?: string;
  LEMONSQUEEZY_PRODUCT_ID?: string;
  LEMONSQUEEZY_VARIANT_ID?: string;
  LEMONSQUEEZY_ALLOWED_PRODUCT_IDS?: string;
  LEMONSQUEEZY_ALLOWED_VARIANT_IDS?: string;
  // Shared secret that authorizes API-key administration (issue/list/revoke).
  // Set via `wrangler secret put ADMIN_TOKEN` (prod) or `.dev.vars` (local).
  ADMIN_TOKEN?: string;
}

const FREE_DAILY_LIMIT = 5;
const MAX_PROMPT_CHARS = 32_000;
const SHARE_TTL_SECONDS = 60 * 60 * 24 * 30;
const LICENSE_CACHE_TTL_SECONDS = 10 * 60;
const MAX_LICENSE_KEY_CHARS = 256;
const LEMON_LICENSE_VALIDATE_URL = 'https://api.lemonsqueezy.com/v1/licenses/validate';

// First-party API keys: issued by an admin, verified on the primary endpoints.
// Plaintext keys look like `psk_<base64url>` and are NEVER stored — only the
// SHA-256 hash is persisted at `ak:<hash>` in PROMPTSCOPE_PRO_TOKENS.
const API_KEY_PREFIX = 'psk_';
const API_KEY_RECORD_PREFIX = 'ak:';
const API_KEY_RANDOM_BYTES = 24;
const MAX_API_KEY_LABEL_CHARS = 120;
const API_KEY_PLANS = ['free', 'pro'] as const;
type ApiKeyPlan = (typeof API_KEY_PLANS)[number];

interface ApiKeyRecord {
  id: string;            // public short id (safe to display); first 16 hex of the hash
  label?: string;        // human-readable note set at issuance
  plan: ApiKeyPlan;      // 'pro' grants unlimited + advanced features
  createdAt: string;     // ISO timestamp
  revoked?: boolean;     // soft-revoked keys fail verification but remain listable
}

interface ApiKeyAuth {
  record: ApiKeyRecord;
  isPro: boolean;
}

// --- Usage metrics ---------------------------------------------------------
// Lightweight counters stored in RATE_KV (prefix `m:`, distinct from rate-limit
// keys `rl:`). Increments are best-effort and non-atomic — fine for an
// approximate status/usage dashboard on a low-traffic Worker, and consistent
// with how rate limiting already does read-then-write.
const METRIC_TTL_SECONDS = 60 * 60 * 24 * 60; // per-day blobs kept ~60 days
const STATS_WINDOW_DAYS = 14; // days of history returned by /api/stats
const METRIC_ALL_KEY = 'm:all'; // cumulative totals (no TTL)
const METRIC_META_KEY = 'm:meta'; // { since: 'YYYY-MM-DD' }
const metricDayKey = (date: string) => `m:day:${date}`;

type MetricCounts = Record<string, number>;

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

function todayUtc(): string { return new Date().toISOString().slice(0, 10); }

function parseCounts(raw: string | null): MetricCounts {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj as MetricCounts : {};
  } catch { return {}; }
}

async function addCounts(env: Env, key: string, deltas: MetricCounts, ttl?: number): Promise<void> {
  const counts = parseCounts(await env.RATE_KV.get(key).catch(() => null));
  for (const [name, delta] of Object.entries(deltas)) {
    counts[name] = (counts[name] ?? 0) + delta;
  }
  const opts = ttl ? { expirationTtl: ttl } : undefined;
  await env.RATE_KV.put(key, JSON.stringify(counts), opts).catch(() => undefined);
}

async function recordSince(env: Env, date: string): Promise<void> {
  const existing = await env.RATE_KV.get(METRIC_META_KEY).catch(() => null);
  if (existing) return;
  await env.RATE_KV.put(METRIC_META_KEY, JSON.stringify({ since: date })).catch(() => undefined);
}

// Fire-and-forget counter increments. Bundled onto ctx.waitUntil so they never
// add latency to the user-facing response.
function bumpMetrics(env: Env, ctx: ExecutionContext, deltas: MetricCounts): void {
  if (Object.keys(deltas).length === 0) return;
  const date = todayUtc();
  ctx.waitUntil(Promise.all([
    addCounts(env, METRIC_ALL_KEY, deltas),
    addCounts(env, metricDayKey(date), deltas, METRIC_TTL_SECONDS),
    recordSince(env, date),
  ]).then(() => undefined));
}

function recentDates(days: number): string[] {
  const out: string[] = [];
  const now = Date.parse(`${todayUtc()}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(now - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

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

async function rateCheck(bucket: string, env: Env): Promise<{ allowed: boolean; remaining: number }> {
  const key = `rl:${bucket}:${new Date().toISOString().slice(0, 10)}`;
  const current = Number(await env.RATE_KV.get(key) ?? 0);
  if (current >= FREE_DAILY_LIMIT) return { allowed: false, remaining: 0 };
  await env.RATE_KV.put(key, String(current + 1), { expirationTtl: 60 * 60 * 26 });
  return { allowed: true, remaining: FREE_DAILY_LIMIT - current - 1 };
}

// --- First-party API keys --------------------------------------------------

// Constant-time string comparison to avoid leaking the admin token via timing.
function timingSafeEqual(a: string, b: string): boolean {
  const ba = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

function adminTokenFromRequest(req: Request): string | undefined {
  const auth = req.headers.get('authorization');
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim() || undefined;
  return req.headers.get('x-promptscope-admin')?.trim() || undefined;
}

// Returns undefined when the caller is authorized, otherwise an error Response.
function requireAdmin(req: Request, env: Env): Response | undefined {
  const configured = env.ADMIN_TOKEN?.trim();
  if (!configured) {
    return Response.json({
      error: 'API-key administration is not configured',
      required_secret: 'ADMIN_TOKEN',
      docs: 'Set it with: wrangler secret put ADMIN_TOKEN',
    }, { status: 503 });
  }
  const provided = adminTokenFromRequest(req);
  if (!provided || !timingSafeEqual(provided, configured)) {
    return Response.json({ error: 'unauthorized' }, {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer realm="promptscope-admin"' },
    });
  }
  return undefined;
}

function randomKeySuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(API_KEY_RANDOM_BYTES));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function normalizePlan(value: unknown): ApiKeyPlan {
  return (API_KEY_PLANS as readonly string[]).includes(value as string)
    ? (value as ApiKeyPlan)
    : 'pro';
}

function apiKeyFromRequest(req: Request, body?: any): string | undefined {
  const header =
    req.headers.get('x-promptscope-api-key') ??
    req.headers.get('x-api-key');
  const candidate = normalizeLicenseKey(header ?? body?.api_key ?? body?.apiKey);
  if (candidate) return candidate;
  // Allow `Authorization: Bearer psk_...` as long as it is actually an API key
  // (so it is never confused with the admin token).
  const auth = req.headers.get('authorization');
  if (auth && /^Bearer\s+/i.test(auth)) {
    const bearer = auth.replace(/^Bearer\s+/i, '').trim();
    if (bearer.startsWith(API_KEY_PREFIX)) return bearer;
  }
  return undefined;
}

async function issueApiKey(env: Env, opts: { label?: string; plan?: unknown }): Promise<{ key: string; record: ApiKeyRecord }> {
  const key = `${API_KEY_PREFIX}${randomKeySuffix()}`;
  const hash = await sha256Hex(key);
  const record: ApiKeyRecord = {
    id: hash.slice(0, 16),
    label: opts.label ? opts.label.slice(0, MAX_API_KEY_LABEL_CHARS) : undefined,
    plan: normalizePlan(opts.plan),
    createdAt: new Date().toISOString(),
  };
  await env.PROMPTSCOPE_PRO_TOKENS.put(`${API_KEY_RECORD_PREFIX}${hash}`, JSON.stringify(record));
  return { key, record };
}

async function verifyApiKey(key: string | undefined, env: Env): Promise<ApiKeyAuth | undefined> {
  if (!key || !key.startsWith(API_KEY_PREFIX)) return undefined;
  const hash = await sha256Hex(key);
  const raw = await env.PROMPTSCOPE_PRO_TOKENS.get(`${API_KEY_RECORD_PREFIX}${hash}`).catch(() => null);
  if (!raw) return undefined;
  let record: ApiKeyRecord;
  try { record = JSON.parse(raw) as ApiKeyRecord; } catch { return undefined; }
  if (record.revoked) return undefined;
  return { record, isPro: record.plan === 'pro' };
}

async function listApiKeys(env: Env): Promise<ApiKeyRecord[]> {
  const records: ApiKeyRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PROMPTSCOPE_PRO_TOKENS.list({ prefix: API_KEY_RECORD_PREFIX, cursor });
    for (const entry of page.keys) {
      const raw = await env.PROMPTSCOPE_PRO_TOKENS.get(entry.name).catch(() => null);
      if (!raw) continue;
      try { records.push(JSON.parse(raw) as ApiKeyRecord); } catch {}
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Revokes by public id. Returns true if a matching key was found and revoked.
async function revokeApiKey(env: Env, id: string): Promise<boolean> {
  let cursor: string | undefined;
  do {
    const page = await env.PROMPTSCOPE_PRO_TOKENS.list({ prefix: API_KEY_RECORD_PREFIX, cursor });
    for (const entry of page.keys) {
      const raw = await env.PROMPTSCOPE_PRO_TOKENS.get(entry.name).catch(() => null);
      if (!raw) continue;
      let record: ApiKeyRecord;
      try { record = JSON.parse(raw) as ApiKeyRecord; } catch { continue; }
      if (record.id !== id) continue;
      await env.PROMPTSCOPE_PRO_TOKENS.put(entry.name, JSON.stringify({ ...record, revoked: true }));
      return true;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return false;
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function handleAnalyze(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method === 'GET') {
    return Response.json({
      description: 'PromptScope analyze API',
      method: 'POST /api/analyze',
      body: { prompt: 'string up to 32k chars', license_key: 'optional Lemon Squeezy license key', api_key: 'optional first-party API key (psk_...)' },
      auth_headers_optional: ['x-promptscope-api-key', 'x-promptscope-license'],
      license_endpoint: 'POST /api/license',
      keys_endpoint: 'POST /api/keys (admin) to issue first-party API keys',
      free_limit: '5 / day (per API key, else per IP)',
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
  const apiKeyAuth = await verifyApiKey(apiKeyFromRequest(req, body), env);
  const isPro = licenseAccess.isPro || (apiKeyAuth?.isPro ?? false);

  let remaining: number | undefined;
  if (!isPro) {
    // Identified API keys get their own per-key quota bucket; anonymous callers
    // fall back to per-IP limiting.
    const bucket = apiKeyAuth
      ? `key:${apiKeyAuth.record.id}`
      : `ip:${req.headers.get('cf-connecting-ip') ?? 'unknown'}`;
    const rl = await rateCheck(bucket, env);
    if (!rl.allowed) {
      bumpMetrics(env, ctx, { rate_limited: 1 });
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

  bumpMetrics(env, ctx, {
    analyze: 1,
    [isPro ? 'analyze_pro' : 'analyze_free']: 1,
    tokens: approxTokens(prompt),
    ...(suggested_rewrite ? { rewrite: 1 } : {}),
  });

  const licenseInfo = publicLicense(licenseAccess);
  return Response.json({
    score: Math.max(0, Math.min(10, parsed.score)),
    token_count: approxTokens(prompt),
    char_count: prompt.length,
    plan: isPro ? 'pro' : 'free',
    auth: apiKeyAuth
      ? { method: 'api_key', key_id: apiKeyAuth.record.id, plan: apiKeyAuth.record.plan }
      : licenseAccess.isPro
        ? { method: 'license', plan: 'pro' }
        : { method: 'none', plan: 'free' },
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

async function handleLicense(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
  bumpMetrics(env, ctx, { [access.isPro ? 'license_valid' : 'license_invalid']: 1 });
  const status = access.isPro ? 200 : 401;
  const licenseInfo = publicLicense(access);
  return Response.json({
    valid: access.isPro,
    plan: access.isPro ? 'pro' : 'free',
    upgrade_url: upgradeHref(env),
    ...(licenseInfo ? { license: licenseInfo } : {}),
  }, { status });
}

async function handleShare(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method === 'POST') {
    let body: any;
    try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
    const prompt = String(body?.prompt ?? '');
    if (!prompt) return Response.json({ error: 'missing prompt' }, { status: 400 });
    if (prompt.length > MAX_PROMPT_CHARS) return Response.json({ error: 'prompt too long' }, { status: 400 });
    const id = newId();
    await env.SHARE_KV.put(id, prompt, { expirationTtl: SHARE_TTL_SECONDS });
    bumpMetrics(env, ctx, { share_created: 1 });
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

async function handleKeys(req: Request, env: Env): Promise<Response> {
  // GET docs are public; mutating/listing operations require the admin token.
  if (req.method === 'GET' && !adminTokenFromRequest(req)) {
    return Response.json({
      description: 'PromptScope API-key administration',
      auth: 'Authorization: Bearer <ADMIN_TOKEN>  (or x-promptscope-admin header)',
      operations: {
        issue: 'POST /api/keys  body: {"label"?: string, "plan"?: "free"|"pro"}  -> returns plaintext key ONCE',
        list: 'GET /api/keys  -> key metadata (never the plaintext key)',
        revoke: 'DELETE /api/keys  body: {"id": "<key id>"}',
      },
      usage: 'Send issued keys to /api/analyze as `x-promptscope-api-key: psk_...` or `Authorization: Bearer psk_...`',
      configured: Boolean(env.ADMIN_TOKEN?.trim()),
    });
  }

  const denied = requireAdmin(req, env);
  if (denied) return denied;

  if (req.method === 'GET') {
    return Response.json({ keys: await listApiKeys(env) });
  }

  if (req.method === 'POST') {
    const body = await req.json().catch(() => null) as { label?: unknown; plan?: unknown } | null;
    const label = typeof body?.label === 'string' ? body.label : undefined;
    const { key, record } = await issueApiKey(env, { label, plan: body?.plan });
    return Response.json({
      api_key: key,
      note: 'Store this now — it is shown only once and cannot be recovered.',
      ...record,
    }, { status: 201 });
  }

  if (req.method === 'DELETE') {
    const body = await req.json().catch(() => null) as { id?: unknown } | null;
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!id) return Response.json({ error: 'missing key id' }, { status: 400 });
    const revoked = await revokeApiKey(env, id);
    if (!revoked) return Response.json({ error: 'key not found' }, { status: 404 });
    return Response.json({ revoked: true, id });
  }

  return new Response('method not allowed', { status: 405 });
}

async function handleStats(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });

  const dates = recentDates(STATS_WINDOW_DAYS);
  const [totalsRaw, metaRaw, ...dayRaws] = await Promise.all([
    env.RATE_KV.get(METRIC_ALL_KEY).catch(() => null),
    env.RATE_KV.get(METRIC_META_KEY).catch(() => null),
    ...dates.map(d => env.RATE_KV.get(metricDayKey(d)).catch(() => null)),
  ]);

  const totals = parseCounts(totalsRaw);
  const daily = dates.map((date, i) => ({ date, ...parseCounts(dayRaws[i]) }));
  const today = daily[daily.length - 1] ?? { date: todayUtc() };

  let since: string | undefined;
  try { since = metaRaw ? JSON.parse(metaRaw)?.since : undefined; } catch {}

  return Response.json({
    generated_at: new Date().toISOString(),
    since: since ?? null,
    window_days: STATS_WINDOW_DAYS,
    metrics: ['analyze', 'analyze_free', 'analyze_pro', 'rewrite', 'tokens', 'share_created', 'rate_limited', 'license_valid', 'license_invalid'],
    totals,
    today,
    daily,
    config: {
      free_daily_limit: FREE_DAILY_LIMIT,
      pro_checkout_configured: Boolean(upgradeUrl(env)),
    },
  }, { headers: { 'cache-control': 'public, max-age=60' } });
}

function handleApiIndex(env: Env): Response {
  return Response.json({
    name: 'PromptScope API',
    endpoints: {
      analyze: 'POST /api/analyze',
      license: 'POST /api/license',
      keys: 'GET|POST|DELETE /api/keys (admin)',
      share: 'POST /api/share',
      checkout: 'GET /api/checkout',
      stats: 'GET /api/stats',
    },
    dashboard: '/dashboard',
    free_limit: '5 / day (per API key, else per IP)',
    auth: {
      api_key_header: 'x-promptscope-api-key',
      license_header: 'x-promptscope-license',
      admin: 'Authorization: Bearer <ADMIN_TOKEN> on /api/keys',
    },
    upgrade_url: upgradeHref(env),
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/api') return handleApiIndex(env);
    if (url.pathname === '/api/analyze') return handleAnalyze(req, env, ctx);
    if (url.pathname === '/api/license') return handleLicense(req, env, ctx);
    if (url.pathname === '/api/keys') return handleKeys(req, env);
    if (url.pathname === '/api/share') return handleShare(req, env, ctx);
    if (url.pathname === '/api/checkout') return handleCheckout(req, env);
    if (url.pathname === '/api/stats') return handleStats(req, env);

    // Pretty path for the usage dashboard; assets serve the HTML file.
    if (url.pathname === '/dashboard') {
      return env.ASSETS.fetch(new Request(new URL('/dashboard.html', url), req));
    }

    // Static assets passthrough.
    return env.ASSETS.fetch(req);
  },
};
