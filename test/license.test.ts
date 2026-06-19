import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateLemonLicense,
  readCachedLicense,
  cacheLicense,
  rateCheck,
  sha256Hex,
  FREE_DAILY_LIMIT,
  MAX_LICENSE_KEY_CHARS,
  LICENSE_CACHE_TTL_SECONDS,
} from '../src/index.ts'
import { makeEnv, fakeKV, stubFetch, type FakeKV } from './helpers.ts'

const VALID_BODY = {
  valid: true,
  license_key: { status: 'active', expires_at: null },
  meta: { product_name: 'PromptScope Pro', variant_name: 'Lifetime', product_id: 1, variant_id: 2 },
}

test('validateLemonLicense returns free for missing key without calling fetch', async () => {
  const fetch = stubFetch(() => new Error('should not be called'))
  try {
    const res = await validateLemonLicense(undefined, makeEnv())
    assert.deepEqual(res, { isPro: false })
    assert.equal(fetch.calls.length, 0)
  } finally {
    fetch.restore()
  }
})

test('validateLemonLicense rejects over-long keys before any network call', async () => {
  const fetch = stubFetch(() => new Error('should not be called'))
  try {
    const res = await validateLemonLicense('x'.repeat(MAX_LICENSE_KEY_CHARS + 1), makeEnv())
    assert.equal(res.isPro, false)
    assert.equal(res.error, 'license key is too long')
    assert.equal(fetch.calls.length, 0)
  } finally {
    fetch.restore()
  }
})

test('validateLemonLicense accepts a valid license and caches it', async () => {
  const kv = fakeKV()
  const env = makeEnv({ PROMPTSCOPE_PRO_TOKENS: kv as unknown as KVNamespace })
  const fetch = stubFetch((url, init) => {
    assert.equal(url, 'https://api.lemonsqueezy.com/v1/licenses/validate')
    assert.equal(init?.method, 'POST')
    // Form-encoded license_key is sent in the body.
    assert.match(String(init?.body), /license_key=KEY-abc/)
    return VALID_BODY
  })
  try {
    const res = await validateLemonLicense('KEY-abc', env)
    assert.equal(res.isPro, true)
    assert.equal(res.status, 'active')
    assert.equal(res.productName, 'PromptScope Pro')
    assert.equal(res.variantName, 'Lifetime')
    assert.equal(res.source, 'lemonsqueezy')
    // Cache populated under the hashed key.
    assert.equal(kv.puts, 1)
    const cacheKey = `ls:${await sha256Hex('KEY-abc')}`
    assert.ok(kv.store.has(cacheKey))
    assert.equal(kv.store.get(cacheKey)!.ttl, LICENSE_CACHE_TTL_SECONDS)
  } finally {
    fetch.restore()
  }
})

test('validateLemonLicense serves cached pro result without a second fetch', async () => {
  const kv = fakeKV()
  const env = makeEnv({ PROMPTSCOPE_PRO_TOKENS: kv as unknown as KVNamespace })
  let fetchCount = 0
  const fetch = stubFetch(() => {
    fetchCount++
    return VALID_BODY
  })
  try {
    await validateLemonLicense('KEY-abc', env)
    const second = await validateLemonLicense('KEY-abc', env)
    assert.equal(fetchCount, 1, 'second validation should hit cache, not network')
    assert.equal(second.isPro, true)
    assert.equal(second.source, 'cache')
  } finally {
    fetch.restore()
  }
})

test('validateLemonLicense surfaces invalid / non-ok / network failures', async () => {
  // Network throws.
  let fetch = stubFetch(() => new Error('boom'))
  assert.deepEqual(await validateLemonLicense('K', makeEnv()), {
    isPro: false,
    error: 'license check unavailable',
  })
  fetch.restore()

  // Non-2xx with error body.
  fetch = stubFetch(() => Response.json({ error: 'rate limited' }, { status: 429 }))
  assert.deepEqual(await validateLemonLicense('K', makeEnv()), { isPro: false, error: 'rate limited' })
  fetch.restore()

  // Non-2xx without parseable body falls back to status message.
  fetch = stubFetch(() => new Response('nope', { status: 500 }))
  assert.deepEqual(await validateLemonLicense('K', makeEnv()), {
    isPro: false,
    error: 'license check failed (500)',
  })
  fetch.restore()

  // 200 but valid:false.
  fetch = stubFetch(() => ({ valid: false, error: 'key not found' }))
  assert.deepEqual(await validateLemonLicense('K', makeEnv()), { isPro: false, error: 'key not found' })
  fetch.restore()
})

