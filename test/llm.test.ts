import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { completeStructured, createLlmClient, parseJsonObject, type LlmClient } from '../src/llm.js';
import { loadConfig } from '../src/config.js';
import { IrisError } from '../src/errors.js';

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

function fakeFetch(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const impl = async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    return next();
  };
  return { impl, calls };
}

const ok = (content: string) => () =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
    status: 200,
  });
const fail = (status: number, message: string, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify({ error: { message } }), { status, headers });
const noSleep = async () => {};

const groq = loadConfig({ LLM_API_KEY: 'gsk_test_key' });

describe('createLlmClient', () => {
  it('sends an OpenAI-compatible request with the Groq preset', async () => {
    const { impl, calls } = fakeFetch([ok('{"a":1}')]);
    const client = createLlmClient(groq.llm, impl, noSleep);
    const result = await client.complete([{ role: 'user', content: 'hi' }], { maxTokens: 100 });

    assert.equal(result.text, '{"a":1}');
    assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 5 });
    assert.equal(calls[0]!.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer gsk_test_key');
    assert.equal(calls[0]!.body.model, 'openai/gpt-oss-120b');
    assert.equal(calls[0]!.body.max_completion_tokens, 100);
    assert.equal(calls[0]!.body.reasoning_effort, 'low');
    assert.deepEqual(calls[0]!.body.response_format, { type: 'json_object' });
  });

  it('maps 401 to LLM_AUTH without retrying', async () => {
    const { impl, calls } = fakeFetch([fail(401, 'Invalid API Key')]);
    const client = createLlmClient(groq.llm, impl, noSleep);
    await assert.rejects(client.complete([], { maxTokens: 1 }), (e: unknown) => e instanceof IrisError && e.code === 'LLM_AUTH');
    assert.equal(calls.length, 1);
  });

  it('retries once on a short 429 and then succeeds', async () => {
    const { impl, calls } = fakeFetch([fail(429, 'Rate limit reached. Please try again in 1.5s.'), ok('{}')]);
    const client = createLlmClient(groq.llm, impl, noSleep);
    await client.complete([], { maxTokens: 1 });
    assert.equal(calls.length, 2);
  });

  it('gives up immediately on a long 429 and reports when to retry', async () => {
    const { impl, calls } = fakeFetch([fail(429, 'Rate limit reached for tokens per day (TPD). Please try again in 7m12s.', { 'retry-after': '432' })]);
    const client = createLlmClient(groq.llm, impl, noSleep);
    await assert.rejects(client.complete([], { maxTokens: 1 }), (e: unknown) => {
      assert.ok(e instanceof IrisError);
      assert.equal(e.code, 'LLM_RATE_LIMITED');
      assert.equal(e.retryAfterSeconds, 432);
      assert.match(e.message, /8 minutes/);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it('falls back to plain text once if the provider rejects JSON mode', async () => {
    const { impl, calls } = fakeFetch([fail(400, "Invalid value for 'response_format'"), ok('{"ok":true}')]);
    const client = createLlmClient(groq.llm, impl, noSleep);
    await client.complete([], { maxTokens: 1 });
    assert.equal(calls.length, 2);
    assert.ok('response_format' in calls[0]!.body);
    assert.ok(!('response_format' in calls[1]!.body));
  });

  it('reports a truncated, empty answer clearly', async () => {
    const { impl } = fakeFetch([
      () => new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }), { status: 200 }),
      () => new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }), { status: 200 }),
    ]);
    const client = createLlmClient(groq.llm, impl, noSleep);
    await assert.rejects(client.complete([], { maxTokens: 1 }), /output budget/);
  });

  it('turns network failures into LLM_UNAVAILABLE without leaking the key', async () => {
    const client = createLlmClient(groq.llm, async () => {
      throw new TypeError('fetch failed');
    }, noSleep);
    await assert.rejects(client.complete([], { maxTokens: 1 }), (e: unknown) => {
      assert.ok(e instanceof IrisError);
      assert.equal(e.code, 'LLM_UNAVAILABLE');
      assert.doesNotMatch(`${e.message} ${e.detail}`, /gsk_test_key/);
      return true;
    });
  });
});

describe('parseJsonObject', () => {
  it('parses plain, fenced and prose-wrapped JSON', () => {
    assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJsonObject('Sure! Here it is: {"a":1} Hope that helps.'), { a: 1 });
    assert.deepEqual(parseJsonObject('<think>plan</think>{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonObject(`${String.fromCharCode(0xfeff)}{"a":1}`), { a: 1 });
  });
  it('throws LLM_BAD_OUTPUT on garbage', () => {
    assert.throws(() => parseJsonObject('no json here'), (e: unknown) => e instanceof IrisError && e.code === 'LLM_BAD_OUTPUT');
  });
});

describe('completeStructured', () => {
  const schema = z.object({ answer: z.number() });

  function scripted(texts: string[]): LlmClient & { seen: number[] } {
    const seen: number[] = [];
    return {
      provider: 'fake',
      model: 'fake',
      seen,
      async complete(messages) {
        seen.push(messages.length);
        const text = texts.shift();
        if (text === undefined) throw new Error('exhausted');
        return { text, usage: { promptTokens: 1, completionTokens: 1 } };
      },
    };
  }

  it('repairs invalid output once, feeding back the problems', async () => {
    const client = scripted(['{"answer":"forty-two"}', '{"answer":42}']);
    const result = await completeStructured(client, [{ role: 'user', content: 'q' }], schema, { maxTokens: 10 });
    assert.equal(result.value.answer, 42);
    assert.equal(result.attempts, 2);
    assert.deepEqual(client.seen, [1, 3]); // second call carries the bad answer + the correction request
    assert.deepEqual(result.usage, { promptTokens: 2, completionTokens: 2 });
  });

  it('gives up after one failed repair', async () => {
    const client = scripted(['nope', 'still nope']);
    await assert.rejects(completeStructured(client, [], schema, { maxTokens: 10 }), (e: unknown) => e instanceof IrisError && e.code === 'LLM_BAD_OUTPUT');
  });

  it('returns remaining semantic problems after the repair for the caller to handle', async () => {
    const client = scripted(['{"answer":1}', '{"answer":2}']);
    const result = await completeStructured(client, [], schema, { maxTokens: 10, check: (v) => (v.answer < 10 ? ['too small'] : []) });
    assert.equal(result.value.answer, 2);
    assert.deepEqual(result.problems, ['too small']);
  });
});
