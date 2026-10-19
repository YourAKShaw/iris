import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DailyBudget, FixedWindowLimiter, TtlCache } from '../src/limits.js';
import { renderMarkdown, renderTerminal, safeText } from '../src/format.js';
import { loadConfig } from '../src/config.js';
import { IrisError } from '../src/errors.js';
import { parseRunInput, type IrisResult } from '../src/pipeline.js';
import { VERSION } from '../src/version.js';

const ESC = String.fromCharCode(0x1b);
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);

describe('FixedWindowLimiter', () => {
  it('allows up to the limit per window, then reports when to retry', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(2, 60_000, () => now);
    assert.equal(limiter.hit('a').allowed, true);
    assert.equal(limiter.hit('a').allowed, true);
    const denied = limiter.hit('a');
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterSeconds, 60);
    assert.equal(limiter.hit('b').allowed, true, 'keys are independent');
    now = 60_000;
    assert.equal(limiter.hit('a').allowed, true, 'window resets');
  });

  it('fails closed when flooded with distinct keys', () => {
    const limiter = new FixedWindowLimiter(5, 60_000, () => 0, 2);
    limiter.hit('a');
    limiter.hit('b');
    assert.equal(limiter.hit('c').allowed, false);
  });
});

describe('DailyBudget', () => {
  it('resets at UTC midnight and supports refunds', () => {
    let now = Date.UTC(2026, 9, 19, 23, 59, 0);
    const budget = new DailyBudget(1, () => now);
    assert.equal(budget.tryConsume().allowed, true);
    const denied = budget.tryConsume();
    assert.equal(denied.allowed, false);
    assert.equal(denied.retryAfterSeconds, 60);
    budget.refund();
    assert.equal(budget.remaining(), 1);
    budget.tryConsume();
    now = Date.UTC(2026, 9, 20, 0, 0, 1);
    assert.equal(budget.remaining(), 1);
  });
});

describe('TtlCache', () => {
  it('expires entries and evicts the oldest when full', () => {
    let now = 0;
    const cache = new TtlCache<number>(1000, 2, () => now);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('c'), 3);
    now = 1000;
    assert.equal(cache.get('c'), undefined);
  });
  it('is a no-op when disabled', () => {
    const cache = new TtlCache<number>(0, 10);
    cache.set('a', 1);
    assert.equal(cache.get('a'), undefined);
  });
});

const sample: IrisResult = {
  schemaVersion: 1,
  generatedAt: '2026-10-19T00:00:00.000Z',
  input: { url: 'https://acme.example/', recipient: null, offer: 'offer' },
  company: { name: `Acme${ESC}[31m`, oneLiner: `Rockets${RLO}evil`, offering: '', audience: '' },
  signals: [{ id: 's1', category: 'product', claim: 'Makes rockets', quote: 'We make rockets for road runners', sourceUrl: 'https://acme.example/' }],
  hypotheses: [{ statement: 'Needs more coyotes', basedOn: ['s1'], confidence: 'low' }],
  emails: [{ angle: 'Rockets', subject: 'About your rockets', body: 'Hi team,\n\nBody text.', basedOn: ['s1'], wordCount: 4 }],
  sources: [{ url: 'https://acme.example/', title: 'Acme' }],
  dropped: [],
  warnings: [],
  stats: { provider: 'groq', model: 'm', pagesRead: 1, signalsProposed: 1, signalsVerified: 1, durationMs: 1234, promptTokens: 10, completionTokens: 5 },
};

describe('format', () => {
  it('strips terminal control and bidi characters from untrusted text', () => {
    assert.equal(safeText(`ok${ESC}[2Jcleared${RLO}reversed${ZWSP}zero`), 'ok[2Jclearedreversedzero');
  });

  it('renders terminal output without escape sequences when colour is off', () => {
    const output = renderTerminal(sample, { color: false });
    assert.ok(!output.includes(ESC));
    assert.match(output, /VERIFIED FACTS/);
    assert.match(output, /Subject: About your rockets/);
  });

  it('renders a Markdown brief', () => {
    const markdown = renderMarkdown(sample);
    assert.match(markdown, /^# Acme/);
    assert.match(markdown, /## Verified facts \(1 of 1\)/);
    assert.match(markdown, /### Email 1: Rockets/);
  });
});

describe('loadConfig', () => {
  it('defaults to Groq and explains how to get a free key', () => {
    assert.throws(
      () => loadConfig({}),
      (e: unknown) => e instanceof IrisError && e.code === 'CONFIG_ERROR' && /console\.groq\.com\/keys/.test(e.message),
    );
  });

  it('reports every problem at once', () => {
    assert.throws(
      () => loadConfig({ LLM_PROVIDER: 'nope', PORT: 'abc', RATE_LIMIT_PER_IP: '0' }),
      (e: unknown) => e instanceof IrisError && /LLM_PROVIDER/.test(e.message) && /PORT/.test(e.message) && /RATE_LIMIT_PER_IP/.test(e.message),
    );
  });

  it('lets Ollama run without a key but requires a model', () => {
    assert.throws(() => loadConfig({ LLM_PROVIDER: 'ollama' }), /LLM_MODEL is required/);
    const config = loadConfig({ LLM_PROVIDER: 'ollama', LLM_MODEL: 'qwen3' });
    assert.equal(config.llm.baseUrl, 'http://localhost:11434/v1');
    assert.equal(config.llm.apiKey, undefined);
  });

  it('keeps SSRF protection on unless explicitly disabled', () => {
    assert.equal(loadConfig({ LLM_API_KEY: 'k' }).fetch.allowPrivateHosts, false);
  });

  it('can switch reasoning effort off', () => {
    assert.equal(loadConfig({ LLM_API_KEY: 'k', LLM_REASONING_EFFORT: 'off' }).llm.reasoningEffort, undefined);
  });
});

describe('parseRunInput', () => {
  it('adds https:// and strips fragments', () => {
    assert.equal(parseRunInput({ url: 'acme.example/about#team' }).url, 'https://acme.example/about');
  });
  it('rejects empty, oversized and non-web input', () => {
    for (const raw of [{}, { url: '' }, { url: 'x'.repeat(3000) }, { url: 'ftp://acme.example' }, { url: 'acme.example', offer: 'x'.repeat(600) }]) {
      assert.throws(() => parseRunInput(raw), (e: unknown) => e instanceof IrisError && e.code === 'INVALID_INPUT');
    }
  });
  it('treats blank optional fields as absent', () => {
    const input = parseRunInput({ url: 'acme.example', recipient: '  ', offer: '' });
    assert.equal(input.recipient, undefined);
    assert.equal(input.offer, undefined);
  });
});

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(VERSION, pkg.version);
  });
});
