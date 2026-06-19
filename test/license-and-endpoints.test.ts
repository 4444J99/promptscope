/**
 * Integration coverage for the license, checkout, validation and error paths
 * that surround the core analyze flow.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHarness,
  jsonPost,
  VALID_LICENSE_KEY,
  CHECKOUT_URL,
} from './harness.ts';
import type { Harness } from './harness.ts';

let h: Harness;

beforeEach(() => { h = createHarness(); });
afterEach(() => { h.restore(); });

describe('license endpoint', () => {
  it('accepts a valid Lemon Squeezy license', async () => {
    const res = await h.fetch('/api/license', jsonPost({ license_key: VALID_LICENSE_KEY }));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.valid, true);
    assert.equal(data.plan, 'pro');
    assert.equal(data.license.valid, true);
    assert.equal(data.license.variant_name, 'Monthly');
  });

  it('rejects an unknown license with 401 and an error reason', async () => {
    const res = await h.fetch('/api/license', jsonPost({ license_key: 'NOPE' }));
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.valid, false);
    assert.equal(data.plan, 'free');
    assert.match(data.license.error, /not found/i);
  });

  it('caches a validated license so repeat checks skip the upstream call', async () => {
    const first = await h.fetch('/api/license', jsonPost({ license_key: VALID_LICENSE_KEY }));
    assert.equal((await first.json()).license.source, 'lemonsqueezy');

    const second = await h.fetch('/api/license', jsonPost({ license_key: VALID_LICENSE_KEY }));
    assert.equal((await second.json()).license.source, 'cache');

    // Only the first validation reached Lemon Squeezy.
    assert.equal(h.lemonCalls.length, 1);
  });

  it('rejects a license scoped to a different product', async () => {
    const scoped = createHarness({ productId: '12345' }); // sample license reports product_id 42
    try {
      const res = await scoped.fetch('/api/license', jsonPost({ license_key: VALID_LICENSE_KEY }));
      assert.equal(res.status, 401);
      assert.match((await res.json()).license.error, /different product/i);
    } finally {
      scoped.restore();
    }
  });
});

describe('checkout endpoint', () => {
  it('303-redirects to the configured checkout URL on GET', async () => {
    const res = await h.fetch('/api/checkout');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), CHECKOUT_URL);
  });

  it('returns the checkout URL as JSON on POST', async () => {
    const res = await h.fetch('/api/checkout', { method: 'POST' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.checkout_url, CHECKOUT_URL);
    assert.equal(data.upgrade_url, CHECKOUT_URL);
  });

  it('reports 503 when no checkout URL is configured', async () => {
    const noCheckout = createHarness({ checkoutUrl: null });
    try {
      const res = await noCheckout.fetch('/api/checkout');
      assert.equal(res.status, 503);
      assert.equal((await res.json()).required_var, 'LEMONSQUEEZY_CHECKOUT_URL');
    } finally {
      noCheckout.restore();
    }
  });
});

describe('api index', () => {
  it('describes the available endpoints', async () => {
    const res = await h.fetch('/api');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.name, 'PromptScope API');
    assert.equal(data.endpoints.analyze, 'POST /api/analyze');
    assert.equal(data.upgrade_url, CHECKOUT_URL);
  });
});

describe('static asset passthrough', () => {
  it('forwards non-/api routes to the ASSETS binding', async () => {
    const res = await h.fetch('/index.html');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'asset:/index.html');
  });
});

describe('analyze validation and failure handling', () => {
  it('rejects a missing prompt with 400', async () => {
    const res = await h.fetch('/api/analyze', jsonPost({}));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /missing prompt/i);
  });

  it('rejects invalid JSON with 400', async () => {
    const res = await h.fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /invalid json/i);
  });

  it('rejects an oversized prompt with 400', async () => {
    const res = await h.fetch('/api/analyze', jsonPost({ prompt: 'x'.repeat(32_001) }));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /exceeds/i);
  });

  it('returns 502 when the model emits unparseable output', async () => {
    const bad = createHarness({ ai: { analyzeResponse: 'this is not json at all' } });
    try {
      const res = await bad.fetch('/api/analyze', jsonPost({ prompt: 'hello' }));
      assert.equal(res.status, 502);
      assert.match((await res.json()).error, /malformed/i);
    } finally {
      bad.restore();
    }
  });

  it('returns 500 when inference throws', async () => {
    const down = createHarness({ ai: { fail: true } });
    try {
      const res = await down.fetch('/api/analyze', jsonPost({ prompt: 'hello' }));
      assert.equal(res.status, 500);
      assert.match((await res.json()).error, /inference failed/i);
    } finally {
      down.restore();
    }
  });

  it('falls back to basic analysis (no rewrite) when an invalid license is supplied', async () => {
    const res = await h.fetch(
      '/api/analyze',
      jsonPost({ prompt: 'hello' }, { 'x-promptscope-license': 'BOGUS' }),
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.plan, 'free');
    assert.equal(data.suggested_rewrite, undefined);
    assert.match(data.license_error, /not found/i);
    assert.equal(data.quota_remaining, 4);
  });
});
