import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

type Listener = (event: any) => any;

class FakeClassList {
  el: FakeElement;

  constructor(el: FakeElement) {
    this.el = el;
  }

  add(...names: string[]) {
    const current = new Set(this.el.className.split(/\s+/).filter(Boolean));
    for (const name of names) current.add(name);
    this.el.className = [...current].join(' ');
  }

  remove(...names: string[]) {
    const current = new Set(this.el.className.split(/\s+/).filter(Boolean));
    for (const name of names) current.delete(name);
    this.el.className = [...current].join(' ');
  }

  contains(name: string) {
    return this.el.className.split(/\s+/).includes(name);
  }
}

class FakeElement {
  id: string;
  tagName: string;
  hidden = false;
  disabled = false;
  className = '';
  style: Record<string, string> = {};
  attributes = new Set<string>();
  listeners = new Map<string, Listener[]>();
  classList = new FakeClassList(this);
  scrolls = 0;
  selections = 0;
  private text = '';
  private html = '';
  private inputValue = '';
  private linkHref = '';

  constructor(id = '', tagName = 'div') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
  }

  get textContent() {
    return this.text;
  }

  set textContent(value: unknown) {
    this.text = value == null ? '' : String(value);
  }

  get innerHTML() {
    return this.html;
  }

  set innerHTML(value: unknown) {
    this.html = value == null ? '' : String(value);
  }

  get value() {
    return this.inputValue;
  }

  set value(value: unknown) {
    this.inputValue = value == null ? '' : String(value);
  }

  get href() {
    return this.linkHref;
  }

  set href(value: unknown) {
    this.linkHref = value == null ? '' : String(value);
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async dispatchEvent(event: any) {
    event.target ??= this;
    event.currentTarget = this;
    event.preventDefault ??= () => { event.defaultPrevented = true; };
    const listeners = this.listeners.get(event.type) ?? [];
    for (const listener of listeners) await listener(event);
  }

  click(event: any = {}) {
    return this.dispatchEvent({ type: 'click', ...event });
  }

  keydown(key: string) {
    return this.dispatchEvent({ type: 'keydown', key });
  }

  closest(selector: string) {
    return this.attributes.has(selector.replace(/^\[|\]$/g, '')) ? this : null;
  }

  select() {
    this.selections++;
  }

  scrollIntoView() {
    this.scrolls++;
  }
}

class FakeDocument {
  elements = new Map<string, FakeElement>();
  selectors = new Map<string, FakeElement[]>();
  listeners = new Map<string, Listener[]>();
  body = new FakeElement('body', 'body');

  getElementById(id: string) {
    if (!this.elements.has(id)) this.elements.set(id, new FakeElement(id));
    return this.elements.get(id)!;
  }

  createElement(tagName: string) {
    return new FakeElement('', tagName);
  }

  querySelectorAll(selector: string) {
    return this.selectors.get(selector) ?? [];
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async dispatchEvent(event: any) {
    event.target ??= this;
    const listeners = this.listeners.get(event.type) ?? [];
    for (const listener of listeners) await listener(event);
  }
}

interface AppHarness {
  document: FakeDocument;
  fetchCalls: Array<{ url: string; init?: RequestInit }>;
  clipboardWrites: string[];
  alerts: string[];
  timers: Array<{ fn: () => void; ms: number }>;
  localStorage: Storage;
  el: (id: string) => FakeElement;
  domContentLoaded: () => Promise<void>;
  runTimers: () => void;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function buildDocument() {
  const doc = new FakeDocument();
  const ids = [
    'analyze-btn',
    'prompt-input',
    'quota',
    'license-key',
    'license-save-btn',
    'license-clear-btn',
    'license-status',
    'paywall-sub',
    'paywall',
    'paywall-status',
    'results',
    'score-num',
    'token-count',
    'char-count',
    'anti-patterns',
    'strengths',
    'rewrite-upsell',
    'rewrite-block',
    'rewrite-lock',
    'paywall-license-key',
    'paywall-license-save',
    'share-btn',
    'share-link',
  ];
  for (const id of ids) doc.getElementById(id);

  doc.getElementById('analyze-btn').textContent = 'Analyze';
  doc.getElementById('license-save-btn').textContent = 'Save license';
  doc.getElementById('license-clear-btn').textContent = 'Clear';
  doc.getElementById('paywall-license-save').textContent = 'Unlock';
  doc.getElementById('share-btn').textContent = 'Get shareable link';
  doc.getElementById('quota').textContent = '5 free analyses / day';
  doc.getElementById('results').hidden = true;
  doc.getElementById('paywall').hidden = true;
  doc.getElementById('rewrite-lock').hidden = true;
  doc.getElementById('rewrite-upsell').hidden = true;
  doc.getElementById('share-link').hidden = true;
  doc.getElementById('license-clear-btn').hidden = true;

  const upgradeLinks = [
    new FakeElement('upgrade-link', 'a'),
    new FakeElement('rewrite-upgrade-link', 'a'),
    new FakeElement('paywall-upgrade-link', 'a'),
  ];
  for (const link of upgradeLinks) link.href = '/api/checkout';
  doc.selectors.set('[data-upgrade-link]', upgradeLinks);

  const paywallClose = new FakeElement('paywall-close', 'button');
  paywallClose.attributes.add('data-paywall-close');
  doc.selectors.set('[data-paywall-close]', [paywallClose]);

  return doc;
}

function fakeStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key: string) {
      return values.has(key) ? values.get(key)! : null;
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
    removeItem(key: string) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    get length() {
      return values.size;
    },
  } as Storage;
}

