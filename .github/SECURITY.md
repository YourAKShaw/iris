# Security policy

Iris fetches websites that users name and sends their text to a language model, so it treats every URL, every page and every model response as untrusted. This page describes what is defended, what is not, and how to report a problem.

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub security advisories](https://github.com/YourAKShaw/iris/security/advisories/new), not in a public issue. Include the version or commit, the affected path, steps to reproduce and the impact you observed. You should get an acknowledgement within a few days. Only the latest `main` is supported.

## What Iris defends against

| Threat | Control | Where |
| :--- | :--- | :--- |
| SSRF to internal services or cloud metadata | http(s) only, ports 80/443 only, no credentials in URLs, private/reserved hostnames refused, and the resolved IP checked **at connect time** (blocks DNS rebinding) on every redirect hop | `src/net-guard.ts`, `src/site.ts` |
| Oversized or malicious responses | 8 s deadline per page, 1.5 MB decompressed cap (bounds gzip/brotli bombs), at most 4 redirects and 4 pages | `src/site.ts` |
| Prompt injection in website text | Website text is delimited and labelled untrusted; the model has **no tools**; output is schema-validated; facts survive only if their quote exists verbatim in the fetched text; drafts containing links or placeholders are repaired once, then discarded | `src/research.ts`, `src/outreach.ts` |
| Script injection through model output | The browser renders everything with `textContent`; strict CSP (`default-src 'none'`, `script-src 'self'`); the terminal view strips control and bidi characters | `public/app.js`, `src/server.ts`, `src/format.ts` |
| Quota abuse on a public demo | JSON-only POST with a same-origin check, 8 KB body cap, per-IP window, concurrency cap, daily run budget, result cache, aborting runs when the client disconnects | `src/server.ts`, `src/limits.ts` |
| Secret leakage | The API key is only sent to the configured provider; it is never logged, returned by `/api/meta`, or included in prompts | `src/llm.ts`, `src/server.ts` |

## Known limits

- **Quote verification proves a quote exists on the page, not that the model's one-line claim paraphrases it faithfully.** Review drafts before sending; Iris never sends email itself.
- Prompt injection can still steer tone or emphasis within the rules. The controls above bound what injected text can make Iris *do*, not everything it can make the model *say*.
- Rate limits and the cache are in memory: they reset on restart and are per instance. The provider's own rate limit is the backstop.
- `TRUST_PROXY_HOPS` must match your hosting. Set too high, clients can spoof `X-Forwarded-For` to dodge per-IP limits; the daily budget still applies.
- `IRIS_ALLOW_PRIVATE_HOSTS=true` turns SSRF protection off. It exists for local tests only and logs a warning at startup.

## Data handling

Iris has no database. A run sends the fetched page text, your offer text and the recipient name you typed to your configured LLM provider, under that provider's data policy. The web app keeps finished results in memory for `CACHE_TTL_MINUTES` (default 6 hours) and logs the target hostname, outcome, timing and token counts, not page text, offers or recipient names.
