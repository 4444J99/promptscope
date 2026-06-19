/**
 * Integration-test harness for the PromptScope Worker.
 *
 * The Worker depends on four runtime bindings (AI, ASSETS, three KV namespaces)
 * and one outbound call (the Lemon Squeezy license API). To drive the real
 * request pipeline end-to-end without a live Cloudflare account we build
 * faithful in-memory fakes for the bindings and stub the single outbound fetch.
 *
 * These fakes are intentionally behavioural, not mocks-of-convenience:
 *   - FakeKV honours expirationTtl so rate-limit / cache TTL logic is exercised.
 *   - FakeAI inspects the system message to mimic the analyze vs. rewrite calls.
 *   - The Lemon stub mirrors the validate endpoint's JSON contract.
 *
 * The suite runs on Node's built-in test runner with native TypeScript support,
 * so no build step or third-party dependency is required.
 */

import worker from '../src/index.ts';

export const LEMON_VALIDATE_URL = 'https://api.lemonsqueezy.com/v1/licenses/validate';
export const VALID_LICENSE_KEY = 'VALID-PRO-KEY-0001';
export const CHECKOUT_URL = 'https://example-store.lemonsqueezy.com/buy/promptscope-pro';

/** Canned analysis the fake model returns for /api/analyze. */
export const SAMPLE_ANALYSIS = {
  score: 7,
  anti_patterns: [
    { name: 'Vague instructions', fix: 'Replace "be helpful" with concrete behaviours.' },
  ],
  strengths: ['Clear role definition'],
};

/** A KVNamespace good enough for the surface the Worker touches: get/put + TTL. */
export class FakeKV {
  private store = new Map<string, { value: string; expiresAt: number | null }>();
  // Lets tests inspect write volume; not used by the Worker.
  public puts = 0;

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.puts++;
    const ttl = opts?.expirationTtl;
    const expiresAt = typeof ttl === 'number' ? Date.now() + ttl * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export interface FakeAIOptions {
  /** Override the raw `response` field the model returns for the analyze call. */
  analyzeResponse?: unknown;
  /** Override the rewrite text. */
  rewriteResponse?: string;
  /** Force the AI binding to throw, simulating an inference outage. */
  fail?: boolean;
}

/** Mimics env.AI.run for the two distinct prompts the Worker issues. */
export class FakeAI {
  public calls: Array<{ model: string; system: string }> = [];
  private opts: FakeAIOptions;

  constructor(opts: FakeAIOptions = {}) {
    this.opts = opts;
  }

  async run(model: string, input: { messages: Array<{ role: string; content: string }> }) {
    const system = input.messages.find(m => m.role === 'system')?.content ?? '';
    this.calls.push({ model, system });
    if (this.opts.fail) throw new Error('inference outage');

    // The rewrite call uses a distinct system prompt ("expert prompt engineer").
    if (system.startsWith('You are an expert prompt engineer')) {
      return { response: this.opts.rewriteResponse ?? 'Rewritten, tighter system prompt.' };
    }

    const analyze = this.opts.analyzeResponse;
    const response = analyze !== undefined
      ? (typeof analyze === 'string' ? analyze : JSON.stringify(analyze))
      : JSON.stringify(SAMPLE_ANALYSIS);
    return { response };
  }
}

/** Static-asset fallback. The Worker only forwards non-/api requests here. */
function fakeAssets(): { fetch: (req: Request) => Promise<Response> } {
  return {
    fetch: async (req: Request) =>
      new Response(`asset:${new URL(req.url).pathname}`, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
  };
}

export interface HarnessOptions {
  ai?: FakeAIOptions;
  checkoutUrl?: string | null;
  productId?: string;
  variantId?: string;
}

export interface Harness {
  env: any;
  ai: FakeAI;
  rateKv: FakeKV;
  shareKv: FakeKV;
  licenseKv: FakeKV;
  /** Calls captured by the Lemon Squeezy stub. */
  lemonCalls: Array<{ licenseKey: string | null }>;
  /** What the Lemon stub should return for the next validate call. */
  setLemonResponse: (init: { status?: number; body: unknown }) => void;
  /** Drive the Worker. `ip` defaults to a fixed address for rate-limit tests. */
  fetch: (path: string, init?: RequestInit & { ip?: string }) => Promise<Response>;
  restore: () => void;
}

/**
 * Build an isolated Worker environment with all bindings faked and the global
 * `fetch` patched to intercept the Lemon Squeezy validate endpoint.
 */
export function createHarness(options: HarnessOptions = {}): Harness {
  const ai = new FakeAI(options.ai);
  const rateKv = new FakeKV();
  const shareKv = new FakeKV();
  const licenseKv = new FakeKV();
  const lemonCalls: Array<{ licenseKey: string | null }> = [];

  // Default Lemon behaviour: VALID_LICENSE_KEY is an active Pro license,
  // anything else is rejected. Tests can override the next response.
  let nextLemon: { status?: number; body: unknown } | null = null;
  const setLemonResponse = (init: { status?: number; body: unknown }) => { nextLemon = init; };

  const checkoutUrl = options.checkoutUrl === undefined ? CHECKOUT_URL : options.checkoutUrl;
  const env = {
    AI: ai,
    ASSETS: fakeAssets(),
    RATE_KV: rateKv,
    SHARE_KV: shareKv,
    PROMPTSCOPE_PRO_TOKENS: licenseKv,
    ...(checkoutUrl ? { LEMONSQUEEZY_CHECKOUT_URL: checkoutUrl } : {}),
    ...(options.productId ? { LEMONSQUEEZY_PRODUCT_ID: options.productId } : {}),
    ...(options.variantId ? { LEMONSQUEEZY_VARIANT_ID: options.variantId } : {}),
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === LEMON_VALIDATE_URL) {
      const params = new URLSearchParams(String(init?.body ?? ''));
      const licenseKey = params.get('license_key');
      lemonCalls.push({ licenseKey });

      if (nextLemon) {
        const { status = 200, body } = nextLemon;
        nextLemon = null;
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }

      const valid = licenseKey === VALID_LICENSE_KEY;
      const body = valid
        ? {
            valid: true,
            error: null,
            license_key: { status: 'active', key: licenseKey, expires_at: null },
            meta: { product_name: 'PromptScope Pro', variant_name: 'Monthly', product_id: 42, variant_id: 99 },
          }
        : { valid: false, error: 'license key not found', license_key: null };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // No other outbound calls are expected in tests.
    throw new Error(`unexpected outbound fetch to ${url}`);
  }) as typeof fetch;

  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

  const doFetch = async (path: string, init: RequestInit & { ip?: string } = {}) => {
    const { ip = '203.0.113.7', headers, ...rest } = init;
    const req = new Request(`https://promptscope.test${path}`, {
      ...rest,
      headers: { 'cf-connecting-ip': ip, ...(headers as Record<string, string>) },
    });
    return worker.fetch(req, env as any, ctx);
  };

  return {
    env,
    ai,
    rateKv,
    shareKv,
    licenseKv,
    lemonCalls,
    setLemonResponse,
    fetch: doFetch,
    restore: () => { globalThis.fetch = realFetch; },
  };
}

/** Convenience: build a JSON POST init. */
export function jsonPost(body: unknown, headers: Record<string, string> = {}): RequestInit & { ip?: string } {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}
