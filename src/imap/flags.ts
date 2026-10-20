import { MailError } from '../errors.js';

const SYSTEM = new Set(['\\Seen', '\\Answered', '\\Flagged', '\\Deleted', '\\Draft', '\\Recent']);

const ALIASES: Record<string, string> = {
  seen: '\\Seen',
  answered: '\\Answered',
  flagged: '\\Flagged',
  deleted: '\\Deleted',
  draft: '\\Draft',
};

/**
 * Normalize a flag or keyword to the form IMAP stores.
 * System flags gain a leading backslash. Custom keywords are left intact.
 */
export function normalizeFlag(flag: string): string {
  const trimmed = flag.trim();
  if (!trimmed) {
    throw new MailError('INVALID_ARGUMENT', 'A flag name was empty.');
  }
  const bare = trimmed.toLowerCase().replace(/^\\/, '');
  if (bare === 'recent') {
    throw new MailError(
      'INVALID_ARGUMENT',
      'The \\Recent flag is set by the server and cannot be stored by a client.',
    );
  }
  const alias = ALIASES[bare];
  if (alias) {
    return alias;
  }
  if (trimmed.startsWith('\\')) {
    const canonical = `\\${trimmed.slice(1)}`;
    if (!SYSTEM.has(canonical) && trimmed.length < 2) {
      throw new MailError('INVALID_ARGUMENT', `Flag "${flag}" is not valid.`);
    }
    return trimmed;
  }
  if (/[\s()]/.test(trimmed)) {
    throw new MailError(
      'INVALID_ARGUMENT',
      `Keyword "${trimmed}" cannot contain spaces or parentheses.`,
    );
  }
  return trimmed;
}

export function normalizeFlags(flags: readonly string[]): string[] {
  const out: string[] = [];
  for (const flag of flags) {
    const normalized = normalizeFlag(flag);
    if (!out.includes(normalized)) {
      out.push(normalized);
    }
  }
  return out;
}

export function touchesDeleted(flags: readonly string[]): boolean {
  return normalizeFlags(flags).includes('\\Deleted');
}

export function flagsToList(flags: Iterable<string> | undefined): string[] {
  if (!flags) {
    return [];
  }
  return [...flags].map((flag) =>
    ALIASES[flag.toLowerCase().replace(/^\\/, '')] ? normalizeFlag(flag) : flag,
  );
}
