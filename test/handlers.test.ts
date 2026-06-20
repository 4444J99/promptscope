import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  handleAnalyze,
  handleLicense,
  handleShare,
  handleCheckout,
  handleApiIndex,
  MAX_PROMPT_CHARS,
  FREE_DAILY_LIMIT,
  SHARE_TTL_SECONDS,
} from '../src/index.ts'
import { makeEnv, fakeKV, fakeAI, analysisAI, stubFetch, jsonReq, type FakeKV } from './helpers.ts'

const VALID_LICENSE = {
  valid: true,
  license_key: { status: 'active', expires_at: null },
  meta: { product_name: 'Pro', variant_name: 'Lifetime' },
}

// ---------------------------------------------------------------------------
// handleAnalyze
// ---------------------------------------------------------------------------

test('GET /api/analyze returns the self-describing manifest', async () => {
  const res = await handleAnalyze(new Request('https://x.test/api/analyze'), makeEnv())
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.method, 'POST /api/analyze')
  assert.deepEqual(body.advanced_features, ['suggested_rewrite'])
  assert.equal(body.upgrade_url, '/api/checkout')
})

test('analyze rejects unsupported methods', async () => {
  const res = await handleAnalyze(new Request('https://x.test/api/analyze', { method: 'DELETE' }), makeEnv())
  assert.equal(res.status, 405)
})

test('analyze rejects invalid JSON, missing prompt, and oversized prompt', async () => {
  const bad = new Request('https://x.test/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  assert.equal((await handleAnalyze(bad, makeEnv())).status, 400)

  const missing = await handleAnalyze(jsonReq('https://x.test/api/analyze', {}), makeEnv())
  assert.equal(missing.status, 400)
  assert.equal((await missing.json()).error, 'missing prompt')

  const huge = await handleAnalyze(
    jsonReq('https://x.test/api/analyze', { prompt: 'a'.repeat(MAX_PROMPT_CHARS + 1) }),
    makeEnv(),
  )
  assert.equal(huge.status, 400)
  assert.match((await huge.json()).error, /exceeds/)
})

test('analyze (free) returns a clamped score, counts, free plan, and quota', async () => {
  const env = makeEnv({ AI: analysisAI({ score: 42, anti_patterns: [{ name: 'x', fix: 'y' }], strengths: ['good'] }) })
  const res = await handleAnalyze(jsonReq('https://x.test/api/analyze', { prompt: 'hello world' }), env)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.score, 10, 'score is clamped into 0..10')
  assert.equal(body.plan, 'free')
  assert.equal(body.char_count, 'hello world'.length)
  assert.equal(body.token_count, Math.ceil('hello world'.length / 4))
  assert.equal(body.quota_remaining, FREE_DAILY_LIMIT - 1)
  assert.equal(body.advanced_features.suggested_rewrite.locked, true)
  assert.equal(body.advanced_features.suggested_rewrite.upgrade_url, '/api/checkout')
  assert.equal(body.suggested_rewrite, undefined)
})

test('analyze truncates anti_patterns to 12 and strengths to 8', async () => {
  const env = makeEnv({
    AI: analysisAI({
      score: 5,
      anti_patterns: Array.from({ length: 20 }, (_, i) => ({ name: `n${i}`, fix: 'f' })),
      strengths: Array.from({ length: 20 }, (_, i) => `s${i}`),
    }),
  })
  const body = await (await handleAnalyze(jsonReq('https://x.test/api/analyze', { prompt: 'p' }), env)).json()
  assert.equal(body.anti_patterns.length, 12)
  assert.equal(body.strengths.length, 8)
})

test('analyze returns 502 when the model output is malformed', async () => {
  const env = makeEnv({ AI: analysisAI('totally not json') })
  const res = await handleAnalyze(jsonReq('https://x.test/api/analyze', { prompt: 'p' }), env)
  assert.equal(res.status, 502)
  const body = await res.json()
  assert.equal(body.error, 'analysis output malformed')
  assert.equal(body.raw_type, 'string')
})

test('analyze returns 502 when score is missing/non-numeric', async () => {
  const env = makeEnv({ AI: analysisAI({ anti_patterns: [], strengths: [] }) })
  const res = await handleAnalyze(jsonReq('https://x.test/api/analyze', { prompt: 'p' }), env)
  assert.equal(res.status, 502)
})

