#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { loadConfig, loadDotEnv, type IrisConfig } from './config.js';
import { isIrisError, toIrisError } from './errors.js';
import { createLlmClient } from './llm.js';
import { parseRunInput, runIris } from './pipeline.js';
import { renderMarkdown, renderTerminal, safeText } from './format.js';
import { createIrisServer, createJsonLogger } from './server.js';
import { VERSION } from './version.js';

const HELP = `Iris ${VERSION}: cited lead research and outreach drafts from a company website.

Usage
  iris <company-url> [options]     Research a company and draft 3 outreach emails
  iris serve [--port N] [--host H] Start the web app (default http://127.0.0.1:3000)

Options
  -t, --to <"Name, Role">   Who the emails are for, e.g. "Priya Rao, Head of Growth"
  -o, --offer <text>        What you sell (defaults to SENDER_OFFER in .env)
      --out <file>          Also save the result (.md for Markdown, .json for JSON)
      --json                Print the full result as JSON instead of the formatted view
  -q, --quiet               Hide progress messages
  -p, --port <number>       Port for "serve" (overrides PORT)
      --host <address>      Bind address for "serve" (overrides HOST)
  -h, --help                Show this help
  -v, --version             Show the version

Examples
  iris linear.app
  iris https://posthog.com --to "Priya Rao, Head of Growth" --out posthog.md
  iris serve --port 8080

Configuration lives in .env (see .env.example). Docs: https://github.com/YourAKShaw/iris`;

const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

function useColor(stream: NodeJS.WriteStream): boolean {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(stream.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
}

function printError(error: unknown): void {
  const failure = toIrisError(error);
  const color = useColor(process.stderr);
  const mark = color ? '\u001B[31m✗\u001B[39m' : '✗';
  process.stderr.write(`${mark} ${safeText(failure.message)}\n`);
  if (process.env.IRIS_DEBUG && failure.detail) process.stderr.write(`  detail: ${safeText(failure.detail)}\n`);
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        to: { type: 'string', short: 't' },
        offer: { type: 'string', short: 'o' },
        out: { type: 'string' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nRun "iris --help" for usage.\n`);
    return EXIT.usage;
  }

  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return EXIT.ok;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.ok;
  }

  const [command, ...extra] = positionals;
  if (!command) {
    process.stderr.write(`${HELP}\n`);
    return EXIT.usage;
  }
  if (extra.length > 0) {
    process.stderr.write(`Unexpected argument: ${extra[0]}. Quote values that contain spaces.\n`);
    return EXIT.usage;
  }

  let config: IrisConfig;
  try {
    loadDotEnv();
    config = loadConfig();
  } catch (error) {
    printError(error);
    return EXIT.usage;
  }

  if (command === 'serve') return serve(config, values.port, values.host);

  let input;
  try {
    input = parseRunInput({ url: command, recipient: values.to, offer: values.offer });
  } catch (error) {
    printError(error);
    return EXIT.usage;
  }

  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const dim = (s: string) => (useColor(process.stderr) ? `\u001B[2m${s}\u001B[22m` : s);

  try {
    const result = await runIris(input, {
      config,
      llm: createLlmClient(config.llm),
      signal: controller.signal,
      onProgress: values.quiet ? undefined : (event) => process.stderr.write(`${dim('›')} ${safeText(event.message)}\n`),
    });

    if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(renderTerminal(result, { color: useColor(process.stdout), width: process.stdout.columns }));

    if (values.out) {
      const content = values.out.toLowerCase().endsWith('.json') ? `${JSON.stringify(result, null, 2)}\n` : renderMarkdown(result);
      await writeFile(values.out, content, 'utf8');
      process.stderr.write(`${dim('›')} Saved ${values.out}\n`);
    }
    return EXIT.ok;
  } catch (error) {
    printError(error);
    return isIrisError(error) && error.code === 'ABORTED' ? 130 : EXIT.failure;
  }
}

async function serve(config: IrisConfig, portFlag: string | undefined, hostFlag: string | undefined): Promise<number> {
  const port = portFlag === undefined ? config.server.port : Number(portFlag);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    process.stderr.write(`Invalid --port: ${portFlag}\n`);
    return EXIT.usage;
  }
  const logger = createJsonLogger();
  const app = await createIrisServer({ config, llm: createLlmClient(config.llm), logger });
  const address = await app.listen(port, hostFlag ?? config.server.host);
  logger.info('listening', {
    url: `http://${address.host.includes(':') ? `[${address.host}]` : address.host}:${address.port}`,
    provider: config.llm.provider,
    model: config.llm.model,
    version: VERSION,
  });

  return new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) return;
      stopping = true;
      logger.info('shutting down', { signal });
      app.close(10_000).then(() => resolve(EXIT.ok));
    };
    process.once('SIGTERM', () => stop('SIGTERM'));
    process.once('SIGINT', () => stop('SIGINT'));
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    printError(error);
    process.exitCode = EXIT.failure;
  },
);
