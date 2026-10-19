import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runIris, parseRunInput, type ProgressEvent } from '../src/pipeline.js';
import { createLlmClient } from '../src/llm.js';
import { IrisError } from '../src/errors.js';
import { SITE_PAGES, completion, outreachReply, researchReply, startFakeLlm, startSite, testConfig, type ChatRequestBody, type FakeLlm } from './helpers.js';

/**
 * End to end through real HTTP: fixture website → SSRF-guarded fetcher → extractor →
 * OpenAI-compatible client → fake model server → schema + evidence verification → drafts.
 */

const isResearch = (body: ChatRequestBody) => body.messages[0]!.content.includes('research analyst');

describe('runIris end to end', () => {
  let site: Awaited<ReturnType<typeof startSite>>;
  let llm: FakeLlm;

  before(async () => {
    site = await startSite(SITE_PAGES);
    llm = await startFakeLlm((body) => ({ json: completion(isResearch(body) ? researchReply(site.origin) : outreachReply()) }));
  });
  after(async () => {
    await site.close();
    await llm.close();
  });

  it('produces a verified brief and grounded drafts', async () => {
    const config = testConfig(llm.url);
    const progress: ProgressEvent[] = [];
    const result = await runIris(parseRunInput({ url: `${site.origin}/`, recipient: 'Priya Rao, COO' }), {
      config,
      llm: createLlmClient(config.llm),
      onProgress: (event) => progress.push(event),
    });

    assert.equal(result.company.name, 'Northwind Robotics');
    assert.equal(result.stats.pagesRead, 4);
    assert.equal(result.stats.signalsProposed, 6);
    assert.equal(result.stats.signalsVerified, 5);
    assert.equal(result.dropped.length, 1, 'the invented Series B claim is dropped');
    assert.equal(result.emails.length, 3);
    assert.deepEqual(result.emails[2]!.basedOn, ['s4'], 'unknown fact ids are filtered out');
    assert.equal(result.stats.promptTokens, 2400);
    assert.deepEqual(
      progress.map((p) => p.stage),
      ['fetch', 'fetch', 'research', 'verify', 'draft', 'done'],
    );

    // The crawler skipped login/legal pages and never sent script text to the model.
    assert.ok(!site.hits.includes('/login') && !site.hits.includes('/privacy') && !site.hits.includes('/terms'));
    const researchPrompt = llm.calls[0]!.messages[1]!.content;
    assert.doesNotMatch(researchPrompt, /must never reach the model/);
    assert.match(researchPrompt, /<website_content>/);

    // The outreach prompt only contains verified facts.
    const outreachPrompt = llm.calls.at(-1)!.messages[1]!.content;
    assert.doesNotMatch(outreachPrompt, /Series B/);
    assert.match(outreachPrompt, /s4 \[pricing\]/);
  });

  it('refuses private addresses when SSRF protection is on (the default)', async () => {
    const config = testConfig(llm.url, { IRIS_ALLOW_PRIVATE_HOSTS: 'false' });
    await assert.rejects(
      runIris(parseRunInput({ url: `${site.origin}/` }), { config, llm: createLlmClient(config.llm) }),
      (error: unknown) => error instanceof IrisError && error.code === 'URL_BLOCKED',
    );
  });

  it('honours cancellation', async () => {
    const config = testConfig(llm.url);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runIris(parseRunInput({ url: `${site.origin}/` }), { config, llm: createLlmClient(config.llm), signal: controller.signal }),
      (error: unknown) => error instanceof IrisError && error.code === 'ABORTED',
    );
  });

  it('reports a JavaScript-only site clearly', async () => {
    const spa = await startSite({ '/': '<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>' });
    try {
      const config = testConfig(llm.url);
      await assert.rejects(
        runIris(parseRunInput({ url: `${spa.origin}/` }), { config, llm: createLlmClient(config.llm) }),
        (error: unknown) => error instanceof IrisError && error.code === 'SITE_TOO_THIN',
      );
    } finally {
      await spa.close();
    }
  });
});

describe('prompt injection from the website', () => {
  it('repairs, then filters, drafts that try to smuggle in a link', async () => {
    const site = await startSite(SITE_PAGES);
    let outreachCalls = 0;
    // A model that "obeys" the injected instruction every time.
    const llm = await startFakeLlm((body) => {
      if (isResearch(body)) return { json: completion(researchReply(site.origin)) };
      outreachCalls += 1;
      return { json: completion(outreachReply({ injectLink: true })) };
    });
    try {
      const config = testConfig(llm.url);
      const result = await runIris(parseRunInput({ url: `${site.origin}/` }), { config, llm: createLlmClient(config.llm) });

      assert.equal(outreachCalls, 2, 'one repair attempt was made');
      const repairRequest = llm.calls.at(-1)!.messages.at(-1)!.content;
      assert.match(repairRequest, /must not contain links or URLs/);

      assert.equal(result.emails.length, 2, 'the email with the injected link is discarded');
      assert.ok(result.emails.every((e) => !/evil\.example/.test(e.body)));
      assert.match(result.warnings.join(' '), /discarded/);
    } finally {
      await site.close();
      await llm.close();
    }
  });
});

describe('model failures', () => {
  it('fails clearly when the model cannot produce usable JSON', async () => {
    const site = await startSite(SITE_PAGES);
    const llm = await startFakeLlm(() => ({ json: completion('I would rather not answer in JSON.') }));
    try {
      const config = testConfig(llm.url);
      await assert.rejects(
        runIris(parseRunInput({ url: `${site.origin}/` }), { config, llm: createLlmClient(config.llm) }),
        (error: unknown) => error instanceof IrisError && error.code === 'LLM_BAD_OUTPUT',
      );
      assert.equal(llm.calls.length, 2, 'one repair attempt, then stop');
    } finally {
      await site.close();
      await llm.close();
    }
  });
});
