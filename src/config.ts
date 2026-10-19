import { IrisError } from './errors.js';

/**
 * Runtime configuration, parsed once from environment variables.
 * Every problem is reported together so a misconfigured deploy fails with one clear message.
 */

export type ProviderId = 'groq' | 'gemini' | 'openrouter' | 'ollama' | 'openai' | 'custom';
export type MaxTokensParam = 'max_tokens' | 'max_completion_tokens';

interface ProviderPreset {
  baseUrl?: string;
  model?: string;
  maxTokensParam: MaxTokensParam;
  reasoningEffort?: string;
  requiresKey: boolean;
  keyUrl?: string;
}

/**
 * OpenAI-compatible chat-completions endpoints. Models and free-tier limits change often;
 * verify them in the provider console. Defaults were checked against provider docs in Oct 2026.
 */
export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    maxTokensParam: 'max_completion_tokens',
    reasoningEffort: 'low',
    requiresKey: true,
    keyUrl: 'https://console.groq.com/keys',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.8-flash',
    maxTokensParam: 'max_tokens',
    reasoningEffort: 'low',
    requiresKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    maxTokensParam: 'max_tokens',
    requiresKey: true,
    keyUrl: 'https://openrouter.ai/keys',
  },
  ollama: {
    baseUrl: 'http://localhost:11434/v1',
    maxTokensParam: 'max_tokens',
    requiresKey: false,
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    maxTokensParam: 'max_completion_tokens',
    requiresKey: true,
  },
  custom: {
    maxTokensParam: 'max_tokens',
    requiresKey: false,
  },
};

export interface LlmConfig {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  maxTokensParam: MaxTokensParam;
  reasoningEffort: string | undefined;
  jsonMode: 'json_object' | 'off';
  temperature: number | undefined;
  timeoutMs: number;
}

export interface SenderProfile {
  name: string;
  company: string;
  offer: string;
}

export interface FetchConfig {
  allowPrivateHosts: boolean;
  pageTimeoutMs: number;
  maxPageBytes: number;
  maxPages: number;
  maxRedirects: number;
  textBudgetChars: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  trustProxyHops: number;
  rateLimitPerIp: number;
  rateLimitWindowMs: number;
  dailyRunLimit: number;
  maxConcurrentRuns: number;
  cacheTtlMs: number;
  cacheMaxEntries: number;
}

export interface IrisConfig {
  llm: LlmConfig;
  sender: SenderProfile;
  fetch: FetchConfig;
  server: ServerConfig;
  runTimeoutMs: number;
}

export const DEFAULT_SENDER: SenderProfile = {
  name: 'Ayush',
  company: 'NayaManas',
  offer:
    'NayaManas designs and ships AI agents and workflow automation for founder-led teams: lead research and outreach, support triage, and internal knowledge assistants.',
};

export const LIMITS = {
  urlChars: 2048,
  recipientChars: 120,
  offerChars: 500,
} as const;

