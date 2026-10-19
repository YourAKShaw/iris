import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { IrisError, PRE_LLM_CODES, toIrisError, type IrisErrorCode } from './errors.js';
import type { IrisConfig } from './config.js';
import type { LlmClient } from './llm.js';
import type { Resolver } from './net-guard.js';
import { parseRunInput, runIris, type IrisResult, type ProgressEvent } from './pipeline.js';
import { DailyBudget, FixedWindowLimiter, TtlCache } from './limits.js';
import { renderMarkdown } from './format.js';
import { VERSION } from './version.js';

/**
 * Zero-framework HTTP server for the hosted demo.
 *
 * POST /api/runs streams NDJSON events: {"type":"progress"} … then {"type":"result"} or {"type":"error"}.
 * Abuse controls, in order: JSON-only + same-origin check, body cap, per-IP window, cache,
 * concurrency cap, daily run budget. Client disconnects abort the run to save quota.
 */

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createJsonLogger(write: (line: string) => void = (line) => process.stdout.write(line)): Logger {
  const log = (level: string) => (message: string, fields: Record<string, unknown> = {}) =>
    write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...fields })}\n`);
  return { info: log('info'), warn: log('warn'), error: log('error') };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export interface IrisServerOptions {
  config: IrisConfig;
  llm: LlmClient;
  logger?: Logger;
  publicDir?: URL;
  resolver?: Resolver;
  now?: () => number;
}

export interface IrisServer {
  server: http.Server;
  listen(port?: number, host?: string): Promise<{ port: number; host: string }>;
  close(graceMs?: number): Promise<void>;
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};

const STATUS_BY_CODE: Record<IrisErrorCode, number> = {
  INVALID_INPUT: 400,
  URL_BLOCKED: 400,
  CONFIG_ERROR: 500,
  FETCH_FAILED: 502,
  NOT_HTML: 422,
  SITE_TOO_THIN: 422,
  INSUFFICIENT_EVIDENCE: 422,
  LLM_AUTH: 502,
  LLM_RATE_LIMITED: 429,
  LLM_BAD_REQUEST: 502,
  LLM_UNAVAILABLE: 502,
  LLM_TIMEOUT: 504,
  LLM_BAD_OUTPUT: 502,
  RATE_LIMITED: 429,
  BUSY: 503,
  ABORTED: 499,
  INTERNAL: 500,
};

const STATIC_FILES: Record<string, { file: string; type: string; cache: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8', cache: 'public, max-age=300' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8', cache: 'public, max-age=300' },
  '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml', cache: 'public, max-age=86400' },
  '/fonts/newsreader.woff2': { file: 'fonts/newsreader.woff2', type: 'font/woff2', cache: 'public, max-age=604800' },
  '/fonts/newsreader-italic.woff2': { file: 'fonts/newsreader-italic.woff2', type: 'font/woff2', cache: 'public, max-age=604800' },
  '/fonts/hanken-grotesk.woff2': { file: 'fonts/hanken-grotesk.woff2', type: 'font/woff2', cache: 'public, max-age=604800' },
};

const MAX_BODY_BYTES = 8 * 1024;
const DEFAULT_PUBLIC_DIR = new URL('../public/', import.meta.url);

type RunEvent =
  | ({ type: 'progress' } & ProgressEvent)
  | { type: 'result'; cached: boolean; result: IrisResult; markdown: string }
  | { type: 'error'; error: { code: IrisErrorCode; message: string; retryAfterSeconds?: number | undefined } };

export async function createIrisServer(options: IrisServerOptions): Promise<IrisServer> {
  const { config, llm } = options;
  const logger = options.logger ?? createJsonLogger();
  const now = options.now ?? Date.now;

  const assets = new Map<string, Buffer>();
  for (const { file } of Object.values(STATIC_FILES)) {
    if (!assets.has(file)) {
      assets.set(file, await readFile(fileURLToPath(new URL(file, options.publicDir ?? DEFAULT_PUBLIC_DIR))));
    }
  }

  const perIp = new FixedWindowLimiter(config.server.rateLimitPerIp, config.server.rateLimitWindowMs, now);
  const budget = new DailyBudget(config.server.dailyRunLimit, now);
  const cache = new TtlCache<IrisResult>(config.server.cacheTtlMs, config.server.cacheMaxEntries, now);
  const active = new Set<AbortController>();
  const pruneTimer = setInterval(() => perIp.prune(), 60_000);
  pruneTimer.unref();

  if (config.fetch.allowPrivateHosts) {
    logger.warn('IRIS_ALLOW_PRIVATE_HOSTS is enabled: SSRF protection is OFF. Never use this on a public deployment.');
  }

  const server = http.createServer((req, res) => {
    const requestId = randomUUID();
    const started = now();
    res.setHeader('x-request-id', requestId);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    res.on('finish', () => {
      const path = pathOf(req);
      if (path === '/healthz') return; // platform health checks would drown out real traffic
      logger.info('request', { requestId, method: req.method, path, status: res.statusCode, ms: now() - started });
    });

    handle(req, res, requestId).catch((error: unknown) => {
      const failure = toIrisError(error);
      logger.error('unhandled', { requestId, code: failure.code, detail: failure.detail ?? failure.message });
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Unexpected server error.' } });
      else res.end();
    });
  });

  server.headersTimeout = 15_000;
  server.requestTimeout = config.runTimeoutMs + 30_000;
  server.keepAliveTimeout = 5_000;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, requestId: string): Promise<void> {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    if (path === '/healthz') {
      sendJson(res, 200, { status: 'ok', version: VERSION });
      return;
    }

    if (path === '/api/meta') {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      sendJson(res, 200, {
        version: VERSION,
        provider: llm.provider,
        model: llm.model,
        sender: config.sender,
        limits: {
          perIp: config.server.rateLimitPerIp,
          windowMinutes: Math.round(config.server.rateLimitWindowMs / 60_000),
          dailyRemaining: budget.remaining(),
        },
      });
      return;
    }

    if (path === '/api/runs') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      await handleRun(req, res, requestId);
      return;
    }

    const asset = STATIC_FILES[path];
    if (asset && (method === 'GET' || method === 'HEAD')) {
      const body = assets.get(asset.file)!;
      res.writeHead(200, { 'content-type': asset.type, 'content-length': body.length, 'cache-control': asset.cache });
      res.end(method === 'HEAD' ? undefined : body);
      return;
    }

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
  }

  async function handleRun(req: http.IncomingMessage, res: http.ServerResponse, requestId: string): Promise<void> {
    if (!sameOrigin(req)) {
      sendJson(res, 403, { error: { code: 'INVALID_INPUT', message: 'Cross-origin requests are not allowed.' } });
      return;
    }

    let input;
    try {
      input = parseRunInput(await readJsonBody(req));
    } catch (error) {
      sendError(res, toIrisError(error));
      return;
    }

    const ip = clientIp(req, config.server.trustProxyHops);
    const ipDecision = perIp.hit(ip);
    if (!ipDecision.allowed) {
      sendError(
        res,
        new IrisError('RATE_LIMITED', `You've hit the demo limit of ${config.server.rateLimitPerIp} runs per ${Math.round(config.server.rateLimitWindowMs / 60_000)} minutes. Try again later, or run Iris locally.`, {
          retryAfterSeconds: ipDecision.retryAfterSeconds,
        }),
      );
      return;
    }

    const offer = input.offer ?? config.sender.offer;
    const cacheKey = createHash('sha256').update(JSON.stringify([input.url, input.recipient ?? '', offer, llm.model])).digest('hex');
    const host = new URL(input.url).hostname;
    const cached = cache.get(cacheKey);
    if (cached) {
      startStream(res);
      writeEvent(res, { type: 'progress', stage: 'done', message: 'Served from cache (same inputs within the last few hours)' });
      writeEvent(res, { type: 'result', cached: true, result: cached, markdown: renderMarkdown(cached) });
      res.end();
      logger.info('run', { requestId, host, outcome: 'ok', cached: true });
      return;
    }

    if (active.size >= config.server.maxConcurrentRuns) {
      sendError(res, new IrisError('BUSY', 'Iris is busy with other runs right now. Try again in a few seconds.', { retryAfterSeconds: 5 }));
      return;
    }

    const budgetDecision = budget.tryConsume();
    if (!budgetDecision.allowed) {
      sendError(
        res,
        new IrisError('RATE_LIMITED', "Today's free demo quota is used up. It resets at 00:00 UTC, or you can run Iris locally with your own free API key.", {
          retryAfterSeconds: budgetDecision.retryAfterSeconds,
        }),
      );
      return;
    }

    const controller = new AbortController();
    active.add(controller);
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    const started = now();
    startStream(res);
    try {
      const result = await runIris(input, {
        config,
        llm,
        signal: controller.signal,
        resolver: options.resolver,
        onProgress: (event) => writeEvent(res, { type: 'progress', ...event }),
      });
      cache.set(cacheKey, result);
      writeEvent(res, { type: 'result', cached: false, result, markdown: renderMarkdown(result) });
      logger.info('run', {
        requestId,
        host,
        outcome: 'ok',
        cached: false,
        ms: now() - started,
        pages: result.stats.pagesRead,
        signalsVerified: result.stats.signalsVerified,
        signalsProposed: result.stats.signalsProposed,
        emails: result.emails.length,
        tokens: result.stats.promptTokens + result.stats.completionTokens,
      });
    } catch (error) {
      const failure = toIrisError(error);
      if (PRE_LLM_CODES.has(failure.code)) budget.refund();
      writeEvent(res, {
        type: 'error',
        error: { code: failure.code, message: failure.message, retryAfterSeconds: failure.retryAfterSeconds },
      });
      const level = failure.code === 'INTERNAL' ? 'error' : 'warn';
      logger[level]('run', { requestId, host, outcome: failure.code, ms: now() - started, detail: failure.detail });
    } finally {
      active.delete(controller);
      if (!res.writableEnded) res.end();
    }
  }

  return {
    server,
    listen(port = config.server.port, host = config.server.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address();
          resolve({ port: typeof address === 'object' && address ? address.port : port, host });
        });
      });
    },
    close(graceMs = 10_000) {
      clearInterval(pruneTimer);
      return new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          for (const controller of active) controller.abort();
          server.closeAllConnections();
        }, graceMs);
        force.unref();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      });
    },
  };
}

