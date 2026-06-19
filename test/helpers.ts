/**
 * Shared test doubles for the PromptScope Worker.
 *
 * The Worker depends on three Cloudflare bindings (AI, KV namespaces, ASSETS)
 * plus the global `fetch` (Lemon Squeezy license validation). These helpers
 * provide in-memory fakes so the handlers can be exercised without workerd.
 */
import type { Env } from '../src/index.ts'

export interface FakeKV {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  store: Map<string, { value: string; ttl?: number }>
  /** Number of put() calls, for asserting cache/write behaviour. */
  puts: number
}

/** In-memory KVNamespace stand-in. */
export function fakeKV(seed?: Record<string, string>): FakeKV {
  const store = new Map<string, { value: string; ttl?: number }>()
  if (seed) for (const [k, v] of Object.entries(seed)) store.set(k, { value: v })
  return {
    store,
    puts: 0,
    async get(key) {
      return store.has(key) ? store.get(key)!.value : null
    },
    async put(key, value, opts) {
      this.puts++
      store.set(key, { value, ttl: opts?.expirationTtl })
    },
    async delete(key) {
      store.delete(key)
    },
  }
}

/** A KV namespace whose get()/put() always reject — exercises the `.catch()` paths. */
export function throwingKV(): FakeKV {
  const base = fakeKV()
  return {
    ...base,
    async get() {
      throw new Error('kv down')
    },
    async put() {
      throw new Error('kv down')
    },
  }
}

export interface AIMock {
  run(model: string, opts: any): Promise<any>
  /** Records every call as [model, opts]. */
  calls: Array<[string, any]>
}

/**
 * Build an AI binding mock. `responder` receives the call index (0 = analysis,
 * 1 = rewrite) so a single mock can return different payloads per call.
 */
export function fakeAI(responder: (callIndex: number, model: string, opts: any) => any): AIMock {
  const calls: Array<[string, any]> = []
  return {
    calls,
    async run(model, opts) {
      const i = calls.length
      calls.push([model, opts])
      const out = responder(i, model, opts)
      if (out instanceof Error) throw out
      return out
    },
  }
}

/** AI mock that returns a well-formed analysis for the first call. */
export function analysisAI(payload: unknown = { score: 7, anti_patterns: [], strengths: [] }): AIMock {
  return fakeAI((i) => {
    if (i === 0) return { response: typeof payload === 'string' ? payload : JSON.stringify(payload) }
    // Subsequent calls (rewrite) return plain text.
    return { response: 'REWRITTEN PROMPT' }
  })
}

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AI: analysisAI(),
    ASSETS: { fetch: async () => new Response('asset-body', { status: 200 }) } as unknown as Fetcher,
    RATE_KV: fakeKV() as unknown as KVNamespace,
    SHARE_KV: fakeKV() as unknown as KVNamespace,
    PROMPTSCOPE_PRO_TOKENS: fakeKV() as unknown as KVNamespace,
    ...overrides,
  } as Env
}

export interface FetchStub {
  restore(): void
  calls: Array<{ url: string; init?: RequestInit }>
}

/**
 * Replace global fetch with a stub. `handler` returns a Response, a thrown
 * Error (to simulate a network failure), or a plain object (wrapped as JSON).
 */
export function stubFetch(handler: (url: string, init?: RequestInit) => Response | Error | object): FetchStub {
  const original = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url
    calls.push({ url, init })
    const out = handler(url, init)
    if (out instanceof Error) throw out
    if (out instanceof Response) return out
    return Response.json(out)
  }) as typeof fetch
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

/** Construct a POST Request with a JSON body. */
export function jsonReq(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}
