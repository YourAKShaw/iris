import type { z } from 'zod';
import { IrisError, isIrisError } from './errors.js';
import type { LlmConfig } from './config.js';

/**
 * Minimal OpenAI-compatible chat-completions client (Groq, Gemini, OpenRouter, Ollama, OpenAI…).
 * Plain fetch, no SDK. Calls are side-effect free, so a bounded retry is safe; the bound
 * exists to cap latency and token spend.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmCompletion {
  text: string;
  usage: LlmUsage;
}

export interface CompleteOptions {
  maxTokens: number;
  signal?: AbortSignal | undefined;
}

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  complete(messages: ChatMessage[], options: CompleteOptions): Promise<LlmCompletion>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

const MAX_ATTEMPTS = 2;
const MAX_RETRY_WAIT_MS = 12_000;
const MAX_RESPONSE_CHARS = 2_000_000;

const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new IrisError('ABORTED', 'The run was cancelled.'));
      },
      { once: true },
    );
  });

export function createLlmClient(config: LlmConfig, fetchImpl: FetchLike = fetch, sleep: Sleep = defaultSleep): LlmClient {
  let jsonMode = config.jsonMode;

  async function once(messages: ChatMessage[], options: CompleteOptions): Promise<LlmCompletion> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      [config.maxTokensParam]: options.maxTokens,
    };
    if (jsonMode === 'json_object') body.response_format = { type: 'json_object' };
    if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;
    if (config.temperature !== undefined) body.temperature = config.temperature;

    const deadline = AbortSignal.timeout(config.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

    let response: Response;
    let raw: string;
    try {
      response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
      raw = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
    } catch (error) {
      if (options.signal?.aborted) throw new IrisError('ABORTED', 'The run was cancelled.');
      if (deadline.aborted) {
        throw new IrisError('LLM_TIMEOUT', `The AI provider did not answer within ${Math.round(config.timeoutMs / 1000)} seconds.`);
      }
      throw new IrisError('LLM_UNAVAILABLE', `Could not reach the AI provider at ${new URL(config.baseUrl).host}.`, {
        cause: error,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    if (!response.ok) throw httpError(response, raw);

    const data = safeJson(raw) as ChatCompletionResponse | undefined;
    const choice = data?.choices?.[0];
    const text = contentText(choice?.message?.content);
    if (!text.trim()) {
      if (choice?.finish_reason === 'length') {
        throw new IrisError(
          'LLM_BAD_OUTPUT',
          'The model used up its output budget before answering. Try again, or set LLM_REASONING_EFFORT=low.',
        );
      }
      throw new IrisError('LLM_BAD_OUTPUT', 'The model returned an empty answer.');
    }
    return {
      text,
      usage: {
        promptTokens: numberOr0(data?.usage?.prompt_tokens),
        completionTokens: numberOr0(data?.usage?.completion_tokens),
      },
    };
  }

  return {
    provider: config.provider,
    model: config.model,
    async complete(messages, options) {
      let formatFallbackUsed = false;
      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          return await once(messages, options);
        } catch (error) {
          const failure = isIrisError(error) ? error : new IrisError('LLM_UNAVAILABLE', 'The AI provider call failed.');
          // Some OpenAI-compatible providers reject JSON mode; degrade once to plain text + parsing.
          if (
            failure.code === 'LLM_BAD_REQUEST' &&
            jsonMode === 'json_object' &&
            !formatFallbackUsed &&
            /response_format|json_object|json mode/i.test(failure.detail ?? '')
          ) {
            jsonMode = 'off';
            formatFallbackUsed = true;
            attempt -= 1;
            continue;
          }
          const retryable =
            failure.code === 'LLM_UNAVAILABLE' || failure.code === 'LLM_RATE_LIMITED' || failure.code === 'LLM_BAD_OUTPUT';
          const waitMs = failure.retryAfterSeconds !== undefined ? failure.retryAfterSeconds * 1000 : 800 * attempt;
          if (!retryable || attempt >= MAX_ATTEMPTS || waitMs > MAX_RETRY_WAIT_MS) throw failure;
          await sleep(waitMs, options.signal);
        }
      }
    },
  };
}

interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: unknown };
  }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'object' && part !== null && 'text' in part ? String((part as { text: unknown }).text) : ''))
      .join('');
  }
  return '';
}

function numberOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function providerMessage(raw: string): string {
  const data = safeJson(raw);
  const candidates: unknown[] = [];
  if (Array.isArray(data)) candidates.push(data[0]?.error?.message, data[0]?.message);
  else if (data && typeof data === 'object') {
    const record = data as { error?: { message?: unknown; code?: unknown } | string; message?: unknown };
    if (typeof record.error === 'string') candidates.push(record.error);
    else candidates.push(record.error?.message, record.error?.code, record.message);
  }
  const found = candidates.find((value) => typeof value === 'string' && value.trim());
  return String(found ?? raw).replace(/\s+/g, ' ').trim().slice(0, 300);
}

function parseRetryAfter(response: Response, message: string): number | undefined {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  }
  const match = /try again in\s+(?:(\d+)m)?\s*([\d.]+)?\s*(ms|s)?/i.exec(message);
  if (match && (match[1] || match[2])) {
    const minutes = Number(match[1] ?? 0);
    const value = Number(match[2] ?? 0);
    const seconds = match[3] === 'ms' ? value / 1000 : value;
    return Math.ceil(minutes * 60 + seconds);
  }
  return undefined;
}

function httpError(response: Response, raw: string): IrisError {
  const message = providerMessage(raw);
  const status = response.status;
  if (status === 401 || status === 403) {
    return new IrisError('LLM_AUTH', 'The AI provider rejected the API key. Check LLM_API_KEY.', { detail: message });
  }
  if (status === 429) {
    const retryAfterSeconds = parseRetryAfter(response, message);
    const when = retryAfterSeconds !== undefined ? ` Try again in about ${formatWait(retryAfterSeconds)}.` : ' Try again shortly.';
    return new IrisError('LLM_RATE_LIMITED', `The AI provider's free-tier rate limit was reached.${when}`, {
      detail: message,
      retryAfterSeconds,
    });
  }
  if (status === 404) {
    return new IrisError('LLM_BAD_REQUEST', `The AI provider could not find that model or endpoint. Check LLM_MODEL. (${message})`, {
      detail: message,
    });
  }
  if (status >= 500) {
    return new IrisError('LLM_UNAVAILABLE', `The AI provider had an error (HTTP ${status}). Try again.`, { detail: message });
  }
  if (/json_validate_failed|failed to generate json/i.test(message)) {
    return new IrisError('LLM_BAD_OUTPUT', 'The model produced malformed JSON.', { detail: message });
  }
  return new IrisError('LLM_BAD_REQUEST', `The AI provider rejected the request: ${message}`, { detail: message });
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 120 ? `${minutes} minutes` : `${Math.ceil(minutes / 60)} hours`;
}

/** Extracts one JSON object from model text, tolerating code fences, think-tags and stray prose. */
export function parseJsonObject(text: string): unknown {
  let candidate = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(candidate);
  if (fence) candidate = fence[1]!.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
  }
  throw new IrisError('LLM_BAD_OUTPUT', 'The model did not return valid JSON.');
}

