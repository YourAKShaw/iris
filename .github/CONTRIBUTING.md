<div align="center">

# 🤝 Contributing to Iris

**Help make outreach research more accurate, more useful, and harder to fool.**

[![CI](https://github.com/YourAKShaw/iris/actions/workflows/ci.yml/badge.svg)](https://github.com/YourAKShaw/iris/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-334155?style=flat-square)](../.nvmrc)
[![License: MIT](https://img.shields.io/badge/License-MIT-5B3FD6?style=flat-square)](../LICENSE)

[Project overview](README.md) · [Get help](SUPPORT.md) · [Security policy](SECURITY.md)

</div>

---

## Start with the outcome

Iris has one promise: every fact an email uses was quoted, word for word, from the prospect's own website. Contributions should make that promise stronger, make the drafts more useful, or make Iris easier to run for free.

Useful contributions include:

- A real website where extraction, page discovery or quote verification goes wrong, with the URL and what you expected.
- A prompt or validation change that measurably improves drafts without weakening grounding.
- A provider preset for another OpenAI-compatible API with a usable free tier.
- A defence against a prompt-injection or SSRF case the tests do not yet cover.
- Clearer setup, deployment or troubleshooting docs.

## 🧭 Choose the right starting point

| Contribution | Where to begin |
| :--- | :--- |
| Small fix or doc correction | Open a pull request with the problem and how you verified the fix. |
| Bug, bad output on a real site, or doc issue | Search existing issues, then use the matching [issue form](https://github.com/YourAKShaw/iris/issues/new/choose). |
| New feature, new dependency, or a change to the result JSON | Open an issue first with the use case, trade-offs and proposed scope. |
| Security vulnerability | Report it privately; see [SECURITY.md](SECURITY.md). |
| Usage question | Follow the [support guide](SUPPORT.md). |

## 🛠️ Set up a development environment

Requirements: **Node.js 22.12 or later** (`.nvmrc` pins 22) and npm.

```sh
git clone https://github.com/YourAKShaw/iris.git
cd iris
npm install
cp .env.example .env        # add a free LLM_API_KEY to try real runs
npm run check               # type-check, lint, tests
```

The test suite needs no API key and no internet access. It starts a local fixture website and a fake OpenAI-compatible model server, so the real fetcher, HTTP client, parsing and verification code all run.

| Command | What it does |
| :--- | :--- |
| `npm run dev -- <url>` | Run the CLI from source |
| `npm run dev:serve` | Run the web app from source and restart on changes |
| `npm run typecheck` | Strict TypeScript check of `src/` and `test/` |
| `npm run lint` | ESLint, including `public/app.js` |
| `npm test` | Node's built-in test runner over `test/**/*.test.ts` |
| `npm run build` | Compile to `dist/` |

## Make a focused change

1. Fork the repository and create a branch.
2. Read the module you are changing and its tests. The pipeline is described in the [README](README.md#-how-it-works).
3. Make the smallest coherent change. Add or update tests at the boundary you touched.
4. Run `npm run check && npm run build` and read your full diff.
5. Open a pull request using the [template](pull_request_template.md).

### Keep these properties intact

| Property | What to preserve |
| :--- | :--- |
| **Grounded drafts** | Outreach is written only from signals that passed `verifyResearch`. Never let unverified model output reach the email prompt. |
| **Untrusted input stays untrusted** | Website text and model output are data. Validate model output with a schema, render it with `textContent` in the browser, and strip control characters in the terminal. |
| **SSRF protection** | Every outbound fetch to a user-supplied URL goes through `assertFetchableUrl` and the connect-time `createGuardedLookup`, including redirects. |
| **Free-tier friendly** | Each run makes two model calls plus at most one repair each. Discuss anything that adds calls or a lot of prompt tokens first. |
| **Small dependency surface** | The runtime depends only on `zod`. New dependencies need a clear reason in the PR. |
| **Honest docs** | Separate what was tested from what is expected. Provider limits change: link the source and date it. |

### Changing prompts or models

Prompt changes are behavior changes. In your PR, include at least one real public website you tried, the model and provider, what changed in the output, and how many claims were verified versus dropped before and after. Report only what you observed.

## 📬 Pull request expectations

- **Problem and outcome:** what failed or was missing, and what the change improves.
- **Verification:** exact commands and results; any live runs described without keys.
- **Risks:** changes to prompts, schemas, result JSON, configuration or security controls.

Keep the diff focused and the discussion respectful. Address the change, not the contributor.