const REASONING_VALUES = new Set(['none', 'minimal', 'low', 'medium', 'high']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IrisConfig {
  const problems: string[] = [];

  const str = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };

  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = str(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max} (got "${raw}").`);
      return fallback;
    }
    return value;
  };

  const bool = (name: string, fallback: boolean): boolean => {
    const raw = str(name);
    if (raw === undefined) return fallback;
    if (/^(1|true|yes|on)$/i.test(raw)) return true;
    if (/^(0|false|no|off)$/i.test(raw)) return false;
    problems.push(`${name} must be true or false (got "${raw}").`);
    return fallback;
  };

  // --- LLM -------------------------------------------------------------------
  const providerRaw = (str('LLM_PROVIDER') ?? 'groq').toLowerCase();
  const isKnownProvider = Object.hasOwn(PROVIDER_PRESETS, providerRaw);
  if (!isKnownProvider) {
    problems.push(
      `LLM_PROVIDER must be one of ${Object.keys(PROVIDER_PRESETS).join(', ')} (got "${providerRaw}").`,
    );
  }
  const provider = (isKnownProvider ? providerRaw : 'groq') as ProviderId;
  const preset = PROVIDER_PRESETS[provider];

  const baseUrl = (str('LLM_BASE_URL') ?? preset.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl) {
    problems.push('LLM_BASE_URL is required when LLM_PROVIDER=custom.');
  } else if (!isHttpUrl(baseUrl)) {
    problems.push(`LLM_BASE_URL must be an http(s) URL (got "${baseUrl}").`);
  }

  const model = str('LLM_MODEL') ?? preset.model;
  if (!model) problems.push(`LLM_MODEL is required for LLM_PROVIDER=${provider}.`);

  const apiKey = str('LLM_API_KEY');
  if (preset.requiresKey && !apiKey) {
    problems.push(
      `LLM_API_KEY is required for LLM_PROVIDER=${provider}.` +
        (preset.keyUrl ? ` Create a free key at ${preset.keyUrl} and add it to .env.` : ''),
    );
  }

  const jsonModeRaw = (str('LLM_JSON_MODE') ?? 'json_object').toLowerCase();
  if (jsonModeRaw !== 'json_object' && jsonModeRaw !== 'off') {
    problems.push(`LLM_JSON_MODE must be json_object or off (got "${jsonModeRaw}").`);
  }

  const reasoningRaw = str('LLM_REASONING_EFFORT')?.toLowerCase();
  let reasoningEffort = preset.reasoningEffort;
  if (reasoningRaw === 'off') reasoningEffort = undefined;
  else if (reasoningRaw !== undefined) {
    if (REASONING_VALUES.has(reasoningRaw)) reasoningEffort = reasoningRaw;
    else problems.push(`LLM_REASONING_EFFORT must be off, none, minimal, low, medium or high (got "${reasoningRaw}").`);
  }

  let temperature: number | undefined;
  const temperatureRaw = str('LLM_TEMPERATURE');
  if (temperatureRaw !== undefined) {
    const value = Number(temperatureRaw);
    if (Number.isFinite(value) && value >= 0 && value <= 2) temperature = value;
    else problems.push(`LLM_TEMPERATURE must be a number from 0 to 2 (got "${temperatureRaw}").`);
  }

  // --- Sender ----------------------------------------------------------------
  const sender: SenderProfile = {
    name: str('SENDER_NAME') ?? DEFAULT_SENDER.name,
    company: str('SENDER_COMPANY') ?? DEFAULT_SENDER.company,
    offer: str('SENDER_OFFER') ?? DEFAULT_SENDER.offer,
  };
  if (sender.name.length > 80) problems.push('SENDER_NAME must be 80 characters or fewer.');
  if (sender.company.length > 80) problems.push('SENDER_COMPANY must be 80 characters or fewer.');
  if (sender.offer.length > LIMITS.offerChars) {
    problems.push(`SENDER_OFFER must be ${LIMITS.offerChars} characters or fewer.`);
  }

  const config: IrisConfig = {
    llm: {
      provider,
      baseUrl,
      apiKey,
      model: model ?? '',
      maxTokensParam: preset.maxTokensParam,
      reasoningEffort,
      jsonMode: jsonModeRaw === 'off' ? 'off' : 'json_object',
      temperature,
      timeoutMs: int('LLM_TIMEOUT_SECONDS', 45, 5, 300) * 1000,
    },
    sender,
    fetch: {
      allowPrivateHosts: bool('IRIS_ALLOW_PRIVATE_HOSTS', false),
      pageTimeoutMs: int('FETCH_TIMEOUT_SECONDS', 8, 2, 60) * 1000,
      maxPageBytes: 1_500_000,
      maxPages: int('FETCH_MAX_PAGES', 4, 1, 6),
      maxRedirects: 4,
      textBudgetChars: 9_000,
    },
    server: {
      host: str('HOST') ?? '127.0.0.1',
      port: int('PORT', 3000, 1, 65_535),
      trustProxyHops: int('TRUST_PROXY_HOPS', 0, 0, 5),
      rateLimitPerIp: int('RATE_LIMIT_PER_IP', 5, 1, 10_000),
      rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MINUTES', 10, 1, 1_440) * 60_000,
      dailyRunLimit: int('DAILY_RUN_LIMIT', 25, 1, 1_000_000),
      maxConcurrentRuns: int('MAX_CONCURRENT_RUNS', 2, 1, 50),
      cacheTtlMs: int('CACHE_TTL_MINUTES', 360, 0, 10_080) * 60_000,
      cacheMaxEntries: 200,
    },
    runTimeoutMs: int('RUN_TIMEOUT_SECONDS', 90, 15, 600) * 1000,
  };

  if (problems.length > 0) {
    throw new IrisError(
      'CONFIG_ERROR',
      `Configuration problem${problems.length > 1 ? 's' : ''}:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
  return config;
}

/** Loads ./.env when present. Variables already set in the environment take precedence. */
export function loadDotEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
