import { redactValue } from './redact.js';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
};

export interface Logger {
  level: LogLevel;
  trace(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  fatal(message: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  secrets?: readonly string[];
  stream?: NodeJS.WritableStream;
  bindings?: Record<string, unknown>;
}

/**
 * stderr logger. Stdout is reserved for the MCP stdio transport.
 */
export function createLogger(options: LoggerOptions): Logger {
  const stream = options.stream ?? process.stderr;
  const secrets = options.secrets ?? [];
  const bindings = options.bindings ?? {};
  const threshold = RANK[options.level];

  const write = (level: LogLevel, message: string, data?: Record<string, unknown>): void => {
    if (RANK[level] < threshold) {
      return;
    }
    const payload = redactValue(
      {
        ts: new Date().toISOString(),
        level,
        msg: message,
        ...bindings,
        ...data,
      },
      secrets,
    );
    stream.write(`${JSON.stringify(payload)}\n`);
  };

  const logger: Logger = {
    level: options.level,
    trace: (message, data) => write('trace', message, data),
    debug: (message, data) => write('debug', message, data),
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
    fatal: (message, data) => write('fatal', message, data),
    child(extra) {
      return createLogger({
        level: options.level,
        secrets,
        stream,
        bindings: { ...bindings, ...extra },
      });
    },
  };
  return logger;
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (!value) {
    return fallback;
  }
  const lower = value.toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(lower)) {
    return lower as LogLevel;
  }
  throw new Error(`Unknown log level "${value}". Expected one of ${LOG_LEVELS.join(', ')}.`);
}