test('validateLemonLicense rejects disabled status and expired keys', async () => {
  let fetch = stubFetch(() => ({ valid: true, license_key: { status: 'disabled' } }))
  assert.deepEqual(await validateLemonLicense('K', makeEnv()), { isPro: false, error: 'license is disabled' })
  fetch.restore()

  fetch = stubFetch(() => ({
    valid: true,
    license_key: { status: 'active', expires_at: '2000-01-01T00:00:00Z' },
  }))
  assert.deepEqual(await validateLemonLicense('K', makeEnv()), { isPro: false, error: 'license is expired' })
  fetch.restore()
})

test('validateLemonLicense accepts inactive status (purchased, not yet activated)', async () => {
  const fetch = stubFetch(() => ({ valid: true, license_key: { status: 'inactive', expires_at: null } }))
  try {
    const res = await validateLemonLicense('K', makeEnv())
    assert.equal(res.isPro, true)
    assert.equal(res.status, 'inactive')
  } finally {
    fetch.restore()
  }
})

test('validateLemonLicense enforces product/variant scope', async () => {
  const env = makeEnv({ LEMONSQUEEZY_PRODUCT_ID: '1', LEMONSQUEEZY_VARIANT_ID: '999' })
  const fetch = stubFetch(() => VALID_BODY)
  try {
    const res = await validateLemonLicense('K', env)
    assert.equal(res.isPro, false)
    assert.equal(res.error, 'license is for a different plan')
  } finally {
    fetch.restore()
  }
})

test('validateLemonLicense tolerates a failing cache read (KV down) and still validates', async () => {
  const kv: FakeKV = {
    ...fakeKV(),
    async get() {
      throw new Error('kv read down')
    },
    async put() {
      throw new Error('kv write down')
    },
  }
  const env = makeEnv({ PROMPTSCOPE_PRO_TOKENS: kv as unknown as KVNamespace })
  const fetch = stubFetch(() => VALID_BODY)
  try {
    const res = await validateLemonLicense('K', env)
    assert.equal(res.isPro, true, 'KV failures must not block a valid license')
  } finally {
    fetch.restore()
  }
})

test('readCachedLicense ignores corrupt JSON and expired entries', async () => {
  const env = makeEnv()
  const kv = env.PROMPTSCOPE_PRO_TOKENS as unknown as FakeKV

  kv.store.set('corrupt', { value: 'not json' })
  assert.equal(await readCachedLicense(env, 'corrupt'), undefined)

  kv.store.set('expired', {
    value: JSON.stringify({ isPro: true, expiresAt: '2000-01-01T00:00:00Z' }),
  })
  assert.equal(await readCachedLicense(env, 'expired'), undefined)

  kv.store.set('good', { value: JSON.stringify({ isPro: true, expiresAt: null, status: 'active' }) })
  const hit = await readCachedLicense(env, 'good')
  assert.equal(hit?.isPro, true)
  assert.equal(hit?.source, 'cache')
})

test('cacheLicense skips non-pro and zero/negative TTLs', async () => {
  const env = makeEnv()
  const kv = env.PROMPTSCOPE_PRO_TOKENS as unknown as FakeKV

  await cacheLicense(env, 'k1', { isPro: false })
  assert.equal(kv.puts, 0, 'free access is never cached')

  // Already-expired expiry yields ttl <= 0 -> no write.
  await cacheLicense(env, 'k2', { isPro: true, expiresAt: '2000-01-01T00:00:00Z' })
  assert.equal(kv.puts, 0)

  // Far-future expiry is clamped to the cache TTL ceiling.
  await cacheLicense(env, 'k3', { isPro: true, expiresAt: '2999-01-01T00:00:00Z' })
  assert.equal(kv.puts, 1)
  assert.equal(kv.store.get('k3')!.ttl, LICENSE_CACHE_TTL_SECONDS)
})

test('rateCheck counts per IP/day and blocks past the free limit', async () => {
  const env = makeEnv()
  const results = []
  for (let i = 0; i < FREE_DAILY_LIMIT + 2; i++) {
    results.push(await rateCheck('1.2.3.4', env))
  }
  // First FREE_DAILY_LIMIT calls allowed with descending remaining.
  for (let i = 0; i < FREE_DAILY_LIMIT; i++) {
    assert.equal(results[i].allowed, true)
    assert.equal(results[i].remaining, FREE_DAILY_LIMIT - 1 - i)
  }
  // Beyond the limit: blocked, zero remaining.
  assert.deepEqual(results[FREE_DAILY_LIMIT], { allowed: false, remaining: 0 })
  assert.deepEqual(results[FREE_DAILY_LIMIT + 1], { allowed: false, remaining: 0 })
})

test('rateCheck isolates counts between distinct IPs', async () => {
  const env = makeEnv()
  await rateCheck('a', env)
  const other = await rateCheck('b', env)
  assert.equal(other.remaining, FREE_DAILY_LIMIT - 1)
})
