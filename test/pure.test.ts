import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  approxTokens,
  tryParseJson,
  upgradeUrl,
  upgradeHref,
  normalizeLicenseKey,
  licenseKeyFromRequest,
  sha256Hex,
  configuredIds,
  idAllowed,
  licenseScopeError,
  licenseExpired,
  publicLicense,
  newId,
  type Env,
} from '../src/index.ts'
import { makeEnv } from './helpers.ts'

test('approxTokens rounds up at ~4 chars/token', () => {
  assert.equal(approxTokens(''), 0)
  assert.equal(approxTokens('a'), 1)
  assert.equal(approxTokens('abcd'), 1)
  assert.equal(approxTokens('abcde'), 2)
  assert.equal(approxTokens('a'.repeat(400)), 100)
})

test('tryParseJson handles strings, objects, fences, and junk', () => {
  assert.deepEqual(tryParseJson('{"a":1}'), { a: 1 })
  // Already-parsed objects pass through untouched.
  const obj = { score: 5 }
  assert.equal(tryParseJson(obj), obj)
  // Strips ```json fences.
  assert.deepEqual(tryParseJson('```json\n{"b":2}\n```'), { b: 2 })
  assert.deepEqual(tryParseJson('```json {"c":3} ```'), { c: 3 })
  // Invalid input returns null rather than throwing.
  assert.equal(tryParseJson('not json'), null)
  assert.equal(tryParseJson(null), null)
  assert.equal(tryParseJson(undefined), null)
})

test('tryParseJson coerces non-string primitives via String()', () => {
  assert.equal(tryParseJson(42), 42 as unknown) // String(42) -> "42" -> 42
  assert.equal(tryParseJson(true), true as unknown) // String(true) -> "true" -> true
  assert.equal(tryParseJson(NaN), null) // String(NaN) -> "NaN" -> parse error
})

test('upgradeUrl requires a trimmed https URL', () => {
  assert.equal(upgradeUrl({} as Env), undefined)
  assert.equal(upgradeUrl({ LEMONSQUEEZY_CHECKOUT_URL: '   ' } as Env), undefined)
  assert.equal(upgradeUrl({ LEMONSQUEEZY_CHECKOUT_URL: 'http://insecure.test' } as Env), undefined)
  assert.equal(upgradeUrl({ LEMONSQUEEZY_CHECKOUT_URL: 'ftp://x' } as Env), undefined)
  assert.equal(
    upgradeUrl({ LEMONSQUEEZY_CHECKOUT_URL: '  https://store.test/buy  ' } as Env),
    'https://store.test/buy',
  )
})

test('upgradeHref falls back to /api/checkout', () => {
  assert.equal(upgradeHref({} as Env), '/api/checkout')
  assert.equal(upgradeHref({ LEMONSQUEEZY_CHECKOUT_URL: 'https://s.test/buy' } as Env), 'https://s.test/buy')
})

test('normalizeLicenseKey trims and rejects non-strings/empties', () => {
  assert.equal(normalizeLicenseKey('  KEY-123  '), 'KEY-123')
  assert.equal(normalizeLicenseKey(''), undefined)
  assert.equal(normalizeLicenseKey('   '), undefined)
  assert.equal(normalizeLicenseKey(123), undefined)
  assert.equal(normalizeLicenseKey(null), undefined)
  assert.equal(normalizeLicenseKey(undefined), undefined)
})

test('licenseKeyFromRequest prefers headers in order, then body fields', () => {
  const h = (headers: Record<string, string>) => new Request('https://x.test', { headers })
  assert.equal(
    licenseKeyFromRequest(h({ 'x-promptscope-license': 'A' })),
    'A',
  )
  // Header precedence: license > key > token.
  assert.equal(
    licenseKeyFromRequest(h({ 'x-promptscope-key': 'B', 'x-promptscope-token': 'C' })),
    'B',
  )
  assert.equal(
    licenseKeyFromRequest(h({ 'x-promptscope-token': 'C' })),
    'C',
  )
  // Falls back to body.license_key then body.licenseKey.
  assert.equal(licenseKeyFromRequest(h({}), { license_key: ' D ' }), 'D')
  assert.equal(licenseKeyFromRequest(h({}), { licenseKey: 'E' }), 'E')
  assert.equal(licenseKeyFromRequest(h({}), {}), undefined)
})