async function flushPromises(turns = 6) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

async function waitFor(predicate: () => boolean, message: string) {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await flushPromises();
  }
  assert.fail(message);
}

function loadApp(opts: {
  path?: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response> | Response;
  storage?: Record<string, string>;
} = {}): AppHarness {
  const document = buildDocument();
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const clipboardWrites: string[] = [];
  const alerts: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const localStorage = fakeStorage(opts.storage);
  const fetchHandler = opts.fetch ?? ((url: string) => {
    if (url === '/api/license') return jsonResponse({ upgrade_url: 'https://checkout.test/buy' });
    throw new Error(`unexpected fetch ${url}`);
  });

  const fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    fetchCalls.push({ url, init });
    return fetchHandler(url, init);
  };
  globalThis.fetch = fetch as typeof globalThis.fetch;

  const window = {
    location: {
      origin: 'https://promptscope.test',
      pathname: opts.path ?? '/',
    },
  };

  const context = vm.createContext({
    document,
    window,
    localStorage,
    fetch,
    navigator: {
      clipboard: {
        writeText(value: string) {
          clipboardWrites.push(value);
          return Promise.resolve();
        },
      },
    },
    alert(message: unknown) {
      alerts.push(String(message));
    },
    setTimeout(fn: () => void, ms: number) {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout() {},
    console,
  });

  const scriptPath = join(process.cwd(), 'public/app.js');
  const source = readFileSync(scriptPath, 'utf8');
  vm.runInContext(source, context, { filename: scriptPath });

  return {
    document,
    fetchCalls,
    clipboardWrites,
    alerts,
    timers,
    localStorage,
    el: (id: string) => document.getElementById(id),
    async domContentLoaded() {
      await document.dispatchEvent({ type: 'DOMContentLoaded' });
      await flushPromises();
    },
    runTimers() {
      for (const timer of [...timers]) timer.fn();
      timers.length = 0;
    },
  };
}