function pathOf(req: http.IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendError(res: http.ServerResponse, error: IrisError, status = STATUS_BY_CODE[error.code]): void {
  const headers: Record<string, string> = {};
  if (error.retryAfterSeconds !== undefined) headers['retry-after'] = String(error.retryAfterSeconds);
  sendJson(res, status, { error: { code: error.code, message: error.message, retryAfterSeconds: error.retryAfterSeconds } }, headers);
}

function methodNotAllowed(res: http.ServerResponse, allow: string): void {
  sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: `Use ${allow}.` } }, { allow });
}

function startStream(res: http.ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
}

function writeEvent(res: http.ServerResponse, event: RunEvent): void {
  if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
}

/** Rejects browser requests from other origins. Non-browser clients (no Origin header) are allowed. */
function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * With N trusted reverse proxies in front (TRUST_PROXY_HOPS), each appends the address it saw,
 * so the client is N entries from the right of X-Forwarded-For. Left-most entries are spoofable.
 */
export function clientIp(req: http.IncomingMessage, trustProxyHops: number): string {
  const socketIp = req.socket.remoteAddress ?? 'unknown';
  if (trustProxyHops <= 0) return socketIp;
  const header = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const candidate = chain[chain.length - trustProxyHops];
  return candidate && isIP(candidate) ? candidate : socketIp;
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] ?? '');
    if (!/^application\/json\b/i.test(type)) {
      req.resume();
      reject(new IrisError('INVALID_INPUT', 'Send a JSON body with Content-Type: application/json.'));
      return;
    }
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      req.resume();
      reject(new IrisError('INVALID_INPUT', 'Request body is too large.'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        reject(new IrisError('INVALID_INPUT', 'Request body is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new IrisError('INVALID_INPUT', 'Request body must be valid JSON.'));
      }
    });
    req.on('error', (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}
