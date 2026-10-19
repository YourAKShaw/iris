import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import { IrisError, isIrisError } from './errors.js';
import { assertFetchableUrl, createGuardedLookup, type Resolver } from './net-guard.js';
import { extractDocument, pickCandidateLinks } from './extract.js';
import type { FetchConfig } from './config.js';
import { USER_AGENT } from './version.js';

export interface SourcePage {
  url: string;
  title: string;
  description: string;
  text: string;
}

export interface CrawlResult {
  finalUrl: string;
  siteName: string;
  pages: SourcePage[];
  skipped: Array<{ url: string; reason: string }>;
  totalChars: number;
}

export interface FetchOptions extends FetchConfig {
  signal?: AbortSignal | undefined;
  resolver?: Resolver | undefined;
}

interface HtmlResponse {
  url: string;
  status: number;
  contentType: string;
  html: string;
}

/** Fetches one HTML page with SSRF checks on every hop, a deadline, and size limits. */
export async function fetchHtml(input: string | URL, options: FetchOptions): Promise<HtmlResponse> {
  let current = new URL(input);
  for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
    assertFetchableUrl(current, options);
    const response = await requestOnce(current, options);
    if (response.location !== undefined) {
      let next: URL;
      try {
        next = new URL(response.location, current);
      } catch {
        throw new IrisError('FETCH_FAILED', 'The site sent an invalid redirect.');
      }
      current = next;
      continue;
    }
    return { url: current.toString(), status: response.status, contentType: response.contentType, html: response.body };
  }
  throw new IrisError('FETCH_FAILED', 'The site redirected too many times.');
}

interface RawResponse {
  status: number;
  contentType: string;
  location: string | undefined;
  body: string;
}