test('frontend analyze flow renders a free-tier result and escapes model text', async () => {
  const app = loadApp({
    fetch: (url, init) => {
      if (url === '/api/license') return jsonResponse({ upgrade_url: 'https://checkout.test/buy' });
      if (url === '/api/analyze') {
        assert.equal(init?.method, 'POST');
        assert.deepEqual(JSON.parse(String(init.body)), { prompt: 'System prompt with structure' });
        assert.equal((init.headers as Record<string, string>)['x-promptscope-license'], undefined);
        return jsonResponse({
          score: 8.25,
          token_count: 7,
          char_count: 28,
          plan: 'free',
          quota_remaining: 1,
          anti_patterns: [{ name: '<script>alert(1)</script>', fix: 'Use a <schema>.' }],
          strengths: ['Clear & direct'],
          advanced_features: {
            suggested_rewrite: { locked: true, upgrade_url: 'https://checkout.test/buy' },
          },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  await app.domContentLoaded();
  app.el('prompt-input').value = '  System prompt with structure  ';
  await app.el('analyze-btn').click();

  assert.equal(app.el('results').hidden, false);
  assert.equal(app.el('score-num').textContent, '8.3');
  assert.equal(app.el('token-count').textContent, '7');
  assert.equal(app.el('char-count').textContent, '28');
  assert.match(app.el('anti-patterns').innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(app.el('strengths').innerHTML, /Clear &amp; direct/);
  assert.equal(app.el('rewrite-lock').hidden, false);
  assert.equal(app.el('rewrite-upsell').hidden, false);
  assert.equal(app.el('quota').textContent, '1 free analysis remaining today');
  assert.equal(app.el('quota').classList.contains('low'), true);
  assert.equal(app.el('results').scrolls, 1);
  assert.equal(app.el('analyze-btn').disabled, false);
  assert.equal(app.el('analyze-btn').textContent, 'Analyze');
  assert.equal(app.alerts.length, 0);
});

test('frontend opens the paywall when free quota is exhausted', async () => {
  const app = loadApp({
    fetch: (url) => {
      if (url === '/api/license') return jsonResponse({ upgrade_url: 'https://checkout.test/buy' });
      if (url === '/api/analyze') {
        return jsonResponse({
          error: 'daily free quota exhausted; upgrade to Pro for unlimited analysis',
          upgrade_url: 'https://checkout.test/buy',
        }, 429);
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  await app.domContentLoaded();
  app.el('prompt-input').value = 'quota-limited prompt';
  await app.el('analyze-btn').click();

  assert.equal(app.el('results').hidden, true);
  assert.equal(app.el('paywall').hidden, false);
  assert.equal(app.document.body.style.overflow, 'hidden');
  assert.match(app.el('paywall-sub').textContent, /daily free quota exhausted/i);
  assert.match(app.el('quota').innerHTML, /No free analyses left today/);
  assert.equal(app.el('quota').classList.contains('low'), true);
  assert.equal(app.el('analyze-btn').textContent, 'Analyze');
});

test('frontend saves a valid license and clear removes the persisted pro state', async () => {
  const app = loadApp({
    fetch: (url, init) => {
      if (url === '/api/license' && !init) return jsonResponse({ upgrade_url: 'https://checkout.test/buy' });
      if (url === '/api/license') {
        assert.deepEqual(JSON.parse(String(init?.body)), { license_key: 'VALID-KEY' });
        return jsonResponse({ valid: true, upgrade_url: 'https://checkout.test/buy' });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  await app.domContentLoaded();
  app.el('license-key').value = '  VALID-KEY  ';
  await app.el('license-save-btn').click();

  assert.equal(app.localStorage.getItem('promptscope:license-key'), 'VALID-KEY');
  assert.equal(app.el('license-status').textContent, 'Pro license active');
  assert.equal(app.el('license-status').className, 'license-status good');
  assert.equal(app.el('quota').textContent, 'Pro license active');
  assert.equal(app.el('license-clear-btn').hidden, false);
  assert.equal(app.el('license-save-btn').disabled, false);
  assert.equal(app.el('license-save-btn').textContent, 'Save license');

  await app.el('license-clear-btn').click();

  assert.equal(app.localStorage.getItem('promptscope:license-key'), null);
  assert.equal(app.el('license-key').value, '');
  assert.equal(app.el('license-clear-btn').hidden, true);
  assert.equal(app.el('quota').textContent, '5 free analyses / day');
  assert.equal(app.el('quota').classList.contains('low'), false);
  assert.equal(app.el('license-status').textContent, 'License cleared.');
});

test('frontend paywall unlock persists the license and reruns the blocked analysis', async () => {
  const app = loadApp({
    fetch: (url, init) => {
      if (url === '/api/license' && !init) return jsonResponse({ upgrade_url: 'https://checkout.test/buy' });
      if (url === '/api/license') return jsonResponse({ valid: true, upgrade_url: 'https://checkout.test/buy' });
      if (url === '/api/analyze') {
        assert.equal((init?.headers as Record<string, string>)['x-promptscope-license'], 'PAYWALL-KEY');
        return jsonResponse({
          score: 9,
          token_count: 10,
          char_count: 40,
          plan: 'pro',
          anti_patterns: [],
          strengths: ['Specific output contract'],
          suggested_rewrite: 'A cleaner system prompt.',
          advanced_features: { suggested_rewrite: { locked: false } },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  await app.domContentLoaded();
  app.el('prompt-input').value = 'blocked prompt';
  app.el('paywall').hidden = false;
  app.el('paywall-license-key').value = 'PAYWALL-KEY';
  await app.el('paywall-license-save').click();
  await waitFor(() => app.el('rewrite-block').textContent === 'A cleaner system prompt.', 'analysis did not rerun after paywall unlock');

  assert.equal(app.localStorage.getItem('promptscope:license-key'), 'PAYWALL-KEY');
  assert.equal(app.el('license-key').value, 'PAYWALL-KEY');
  assert.equal(app.el('paywall').hidden, true);
  assert.equal(app.document.body.style.overflow, '');
  assert.equal(app.el('rewrite-lock').hidden, true);
  assert.equal(app.el('rewrite-upsell').hidden, true);
  assert.equal(app.el('license-status').textContent, 'Pro license active');
});

test('frontend creates a share link and copies the generated URL', async () => {
  const app = loadApp({
    fetch: (url, init) => {
      if (url === '/api/license') return jsonResponse({ upgrade_url: 'https://checkout.test/buy' });
      if (url === '/api/share') {
        assert.equal(init?.method, 'POST');
        assert.deepEqual(JSON.parse(String(init.body)), { prompt: 'Share this prompt' });
        return jsonResponse({ id: 'share_123' });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  await app.domContentLoaded();
  app.el('prompt-input').value = '  Share this prompt  ';
  await app.el('share-btn').click();

  assert.equal(app.el('share-link').hidden, false);
  assert.equal(app.el('share-link').value, 'https://promptscope.test/s/share_123');
  assert.equal(app.el('share-link').selections, 1);
  assert.deepEqual(app.clipboardWrites, ['https://promptscope.test/s/share_123']);
  assert.equal(app.el('share-btn').disabled, true);
  assert.equal(app.el('share-btn').textContent, 'Copied!');
  assert.deepEqual(app.timers.map(t => t.ms), [2000]);

  app.runTimers();
  assert.equal(app.el('share-btn').disabled, false);
  assert.equal(app.el('share-btn').textContent, 'Get shareable link');
});