test('analyze returns 500 when inference throws', async () => {
  const env = makeEnv({
    AI: fakeAI(() => new Error('model offline')),
  })
  const res = await handleAnalyze(jsonReq('https://x.test/api/analyze', { prompt: 'p' }), env)
  assert.equal(res.status, 500)
  assert.match((await res.json()).error, /inference failed: model offline/)
})

test('analyze (free) returns 429 once the daily quota is exhausted', async () => {
  const rate = fakeKV()
  const today = new Date().toISOString().slice(0, 10)
  rate.store.set(`rl:ip:9.9.9.9:${today}`, { value: String(FREE_DAILY_LIMIT) })
  const env = makeEnv({ RATE_KV: rate as unknown as KVNamespace })
  const req = jsonReq('https://x.test/api/analyze', { prompt: 'p' }, { 'cf-connecting-ip': '9.9.9.9' })
  const res = await handleAnalyze(req, env)
  assert.equal(res.status, 429)
  assert.match((await res.json()).error, /quota exhausted/)
})

test('analyze (pro) bypasses rate limiting and includes a suggested_rewrite', async () => {
  // Quota already exhausted; a pro license must still succeed.
  const rate = fakeKV()
  const today = new Date().toISOString().slice(0, 10)
  rate.store.set(`rl:1.1.1.1:${today}`, { value: String(FREE_DAILY_LIMIT) })
  const env = makeEnv({ RATE_KV: rate as unknown as KVNamespace })
  const fetch = stubFetch(() => VALID_LICENSE)
  try {
    const req = jsonReq(
      'https://x.test/api/analyze',
      { prompt: 'my system prompt' },
      { 'cf-connecting-ip': '1.1.1.1', 'x-promptscope-license': 'KEY-pro' },
    )
    const res = await handleAnalyze(req, env)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.plan, 'pro')
    assert.equal(body.suggested_rewrite, 'REWRITTEN PROMPT')
    assert.equal(body.advanced_features.suggested_rewrite.locked, false)
    assert.equal(body.quota_remaining, undefined, 'pro responses omit quota')
    assert.equal(body.license.valid, true)
  } finally {
    fetch.restore()
  }
})

test('analyze (pro) reports rewrite_error when the rewrite call fails', async () => {
  const env = makeEnv({
    AI: fakeAI((i) => {
      if (i === 0) return { response: JSON.stringify({ score: 8, anti_patterns: [], strengths: [] }) }
      return new Error('rewrite model down')
    }),
  })
  const fetch = stubFetch(() => VALID_LICENSE)
  try {
    const req = jsonReq('https://x.test/api/analyze', { prompt: 'p' }, { 'x-promptscope-license': 'KEY-pro' })
    const body = await (await handleAnalyze(req, env)).json()
    assert.equal(body.plan, 'pro')
    assert.equal(body.rewrite_error, 'rewrite unavailable')
    assert.equal(body.suggested_rewrite, undefined)
  } finally {
    fetch.restore()
  }
})

test('analyze surfaces a license_error for an invalid key while still serving free tier', async () => {
  const fetch = stubFetch(() => ({ valid: false, error: 'key not found' }))
  try {
    const req = jsonReq('https://x.test/api/analyze', { prompt: 'p' }, { 'x-promptscope-license': 'BAD' })
    const res = await handleAnalyze(req, makeEnv())
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.plan, 'free')
    assert.equal(body.license_error, 'key not found')
    assert.equal(body.license.valid, false)
  } finally {
    fetch.restore()
  }
})

// ---------------------------------------------------------------------------
// handleLicense
// ---------------------------------------------------------------------------

test('GET /api/license documents the contract', async () => {
  const body = await (await handleLicense(new Request('https://x.test/api/license'), makeEnv())).json()
  assert.equal(body.auth_header, 'x-promptscope-license')
  assert.equal(body.body_field, 'license_key')
})

test('license POST rejects non-POST and invalid JSON', async () => {
  const put = await handleLicense(new Request('https://x.test/api/license', { method: 'PUT' }), makeEnv())
  assert.equal(put.status, 405)

  const bad = new Request('https://x.test/api/license', { method: 'POST', body: '{bad' })
  const res = await handleLicense(bad, makeEnv())
  assert.equal(res.status, 400)
})

test('license POST returns 200/pro for a valid key and 401/free for an invalid one', async () => {
  let fetch = stubFetch(() => VALID_LICENSE)
  const ok = await handleLicense(jsonReq('https://x.test/api/license', { license_key: 'GOOD' }), makeEnv())
  assert.equal(ok.status, 200)
  const okBody = await ok.json()
  assert.equal(okBody.valid, true)
  assert.equal(okBody.plan, 'pro')
  fetch.restore()

  fetch = stubFetch(() => ({ valid: false, error: 'nope' }))
  const bad = await handleLicense(jsonReq('https://x.test/api/license', { license_key: 'BAD' }), makeEnv())
  assert.equal(bad.status, 401)
  const badBody = await bad.json()
  assert.equal(badBody.valid, false)
  assert.equal(badBody.plan, 'free')
  fetch.restore()
})

// ---------------------------------------------------------------------------
// handleShare
// ---------------------------------------------------------------------------

test('share round-trips a prompt and sets the TTL', async () => {
  const env = makeEnv()
  const share = env.SHARE_KV as unknown as FakeKV
  const post = await handleShare(jsonReq('https://x.test/api/share', { prompt: 'shared text' }), env)
  assert.equal(post.status, 200)
  const { id, expires_in_seconds } = await post.json()
  assert.match(id, /^[A-Za-z0-9_-]+$/)
  assert.equal(expires_in_seconds, SHARE_TTL_SECONDS)
  assert.equal(share.store.get(id)!.ttl, SHARE_TTL_SECONDS)

  const get = await handleShare(new Request(`https://x.test/api/share?id=${id}`), env)
  assert.equal(get.status, 200)
  assert.deepEqual(await get.json(), { id, prompt: 'shared text' })
})

test('share POST validates the prompt', async () => {
  const env = makeEnv()
  assert.equal((await handleShare(new Request('https://x.test/api/share', { method: 'POST', body: '{' }), env)).status, 400)
  assert.equal((await handleShare(jsonReq('https://x.test/api/share', {}), env)).status, 400)
  const huge = await handleShare(jsonReq('https://x.test/api/share', { prompt: 'a'.repeat(MAX_PROMPT_CHARS + 1) }), env)
  assert.equal(huge.status, 400)
})

test('share GET rejects bad ids and reports misses', async () => {
  const env = makeEnv()
  // Missing id.
  assert.equal((await handleShare(new Request('https://x.test/api/share'), env)).status, 400)
  // Illegal characters.
  assert.equal((await handleShare(new Request('https://x.test/api/share?id=../etc'), env)).status, 400)
  // Well-formed but absent.
  const miss = await handleShare(new Request('https://x.test/api/share?id=missing123'), env)
  assert.equal(miss.status, 404)
})

test('share rejects unsupported methods', async () => {
  const res = await handleShare(new Request('https://x.test/api/share', { method: 'PUT' }), makeEnv())
  assert.equal(res.status, 405)
})

// ---------------------------------------------------------------------------
// handleCheckout & handleApiIndex
// ---------------------------------------------------------------------------

test('checkout returns 503 when no upgrade URL is configured', async () => {
  const res = await handleCheckout(new Request('https://x.test/api/checkout'), makeEnv())
  assert.equal(res.status, 503)
  assert.equal((await res.json()).required_var, 'LEMONSQUEEZY_CHECKOUT_URL')
})

test('checkout GET redirects and POST returns the URL when configured', async () => {
  const env = makeEnv({ LEMONSQUEEZY_CHECKOUT_URL: 'https://store.test/buy/pro' })
  const get = await handleCheckout(new Request('https://x.test/api/checkout'), env)
  assert.equal(get.status, 303)
  assert.equal(get.headers.get('location'), 'https://store.test/buy/pro')

  const post = await handleCheckout(new Request('https://x.test/api/checkout', { method: 'POST' }), env)
  assert.equal(post.status, 200)
  assert.deepEqual(await post.json(), {
    checkout_url: 'https://store.test/buy/pro',
    upgrade_url: 'https://store.test/buy/pro',
  })

  const put = await handleCheckout(new Request('https://x.test/api/checkout', { method: 'PUT' }), env)
  assert.equal(put.status, 405)
})