export interface StructuredResult<T> {
  value: T;
  /** Semantic problems still present after the repair attempt (schema problems throw). */
  problems: string[];
  usage: LlmUsage;
  attempts: number;
}

/**
 * Runs a completion, validates it against a runtime schema plus optional semantic checks,
 * and makes at most one repair attempt that feeds the problems back to the model.
 */
export async function completeStructured<T>(
  client: LlmClient,
  messages: ChatMessage[],
  schema: z.ZodType<T>,
  options: CompleteOptions & { check?: (value: T) => string[] },
): Promise<StructuredResult<T>> {
  const conversation = [...messages];
  const usage: LlmUsage = { promptTokens: 0, completionTokens: 0 };
  let lastProblems: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const completion = await client.complete(conversation, options);
    usage.promptTokens += completion.usage.promptTokens;
    usage.completionTokens += completion.usage.completionTokens;

    let value: T | undefined;
    try {
      const parsed = schema.safeParse(parseJsonObject(completion.text));
      if (parsed.success) {
        value = parsed.data;
        lastProblems = options.check ? options.check(value) : [];
      } else {
        lastProblems = parsed.error.issues
          .slice(0, 12)
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
    } catch (error) {
      lastProblems = [isIrisError(error) ? error.message : 'The output could not be parsed.'];
    }

    if (value !== undefined && (lastProblems.length === 0 || attempt === 2)) {
      return { value, problems: lastProblems, usage, attempts: attempt };
    }
    if (attempt === 2) break;

    conversation.push(
      { role: 'assistant', content: completion.text.slice(0, 8_000) },
      {
        role: 'user',
        content: `That response cannot be used because:\n${lastProblems.map((p) => `- ${p}`).join('\n')}\nReturn the complete corrected JSON object only.`,
      },
    );
  }

  throw new IrisError('LLM_BAD_OUTPUT', 'The model returned output Iris could not use, even after a repair attempt. Try again.', {
    detail: lastProblems.join('; '),
  });
}
