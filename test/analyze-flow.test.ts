/**
 * End-to-end coverage of the primary user journey:
 *
 *   free user analyzes a prompt → uses up the daily quota → gets a share link
 *   → upgrades with a Pro license → analyzes again and receives a rewrite.
 *
 * Each test drives the real Worker entrypoint through the harness, so routing,
 * validation, rate limiting, KV persistence and the AI/license integrations are
 * all exercised together rather than in isolation.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHarness,
  jsonPost,
  SAMPLE_ANALYSIS,
  VALID_LICENSE_KEY,
  CHECKOUT_URL,
} from './harness.ts';
import type { Harness } from './harness.ts';

let h: Harness;

beforeEach(() => { h = createHarness(); });
afterEach(() => { h.restore(); });

const PROMPT = 'You are a helpful assistant. Be helpful and use good judgment.';

describe('main user flow', () => {
  it('analyzes a prompt as a free user and returns a structured, locked-rewrite result', async () => {
    const res = await h.fetch('/api/analyze', jsonPost({ prompt: PROMPT }));
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.plan, 'free');
    assert.equal(data.score, SAMPLE_ANALYSIS.score);
    assert.deepEqual(data.anti_patterns, SAMPLE_ANALYSIS.anti_patterns);
    assert.deepEqual(data.strengths, SAMPLE_ANALYSIS.strengths);
    assert.equal(data.char_count, PROMPT.length);
    assert.ok(data.token_count > 0);

    // Free tier: rewrite is locked behind an upgrade and quota is decremented.
    assert.equal(data.suggested_rewrite, undefined);
    assert.equal(data.advanced_features.suggested_rewrite.locked, true);
    assert.equal(data.advanced_features.suggested_rewrite.upgrade_url, CHECKOUT_URL);
    assert.equal(data.quota_remaining, 4);

    // Only the analyze model call happened — no rewrite for free users.
    assert.equal(h.ai.calls.length, 1);
  });

  it('decrements quota across requests and blocks the 6th free analysis', async () => {
    const remaining: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await h.fetch('/api/analyze', jsonPost({ prompt: PROMPT }));
      assert.equal(res.status, 200);
      remaining.push((await res.json()).quota_remaining);
    }
    assert.deepEqual(remaining, [4, 3, 2, 1, 0]);

    const blocked = await h.fetch('/api/analyze', jsonPost({ prompt: PROMPT }));
    assert.equal(blocked.status, 429);
    const data = await blocked.json();
    assert.match(data.error, /quota exhausted/i);
    assert.equal(data.upgrade_url, CHECKOUT_URL);
  });

  it('rate limits per IP, so a different IP is unaffected', async () => {
    for (let i = 0; i < 5; i++) {
      await h.fetch('/api/analyze', jsonPost({ prompt: PROMPT }));
    }
    const blocked = await h.fetch('/api/analyze', jsonPost({ prompt: PROMPT }));
    assert.equal(blocked.status, 429);

    const other = await h.fetch('/api/analyze', { ...jsonPost({ prompt: PROMPT }), ip: '198.51.100.22' });
    assert.equal(other.status, 200);
  });

  it('round-trips a share link: POST stores the prompt, GET retrieves it', async () => {
    const created = await h.fetch('/api/share', jsonPost({ prompt: PROMPT }));
    assert.equal(created.status, 200);
    const { id, expires_in_seconds } = await created.json();
    assert.match(id, /^[a-zA-Z0-9_-]+$/);
    assert.ok(expires_in_seconds > 0);

    const fetched = await h.fetch(`/api/share?id=${id}`);
    assert.equal(fetched.status, 200);
    const body = await fetched.json();
    assert.equal(body.id, id);
    assert.equal(body.prompt, PROMPT);
  });

  it('upgrades to Pro and returns a suggested rewrite with no quota limit', async () => {
    const res = await h.fetch(
      '/api/analyze',
      jsonPost({ prompt: PROMPT }, { 'x-promptscope-license': VALID_LICENSE_KEY }),
    );
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.equal(data.plan, 'pro');
    assert.equal(data.suggested_rewrite, 'Rewritten, tighter system prompt.');
    assert.equal(data.advanced_features.suggested_rewrite.locked, false);
    assert.equal(data.quota_remaining, undefined);
    assert.equal(data.license.valid, true);
    assert.equal(data.license.product_name, 'PromptScope Pro');

    // Pro path issues both the analyze and the rewrite model calls.
    assert.equal(h.ai.calls.length, 2);
  });

  it('lets a Pro user exceed the free daily limit', async () => {
    const proInit = () => jsonPost({ prompt: PROMPT }, { 'x-promptscope-license': VALID_LICENSE_KEY });
    for (let i = 0; i < 8; i++) {
      const res = await h.fetch('/api/analyze', proInit());
      assert.equal(res.status, 200);
      assert.equal((await res.json()).plan, 'pro');
    }
  });
});