test('checkout POST creates a Lemon Squeezy checkout when API config is present', async () => {
  const env = makeEnv({
    LEMONSQUEEZY_API_KEY: 'lmsq_secret',
    LEMONSQUEEZY_STORE_ID: '10',
    LEMONSQUEEZY_VARIANT_ID: '20',
    LEMONSQUEEZY_CHECKOUT_REDIRECT_URL: 'https://promptscope.test/checkout/success',
    LEMONSQUEEZY_TEST_MODE: 'true',
  })
  const fetch = stubFetch((url, init) => {
    assert.equal(url, 'https://api.lemonsqueezy.com/v1/checkouts')
    assert.equal(init?.method, 'POST')
    const headers = new Headers(init?.headers as HeadersInit)
    assert.equal(headers.get('authorization'), 'Bearer lmsq_secret')
    assert.equal(headers.get('accept'), 'application/vnd.api+json')
    assert.equal(headers.get('content-type'), 'application/vnd.api+json')

    const payload = JSON.parse(String(init?.body))
    assert.equal(payload.data.type, 'checkouts')
    assert.equal(payload.data.relationships.store.data.id, '10')
    assert.equal(payload.data.relationships.variant.data.id, '20')
    assert.equal(payload.data.attributes.product_options.redirect_url, 'https://promptscope.test/checkout/success')
    assert.deepEqual(payload.data.attributes.product_options.enabled_variants, [20])
    assert.equal(payload.data.attributes.checkout_data.email, 'buyer@example.com')
    assert.equal(payload.data.attributes.checkout_data.discount_code, 'SAVE10')
    assert.deepEqual(payload.data.attributes.checkout_data.custom, { app: 'promptscope' })
    assert.equal(payload.data.attributes.test_mode, true)

    return { data: { attributes: { url: 'https://store.test/checkout/custom/abc' } } }
  })
  try {
    const res = await handleCheckout(jsonReq('https://x.test/api/checkout', {
      email: 'buyer@example.com',
      discount_code: 'SAVE10',
    }), env)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), {
      checkout_url: 'https://store.test/checkout/custom/abc',
      upgrade_url: 'https://store.test/checkout/custom/abc',
      provider: 'lemonsqueezy',
      mode: 'dynamic',
    })
  } finally {
    fetch.restore()
  }
})

test('checkout GET redirects to a dynamically created Lemon Squeezy checkout', async () => {
  const env = makeEnv({
    LEMONSQUEEZY_API_KEY: 'lmsq_secret',
    LEMONSQUEEZY_STORE_ID: '10',
    LEMONSQUEEZY_VARIANT_ID: '20',
  })
  const fetch = stubFetch(() => ({ data: { attributes: { url: 'https://store.test/checkout/custom/get' } } }))
  try {
    const res = await handleCheckout(new Request('https://promptscope.test/api/checkout'), env)
    assert.equal(res.status, 303)
    assert.equal(res.headers.get('location'), 'https://store.test/checkout/custom/get')
  } finally {
    fetch.restore()
  }
})

test('checkout surfaces Lemon Squeezy checkout creation errors without leaking secrets', async () => {
  const env = makeEnv({
    LEMONSQUEEZY_API_KEY: 'lmsq_secret',
    LEMONSQUEEZY_STORE_ID: '10',
    LEMONSQUEEZY_VARIANT_ID: '20',
  })
  const fetch = stubFetch(() => Response.json({
    errors: [{ detail: 'Variant does not exist.' }],
  }, { status: 422 }))
  try {
    const res = await handleCheckout(new Request('https://x.test/api/checkout'), env)
    assert.equal(res.status, 422)
    const body = await res.json()
    assert.equal(body.error, 'Variant does not exist.')
    assert.equal(JSON.stringify(body).includes('lmsq_secret'), false)
  } finally {
    fetch.restore()
  }
})

test('handleApiIndex lists the endpoints and upgrade URL', async () => {
  const body = await handleApiIndex(makeEnv({ LEMONSQUEEZY_CHECKOUT_URL: 'https://s.test/buy' })).json()
  assert.equal(body.name, 'PromptScope API')
  assert.equal(body.endpoints.analyze, 'POST /api/analyze')
  assert.equal(body.upgrade_url, 'https://s.test/buy')
})