test('sha256Hex returns a stable lowercase 64-char hex digest', async () => {
  const hex = await sha256Hex('abc')
  assert.equal(hex, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.match(hex, /^[0-9a-f]{64}$/)
  // Deterministic.
  assert.equal(await sha256Hex('abc'), hex)
  assert.notEqual(await sha256Hex('abd'), hex)
})

test('configuredIds merges primary + CSV, splitting on commas/whitespace', () => {
  assert.deepEqual([...configuredIds(undefined, undefined)], [])
  assert.deepEqual([...configuredIds('111', undefined)], ['111'])
  assert.deepEqual([...configuredIds('111', '222, 333  444')].sort(), ['111', '222', '333', '444'])
  // Blank fragments are dropped.
  assert.deepEqual([...configuredIds('', ' , , ')], [])
})

test('idAllowed: empty allow-set permits anything; otherwise membership by string', () => {
  assert.equal(idAllowed(5, new Set()), true)
  assert.equal(idAllowed(undefined, new Set()), true)
  assert.equal(idAllowed(undefined, new Set(['1'])), false)
  assert.equal(idAllowed(1, new Set(['1'])), true) // number coerced to "1"
  assert.equal(idAllowed('1', new Set(['1'])), true)
  assert.equal(idAllowed(2, new Set(['1'])), false)
})

test('licenseScopeError flags product/variant mismatches', () => {
  const env = makeEnv({ LEMONSQUEEZY_PRODUCT_ID: '100', LEMONSQUEEZY_VARIANT_ID: '200' })
  assert.equal(licenseScopeError({ meta: { product_id: 100, variant_id: 200 } }, env), undefined)
  assert.equal(
    licenseScopeError({ meta: { product_id: 999, variant_id: 200 } }, env),
    'license is for a different product',
  )
  assert.equal(
    licenseScopeError({ meta: { product_id: 100, variant_id: 999 } }, env),
    'license is for a different plan',
  )
  // No configured IDs => no scope restriction.
  assert.equal(licenseScopeError({ meta: { product_id: 1, variant_id: 2 } }, makeEnv()), undefined)
})

test('licenseExpired: only past, finite timestamps count as expired', () => {
  assert.equal(licenseExpired(null), false)
  assert.equal(licenseExpired(undefined), false)
  assert.equal(licenseExpired(''), false)
  assert.equal(licenseExpired('not-a-date'), false)
  assert.equal(licenseExpired('2000-01-01T00:00:00Z'), true)
  assert.equal(licenseExpired('2999-01-01T00:00:00Z'), false)
})

test('publicLicense shapes the user-facing license object', () => {
  // Free, no error => omitted entirely.
  assert.equal(publicLicense({ isPro: false }), undefined)
  // Free with error => invalid marker.
  assert.deepEqual(publicLicense({ isPro: false, error: 'nope' }), { valid: false, error: 'nope' })
  // Pro => full detail.
  assert.deepEqual(
    publicLicense({
      isPro: true,
      status: 'active',
      expiresAt: null,
      productName: 'Pro',
      variantName: 'Annual',
      source: 'cache',
    }),
    {
      valid: true,
      status: 'active',
      expires_at: null,
      product_name: 'Pro',
      variant_name: 'Annual',
      source: 'cache',
    },
  )
})

test('newId produces distinct URL-safe ids without padding', () => {
  const a = newId()
  const b = newId()
  assert.notEqual(a, b)
  assert.match(a, /^[A-Za-z0-9_-]+$/)
  assert.ok(!a.includes('='))
  assert.ok(!a.includes('+'))
  assert.ok(!a.includes('/'))
})
