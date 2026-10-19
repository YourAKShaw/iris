/**
 * Dependency-free HTML → text extraction tuned for feeding an LLM.
 *
 * This is deliberately not a full HTML parser: it removes non-content elements, keeps
 * light structure (headings, list items, line breaks) and collects links for page discovery.
 * Output text is also the ground truth that evidence quotes are verified against.
 */

export interface ExtractedLink {
  href: string;
  text: string;
}

export interface ExtractedDocument {
  title: string;
  description: string;
  siteName: string;
  text: string;
  links: ExtractedLink[];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  bull: '•',
  rarr: '→',
  larr: '←',
  times: '×',
  euro: '€',
  pound: '£',
  rupee: '₹',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ' ';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

const ATTRIBUTE_RE = /([^\s"'<>/=]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

export function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(ATTRIBUTE_RE)) {
    const name = match[1]!.toLowerCase();
    if (!(name in attributes)) attributes[name] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '');
  }
  return attributes;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Removes whitespace artefacts that tag stripping leaves before punctuation, e.g. "Acme 's". */
export function tidyInline(text: string): string {
  return text
    .replace(/\s+([,.;:!?%)\]}])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .replace(/\s+(['’](?:s|re|ve|ll|d|t|m)\b)/gi, '$1');
}

function stripTags(html: string): string {
  return tidyInline(collapse(decodeEntities(html.replace(/<[^>]*>/g, ' '))));
}

const REMOVED_ELEMENTS =
  'script|style|noscript|svg|template|iframe|canvas|nav|footer|form|button|select|picture|video|audio|object|dialog';
const BLOCK_ELEMENTS =
  'p|div|section|article|main|aside|header|blockquote|ul|ol|table|thead|tbody|tfoot|tr|td|th|dl|dd|dt|figure|figcaption|address|details|summary|hr|pre';

export function extractDocument(html: string): ExtractedDocument {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? stripTags(titleMatch[1]!) : '';

  const meta: Record<string, string> = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = parseAttributes(tag);
    const key = (attrs.name ?? attrs.property ?? '').toLowerCase();
    if (key && attrs.content && !(key in meta)) meta[key] = collapse(attrs.content);
  }

  const links: ExtractedLink[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = parseAttributes(match[1]!).href;
    if (href) links.push({ href: href.trim(), text: stripTags(match[2]!).slice(0, 120) });
    if (links.length >= 400) break;
  }

  let body = html;
  const bodyMatch = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(body);
  if (bodyMatch) body = bodyMatch[1]!;
  else body = body.replace(/<head\b[\s\S]*?<\/head\s*>/i, ' ');

  body = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(new RegExp(`<(${REMOVED_ELEMENTS})\\b[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), ' ')
    .replace(/<h[1-3]\b[^>]*>/gi, '\n# ')
    .replace(/<h[4-6]\b[^>]*>/gi, '\n')
    .replace(/<\/h[1-6]\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(new RegExp(`<\\/?(?:${BLOCK_ELEMENTS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]*>/g, ' ');

  const seenShortLines = new Set<string>();
  const lines: string[] = [];
  for (const rawLine of decodeEntities(body).split('\n')) {
    const line = tidyInline(collapse(rawLine));
    if (!line || /^[-#•·|]+$/.test(line)) continue;
    const content = line.replace(/^(#|-)\s+/, '');
    if (content.length < 2) continue;
    if (content.length <= 80) {
      const key = content.toLowerCase();
      if (seenShortLines.has(key)) continue; // repeated menu items, badges, CTAs
      seenShortLines.add(key);
    }
    lines.push(line);
  }

  return {
    title,
    description: meta['description'] ?? meta['og:description'] ?? meta['twitter:description'] ?? '',
    siteName: meta['og:site_name'] ?? meta['application-name'] ?? '',
    text: lines.join('\n'),
    links,
  };
}

const PAGE_PRIORITIES: Array<{ key: string; score: number; pattern: RegExp }> = [
  { key: 'about', score: 10, pattern: /\b(about|about-us|company|who-we-are|our-story|mission)\b/ },
  { key: 'pricing', score: 9, pattern: /\b(pricing|plans|price)\b/ },
  { key: 'customers', score: 8, pattern: /\b(customers|case-stud(y|ies)|success-stories|testimonials)\b/ },
  { key: 'product', score: 8, pattern: /\b(product|products|platform|features|solutions|how-it-works|services)\b/ },
  { key: 'careers', score: 6, pattern: /\b(careers|jobs|join-us|hiring|work-with-us)\b/ },
  { key: 'news', score: 5, pattern: /\b(news|press|newsroom|announcements|changelog)\b/ },
  { key: 'blog', score: 3, pattern: /\b(blog|insights|resources)\b/ },
];

const SKIP_PATH = /\b(log-?in|sign-?in|sign-?up|register|account|cart|checkout|privacy|terms|legal|cookies?|gdpr|imprint|status|support|help|docs|api|cdn-cgi|wp-admin|wp-json|feed|rss)\b/;
const SKIP_EXTENSION = /\.(pdf|png|jpe?g|gif|webp|svg|ico|zip|gz|mp4|mp3|mov|css|js|json|xml|txt|csv|docx?|xlsx?|pptx?)$/i;

export function siteKey(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

/** Picks up to `max` same-site pages most likely to contain outreach-relevant facts. */
export function pickCandidateLinks(links: ExtractedLink[], base: URL, max: number): string[] {
  if (max <= 0) return [];
  const baseKey = siteKey(base.hostname);
  const basePath = normalizedPath(base);
  const best = new Map<string, { url: string; score: number }>();
  const seen = new Set<string>([basePath]);

  for (const link of links) {
    if (/^(mailto|tel|javascript|data):/i.test(link.href) || link.href.startsWith('#')) continue;
    let url: URL;
    try {
      url = new URL(link.href, base);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (siteKey(url.hostname) !== baseKey) continue;
    url.hash = '';
    url.search = '';
    const path = normalizedPath(url);
    if (seen.has(path) || path.split('/').length > 4) continue;
    const haystack = `${path} ${link.text.toLowerCase().replace(/\s+/g, '-')}`;
    if (SKIP_PATH.test(path) || SKIP_EXTENSION.test(path)) continue;

    for (const { key, score, pattern } of PAGE_PRIORITIES) {
      if (!pattern.test(haystack)) continue;
      const depthPenalty = path.split('/').length - 2; // shallower pages first
      const current = best.get(key);
      const adjusted = score - depthPenalty * 0.5;
      if (!current || adjusted > current.score) best.set(key, { url: url.toString(), score: adjusted });
      seen.add(path);
      break;
    }
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((entry) => entry.url);
}

function normalizedPath(url: URL): string {
  const path = url.pathname.toLowerCase().replace(/\/+$/, '');
  return path === '' ? '/' : path;
}