function requestOnce(url: URL, options: FetchOptions): Promise<RawResponse> {
  const deadline = AbortSignal.timeout(options.pageTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const client = url.protocol === 'https:' ? https : http;

  return new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(mapNetworkError(error, options.signal, deadline, options.pageTimeoutMs));
    };

    const request = client.request(
      url,
      {
        method: 'GET',
        agent: false,
        lookup: createGuardedLookup(options, options.resolver),
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'accept-encoding': 'gzip, deflate, br',
          'accept-language': 'en;q=0.9, *;q=0.5',
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          settled = true;
          resolve({ status, contentType: '', location, body: '' });
          return;
        }

        const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
        const encoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase().trim();
        let stream: Readable = response;
        if (encoding === 'gzip' || encoding === 'x-gzip') stream = response.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = response.pipe(zlib.createInflate());
        else if (encoding === 'br') stream = response.pipe(zlib.createBrotliDecompress());
        else if (encoding !== 'identity' && encoding !== '') {
          fail(new IrisError('FETCH_FAILED', `The site used an unsupported content encoding (${encoding}).`));
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        const finish = () => {
          if (settled) return;
          settled = true;
          request.destroy();
          resolve({ status, contentType, location: undefined, body: decodeBody(Buffer.concat(chunks), contentType) });
        };
        stream.on('data', (chunk: Buffer) => {
          if (settled) return;
          const room = options.maxPageBytes - size;
          if (chunk.length >= room) {
            // Keep the first maxPageBytes (decompressed) and stop: also bounds decompression bombs.
            chunks.push(chunk.subarray(0, room));
            size += room;
            finish();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        stream.on('end', finish);
        stream.on('error', fail);
        response.on('error', fail);
      },
    );
    request.on('error', fail);
    // Belt and braces: guarantee the promise settles even if a stream never emits 'error'.
    signal.addEventListener('abort', () => fail(signal.reason), { once: true });
    request.end();
  });
}

function decodeBody(buffer: Buffer, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8', { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }
}

function mapNetworkError(error: unknown, outer: AbortSignal | undefined, deadline: AbortSignal, timeoutMs: number): IrisError {
  if (isIrisError(error)) return error;
  if (outer?.aborted) return new IrisError('ABORTED', 'The run was cancelled.');
  if (deadline.aborted) {
    return new IrisError('FETCH_FAILED', `The site did not respond within ${Math.round(timeoutMs / 1000)} seconds.`);
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? '';
  const detail = error instanceof Error ? `${code} ${error.message}`.trim() : String(error);
  if (code === 'URL_BLOCKED' && error instanceof Error) return new IrisError('URL_BLOCKED', error.message);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new IrisError('FETCH_FAILED', "Couldn't find that domain. Check the website address.", { detail });
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') {
    return new IrisError('FETCH_FAILED', 'The site refused or dropped the connection.', { detail });
  }
  if (/CERT|SSL|TLS|SELF_SIGNED/i.test(code)) {
    return new IrisError('FETCH_FAILED', "The site's TLS certificate could not be verified.", { detail });
  }
  return new IrisError('FETCH_FAILED', "Couldn't load the website.", { detail });
}

function isHtml(contentType: string): boolean {
  return contentType === '' || contentType.includes('text/html') || contentType.includes('application/xhtml');
}

/**
 * Reads the start page plus up to `maxPages - 1` same-site pages (about, pricing, customers…),
 * and trims each to a share of the text budget so prompts stay within free-tier token limits.
 */
export async function crawlSite(
  startUrl: string,
  options: FetchOptions,
  onPage?: (url: string) => void,
): Promise<CrawlResult> {
  const start = await fetchHtml(startUrl, options);
  if (start.status >= 400) {
    throw new IrisError('FETCH_FAILED', `The site answered with HTTP ${start.status}.`);
  }
  if (!isHtml(start.contentType)) {
    throw new IrisError('NOT_HTML', 'That URL is not a web page (expected HTML).');
  }
  onPage?.(start.url);

  const startDoc = extractDocument(start.html);
  const candidates = pickCandidateLinks(startDoc.links, new URL(start.url), options.maxPages - 1);
  const skipped: CrawlResult['skipped'] = [];

  const extra = await Promise.allSettled(
    candidates.map(async (url) => {
      const page = await fetchHtml(url, options);
      if (page.status >= 400) throw new IrisError('FETCH_FAILED', `HTTP ${page.status}`);
      if (!isHtml(page.contentType)) throw new IrisError('NOT_HTML', 'not HTML');
      onPage?.(page.url);
      return { url: page.url, doc: extractDocument(page.html) };
    }),
  );

  if (options.signal?.aborted) throw new IrisError('ABORTED', 'The run was cancelled.');

  const documents = [{ url: start.url, doc: startDoc }];
  extra.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      if (!documents.some((d) => d.url === result.value.url)) documents.push(result.value);
    } else {
      const reason = isIrisError(result.reason) ? result.reason.message : 'failed';
      skipped.push({ url: candidates[index]!, reason });
    }
  });

  // The start page gets the largest share; supporting pages split the rest.
  const budget = options.textBudgetChars;
  const startShare = documents.length === 1 ? budget : Math.round(budget * 0.45);
  const otherShare = documents.length === 1 ? 0 : Math.floor((budget - startShare) / (documents.length - 1));

  const pages: SourcePage[] = documents.map(({ url, doc }, index) => ({
    url,
    title: doc.title.slice(0, 200),
    description: doc.description.slice(0, 400),
    text: truncateAtLine(doc.text, index === 0 ? startShare : otherShare),
  }));

  const totalChars = pages.reduce((sum, p) => sum + p.text.length + p.description.length, 0);
  if (totalChars < 200) {
    throw new IrisError(
      'SITE_TOO_THIN',
      'Iris could not find enough readable text on that site. It may render its content with JavaScript, which Iris does not execute.',
    );
  }

  return {
    finalUrl: start.url,
    siteName: startDoc.siteName || startDoc.title.split(/\s[|–—-]\s/)[0]?.trim() || new URL(start.url).hostname,
    pages,
    skipped,
    totalChars,
  };
}

function truncateAtLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  return text.slice(0, cut > max * 0.6 ? cut : max).trimEnd();
}
