#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config/load.js';
import { MailError, isMailError } from './errors.js';
import { startHttpServer } from './http.js';
import { createLogger, parseLogLevel } from './log.js';
import { createRuntime } from './runtime.js';
import { createMcpServer } from './server.js';
import { PACKAGE_NAME, VERSION } from './version.js';

interface ParsedArgs {
  help: boolean;
  version: boolean;
  check: boolean;
  http: boolean;
  config?: string;
  port: number;
  host: string;
  logLevel?: string;
  account?: string;
}

export async function run(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    return fail(error);
  }
  if (args.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${PACKAGE_NAME} ${VERSION}\n`);
    return 0;
  }
  let config;
  try {
    config = loadConfig({ configPath: args.config, env });
  } catch (error) {
    return fail(error);
  }
  if (args.logLevel) {
    try {
      config = { ...config, logLevel: parseLogLevel(args.logLevel) };
    } catch (error) {
      return fail(error);
    }
  }
  const logger = createLogger({ level: config.logLevel, secrets: config.secrets });
  const runtime = createRuntime({ config, logger });
  if (args.check) {
    try {
      const result = await runtime.service.verify(args.account, { imap: true, smtp: true });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok === true ? 0 : 1;
    } catch (error) {
      return fail(error);
    } finally {
      await runtime.close();
    }
  }
  const server = createMcpServer(runtime.service);
  if (args.http) {
    const http = await startHttpServer({
      service: runtime.service,
      logger,
      port: args.port,
      host: args.host,
    });
    logger.info('http listening', { url: http.url });
    process.stderr.write(`mail-mcp listening on ${http.url}\n`);
    const shutdown = async (): Promise<void> => {
      await http.close();
      await runtime.close();
    };
    activeShutdown = shutdown;
    installSignals(shutdown, logger);
    return 0;
  }
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void runtime.close();
  };
  await server.connect(transport);
  const shutdown = async (): Promise<void> => {
    await server.close();
    await runtime.close();
  };
  activeShutdown = shutdown;
  installSignals(shutdown, logger);
  return 0;
}

function installSignals(
  shutdown: () => Promise<void>,
  logger: ReturnType<typeof createLogger>,
): void {
  const once = (): void => {
    void shutdown()
      .catch((error: unknown) => {
        logger.error('shutdown failed', {
          message: error instanceof Error ? error.message : 'shutdown failed',
        });
      })
      .finally(() => process.exit(0));
  };
  process.once('SIGINT', once);
  process.once('SIGTERM', once);
}

function fail(error: unknown): number {
  const message = isMailError(error)
    ? `${error.code}: ${error.message}${error.hint ? ` (${error.hint})` : ''}`
    : error instanceof Error
      ? error.message
      : 'Unknown error';
  process.stderr.write(`${message}\n`);
  return 1;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    help: false,
    version: false,
    check: false,
    http: false,
    port: 3333,
    host: '127.0.0.1',
  };
  const rest = argv.slice(2);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--help' || token === '-h') {
      args.help = true;
    } else if (token === '--version' || token === '-v') {
      args.version = true;
    } else if (token === '--check') {
      args.check = true;
    } else if (token === '--http') {
      args.http = true;
    } else if (token === '--config') {
      args.config = requireValue(rest, index, token);
      index += 1;
    } else if (token === '--port') {
      args.port = Number(requireValue(rest, index, token));
      index += 1;
    } else if (token === '--host') {
      args.host = requireValue(rest, index, token);
      index += 1;
    } else if (token === '--log-level') {
      args.logLevel = requireValue(rest, index, token);
      index += 1;
    } else if (token === '--account') {
      args.account = requireValue(rest, index, token);
      index += 1;
    } else if (token?.startsWith('--config=')) {
      args.config = token.slice('--config='.length);
    } else {
      throw new MailError(
        'INVALID_ARGUMENT',
        `Unknown argument ${token ?? ''}.`,
        'Run mail-mcp --help.',
      );
    }
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    throw new MailError(
      'INVALID_ARGUMENT',
      '--port must be an integer from 0 to 65535. 0 picks an ephemeral port.',
    );
  }
  return args;
}

function requireValue(rest: string[], index: number, token: string): string {
  const value = rest[index + 1];
  if (!value || value.startsWith('--')) {
    throw new MailError('INVALID_ARGUMENT', `${token} requires a value.`);
  }
  return value;
}

export function helpText(): string {
  return `mail-mcp ${VERSION}

IMAP and SMTP mail client as a Model Context Protocol server.

Usage:
  mail-mcp [--config file.json] [--log-level info]
  mail-mcp --check [--account id] [--config file.json]
  mail-mcp --http [--port 3333] [--host 127.0.0.1]
  mail-mcp --help
  mail-mcp --version

Stdio is the default transport. Logs go to stderr.

Environment for a single account:
  MAIL_IMAP_HOST, MAIL_IMAP_PORT, MAIL_IMAP_SECURE, MAIL_IMAP_STARTTLS
  MAIL_SMTP_HOST, MAIL_SMTP_PORT, MAIL_SMTP_SECURE, MAIL_SMTP_STARTTLS
  MAIL_USER, MAIL_PASSWORD, MAIL_FROM
  MAIL_MCP_CONFIG, MAIL_LOG_LEVEL

See docs/CONFIGURATION.md and docs/PROVIDERS.md.
`;
}

let activeShutdown: (() => Promise<void>) | undefined;

/** Close the server started by {@link run} in this process. */
export async function shutdownActive(): Promise<void> {
  const shutdown = activeShutdown;
  activeShutdown = undefined;
  if (shutdown) {
    await shutdown();
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

/* v8 ignore start -- process entry; exercised by the packaged binary, not the in-process suite */
if (invokedDirectly) {
  run(process.argv).then(
    (code) => {
      if (code !== 0) {
        process.exit(code);
      }
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : 'fatal error';
      process.stderr.write(`${message}\n`);
      process.exit(1);
    },
  );
}
/* v8 ignore stop */
