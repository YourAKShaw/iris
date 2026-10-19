import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { createIrisServer, clientIp, silentLogger, type IrisServer } from '../src/server.js';
import { createLlmClient } from '../src/llm.js';
import { SITE_PAGES, completion, outreachReply, researchReply, startFakeLlm, startSite, testConfig, type FakeLlm } from './helpers.js';

interface Event {
  type: string;
  [key: string]: unknown;
}

async function readEvents(response: Response): Promise<Event[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Event);
}

describe('HTTP server', () => {
  let site: Awaited<ReturnType<typeof startSite>>;
  let llm: FakeLlm;
  let app: IrisServer;
  let base: string;

  before(async () => {
    site = await startSite(SITE_PAGES);
    llm = await startFakeLlm((body) => ({
      json: completion(body.messages[0]!.content.includes('research analyst') ? researchReply(site.origin) : outreachReply()),
    }));
    const config = testConfig(llm.url, { RATE_LIMIT_PER_IP: '4', DAILY_RUN_LIMIT: '50' });
    app = await createIrisServer({ config, llm: createLlmClient(config.llm), logger: silentLogger });
    const { port } = await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await app.close(100);
    await site.close();
    await llm.close();
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('serves the app with strict security headers', async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await response.text(), /Cold emails built on facts you can check/);
  });

  it('serves fonts and health checks, and 404s anything else', async () => {
    assert.equal((await fetch(`${base}/fonts/newsreader.woff2`)).headers.get('content-type'), 'font/woff2');
    assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: 'ok', version: '1.0.0' });
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
  });

  it('describes the demo through /api/meta without exposing secrets', async () => {
    const meta = (await (await fetch(`${base}/api/meta`)).json()) as Record<string, unknown>;
    assert.equal(meta.model, 'fake-model');
    assert.ok(!JSON.stringify(meta).includes('apiKey'));
  });

  it('rejects non-JSON, cross-origin and invalid requests', async () => {
    const plain = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'url=x' });
    assert.equal(plain.status, 400);
    assert.equal((await post({ url: `${site.origin}/` }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ url: '' })).status, 400);
    assert.equal((await fetch(`${base}/api/runs`)).status, 405);
    const huge = await post({ url: 'a.example', offer: 'x'.repeat(20_000) });
    assert.equal(huge.status, 400);
  });

  it('streams progress then the result, and caches identical runs', async () => {
    const first = await post({ url: `${site.origin}/`, recipient: 'Priya Rao, COO' });
    assert.equal(first.status, 200);
    assert.match(first.headers.get('content-type') ?? '', /application\/x-ndjson/);
    const events = await readEvents(first);
    assert.ok(events.filter((e) => e.type === 'progress').length >= 5);
    const result = events.at(-1)!;
    assert.equal(result.type, 'result');
    assert.equal(result.cached, false);
    assert.match(String(result.markdown), /## Verified facts/);

    const callsBefore = llm.calls.length;
    const second = await readEvents(await post({ url: `${site.origin}/`, recipient: 'Priya Rao, COO' }));
    assert.equal(second.at(-1)!.cached, true);
    assert.equal(llm.calls.length, callsBefore, 'a cache hit makes no model calls');
  });

  it('rate-limits per client IP with Retry-After', async () => {
    // Earlier tests in this suite used 2 of the 4 allowed runs (invalid requests are not counted).
    await post({ url: `${site.origin}/` });
    await post({ url: `${site.origin}/` });
    const limited = await post({ url: `${site.origin}/` });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const body = (await limited.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'RATE_LIMITED');
  });
});

describe('daily budget', () => {
  it('stops new runs once the daily quota is used, and refunds runs that never reached the model', async () => {
    const site = await startSite(SITE_PAGES);
    const llm = await startFakeLlm((body) => ({
      json: completion(body.messages[0]!.content.includes('research analyst') ? researchReply(site.origin) : outreachReply()),
    }));
    const config = testConfig(llm.url, { DAILY_RUN_LIMIT: '1', CACHE_TTL_MINUTES: '0' });
    const app = await createIrisServer({ config, llm: createLlmClient(config.llm), logger: silentLogger });
    const { port } = await app.listen(0, '127.0.0.1');
    const post = (url: string) =>
      fetch(`http://127.0.0.1:${port}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
    try {
      // A fetch failure happens before any model call, so it is refunded.
      const missing = await readEvents(await post(`${site.origin}/missing-page`));
      assert.equal((missing.at(-1)!.error as { code: string }).code, 'FETCH_FAILED');

      const ok = await readEvents(await post(`${site.origin}/`));
      assert.equal(ok.at(-1)!.type, 'result');

      const blocked = await post(`${site.origin}/`);
      assert.equal(blocked.status, 429);
      assert.match(((await blocked.json()) as { error: { message: string } }).error.message, /quota/);
    } finally {
      await app.close(100);
      await site.close();
      await llm.close();
    }
  });
});

describe('clientIp', () => {
  const request = (forwarded: string | undefined, remote = '10.0.0.1') =>
    ({ headers: forwarded ? { 'x-forwarded-for': forwarded } : {}, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;

  it('ignores X-Forwarded-For unless proxies are trusted', () => {
    assert.equal(clientIp(request('1.2.3.4'), 0), '10.0.0.1');
  });
  it('takes the address the trusted proxy saw, not the spoofable left-most entry', () => {
    assert.equal(clientIp(request('6.6.6.6, 1.2.3.4'), 1), '1.2.3.4');
    assert.equal(clientIp(request('6.6.6.6, 1.2.3.4, 5.6.7.8'), 2), '1.2.3.4');
  });
  it('falls back to the socket address on garbage', () => {
    assert.equal(clientIp(request('not-an-ip'), 1), '10.0.0.1');
  });
});
