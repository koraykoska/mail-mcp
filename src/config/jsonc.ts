import { MailError } from '../errors.js';

/**
 * Parse JSON with comments and trailing commas.
 * Strings are preserved, including comment-like sequences inside them.
 */
export function parseJsonc(text: string, source = 'config'): unknown {
  const stripped = stripJsonc(text);
  try {
    return JSON.parse(stripped) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid JSON';
    throw new MailError(
      'CONFIG_ERROR',
      `Could not parse ${source}: ${message}`,
      'The file is JSON with optional // and /* */ comments and trailing commas.',
    );
  }
}

export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < text.length) {
    const char = text[i] ?? '';
    const next = text[i + 1] ?? '';
    if (inString) {
      out += char;
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      i += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i += 1;
      }
      if (i >= text.length) {
        throw new MailError('CONFIG_ERROR', 'Unterminated block comment in configuration.');
      }
      i += 2;
      continue;
    }
    out += char;
    i += 1;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}
