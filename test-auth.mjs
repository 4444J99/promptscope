// Integration test for the first-party API-key auth flow.
// Run: node test-auth.mjs   (Node >=23 strips the TS types in src/index.ts)
import worker from './src/index.ts';

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ok  -', msg); }
  else { failures++; console.error('  FAIL-', msg); }
}

// --- In-memory KV mock -----------------------------------------------------
function makeKV() {
  const store = new Map();
  return {
    async get(key) { const e = store.get(key); return e === undefined ? null : e; },
    async put(key, val) { store.set(key, val); },
    async delete(key) { store.delete(key); },
    async list({ prefix = '', cursor } = {}) {
      const keys = [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
    _store: store,
  };
}

function makeEnv(overrides = {}) {
  return {
    AI: {
      async run(_model, opts) {
        const sys = opts.messages?.[0]?.content ?? '';
        if (sys.includes('PromptScope')) {
          return { response: JSON.stringify({ score: 7, anti_patterns: [{ name: 'vague', fix: 'be specific' }], strengths: ['clear role'] }) };
        }
        return { response: 'REWRITTEN PROMPT' };
      },
    },
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) },
    RATE_KV: makeKV(),
    SHARE_KV: makeKV(),
    PROMPTSCOPE_PRO_TOKENS: makeKV(),
    ADMIN_TOKEN: 'admin-secret',
    ...overrides,
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = (env, path, init = {}) => worker.fetch(new Request('https://x' + path, init), env, ctx);
const json = (path, bodyObj, headers = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(bodyObj),
});

async function run() {
  // 1. Issue without admin token -> 401
  {
    const env = makeEnv();
    const r = await call(env, '/api/keys', json('/api/keys', { label: 'x' }));
    assert(r.status === 401, 'issue without admin -> 401');
  }

  // 2. Admin not configured -> 503
  {
    const env = makeEnv({ ADMIN_TOKEN: undefined });
    const r = await call(env, '/api/keys', json('/api/keys', {}, { Authorization: 'Bearer anything' }));
    assert(r.status === 503, 'unconfigured admin -> 503');
    const b = await r.json();
    assert(b.required_secret === 'ADMIN_TOKEN', '503 names ADMIN_TOKEN secret');
  }

  // 3. Issue with admin -> 201, returns psk_ key, never persists plaintext
  let issuedKey, issuedId;
  {
    const env = makeEnv();
    const r = await call(env, '/api/keys', json('/api/keys', { label: 'cli', plan: 'pro' }, { Authorization: 'Bearer admin-secret' }));
    assert(r.status === 201, 'issue with admin -> 201');
    const b = await r.json();
    issuedKey = b.api_key; issuedId = b.id;
    assert(typeof issuedKey === 'string' && issuedKey.startsWith('psk_'), 'returns psk_ key');
    assert(b.plan === 'pro', 'plan defaults/honored as pro');
    const stored = [...env.PROMPTSCOPE_PRO_TOKENS._store.values()].join('|');
    assert(!stored.includes(issuedKey), 'plaintext key is NOT stored in KV');

    // 4. List shows metadata, not plaintext
    const lr = await call(env, '/api/keys', { method: 'GET', headers: { Authorization: 'Bearer admin-secret' } });
    const lb = await lr.json();
    assert(lr.status === 200 && lb.keys.length === 1, 'list returns one key');
    assert(lb.keys[0].id === issuedId && !JSON.stringify(lb.keys[0]).includes(issuedKey), 'list omits plaintext');

    // 5. Analyze with the API key -> pro, advanced rewrite unlocked
    const ar = await call(env, '/api/analyze', json('/api/analyze', { prompt: 'You are a helpful bot.' }, { 'x-promptscope-api-key': issuedKey }));
    const ab = await ar.json();
    assert(ar.status === 200 && ab.plan === 'pro', 'api-key analyze -> pro plan');
    assert(ab.auth?.method === 'api_key' && ab.auth?.key_id === issuedId, 'response reports api_key auth');
    assert(ab.suggested_rewrite === 'REWRITTEN PROMPT', 'pro key unlocks suggested_rewrite');

    // 6. Bearer psk_ also works
    const ar2 = await call(env, '/api/analyze', json('/api/analyze', { prompt: 'hi' }, { Authorization: `Bearer ${issuedKey}` }));
    const ab2 = await ar2.json();
    assert(ab2.auth?.method === 'api_key', 'Bearer psk_ recognized as api key');

    // 7. Revoke -> key no longer grants pro
    const rr = await call(env, '/api/keys', { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-secret' }, body: JSON.stringify({ id: issuedId }) });
    assert(rr.status === 200, 'revoke -> 200');
    const ar3 = await call(env, '/api/analyze', json('/api/analyze', { prompt: 'hi' }, { 'x-promptscope-api-key': issuedKey }));
    const ab3 = await ar3.json();
    assert(ab3.plan === 'free' && ab3.auth?.method === 'none', 'revoked key falls back to free');
  }

  // 8. Invalid/unknown api key -> anonymous free, per-IP limit still applies
  {
    const env = makeEnv();
    const r = await call(env, '/api/analyze', json('/api/analyze', { prompt: 'hi' }, { 'x-promptscope-api-key': 'psk_does_not_exist' }));
    const b = await r.json();
    assert(b.plan === 'free', 'unknown key -> free');
  }

  // 9. Free anonymous rate limit (5/day) then 429
  {
    const env = makeEnv();
    let last;
    for (let i = 0; i < 6; i++) {
      last = await call(env, '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '9.9.9.9' }, body: JSON.stringify({ prompt: 'hi' }) });
    }
    assert(last.status === 429, '6th anonymous request -> 429');
  }

  // 10. Per-key quota is independent of IP buckets (free-plan key)
  {
    const env = makeEnv();
    const issue = await call(env, '/api/keys', json('/api/keys', { plan: 'free' }, { Authorization: 'Bearer admin-secret' }));
    const freeKey = (await issue.json()).api_key;
    let last;
    for (let i = 0; i < 6; i++) {
      last = await call(env, '/api/analyze', json('/api/analyze', { prompt: 'hi' }, { 'x-promptscope-api-key': freeKey }));
    }
    assert(last.status === 429, 'free-plan key also hits 429 after quota');
  }

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  if (failures) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });
