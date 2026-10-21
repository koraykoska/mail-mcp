import { MailError } from './errors.js';
import type { ResolvedSpecialUse } from './imap/special-use.js';

export interface ListedFolder {
  path: string;
  specialUse?: string;
  flags?: readonly string[];
}

export interface FolderRequest {
  all: boolean;
  mailboxes: string[];
  specialUse: string[];
  globs: string[];
  exclude: string[];
  includeTrash: boolean;
  includeJunk: boolean;
}

const SPECIAL_NAMES: Record<string, keyof Omit<ResolvedSpecialUse, 'sources'>> = {
  '\\inbox': 'inbox',
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\trash': 'trash',
  '\\junk': 'junk',
  '\\archive': 'archive',
  '\\all': 'all',
  '\\flagged': 'flagged',
};

/** Parse the shared `folders` argument. A string, a list, or an object. */
export function parseFolderRequest(value: unknown): FolderRequest {
  if (typeof value === 'string') {
    return fromTokens([value], {});
  }
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === 'string' && item.length > 0)) {
      throw new MailError(
        'INVALID_ARGUMENT',
        'folders must be mailbox names or special-use flags.',
      );
    }
    return fromTokens(value, {});
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const mailboxes = stringList(record.mailboxes, 'folders.mailboxes');
    const specialUse = stringList(record.specialUse, 'folders.specialUse');
    const globs = stringList(record.globs, 'folders.globs');
    const exclude = stringList(record.exclude, 'folders.exclude');
    const all = record.all === true;
    return {
      all,
      mailboxes,
      specialUse,
      globs,
      exclude,
      includeTrash: record.includeTrash === true,
      includeJunk: record.includeJunk === true,
    };
  }
  throw new MailError(
    'INVALID_ARGUMENT',
    'folders must be a mailbox, a list, or an object with all, mailboxes, specialUse, globs, and exclude.',
  );
}

function fromTokens(
  tokens: string[],
  extra: { includeTrash?: boolean; includeJunk?: boolean },
): FolderRequest {
  const request: FolderRequest = {
    all: false,
    mailboxes: [],
    specialUse: [],
    globs: [],
    exclude: [],
    includeTrash: extra.includeTrash === true,
    includeJunk: extra.includeJunk === true,
  };
  for (const token of tokens) {
    if (token === 'all') {
      request.all = true;
      continue;
    }
    if (token.startsWith('\\')) {
      request.specialUse.push(token);
      continue;
    }
    if (token.includes('*') || token.includes('?')) {
      request.globs.push(token);
      continue;
    }
    request.mailboxes.push(token);
  }
  return request;
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string' && item.length > 0)
  ) {
    throw new MailError('INVALID_ARGUMENT', `${label} must be a list of strings.`);
  }
  return value;
}

/** LIST flags that mean SELECT would fail. Matching is case-insensitive. */
const UNSELECTABLE_FLAGS = new Set(['\\noselect', '\\nonexistent']);

export function mailboxSelectable(folder: { flags?: readonly string[] }): boolean {
  return !(folder.flags ?? []).some((flag) => UNSELECTABLE_FLAGS.has(flag.toLowerCase()));
}

export function defaultThreadFolders(seedMailbox: string, special: ResolvedSpecialUse): string[] {
  const paths = [seedMailbox];
  if (special.sent) {
    paths.push(special.sent);
  }
  if (special.archive) {
    paths.push(special.archive);
  }
  if (special.all) {
    paths.push(special.all);
  }
  return uniquePaths(paths);
}

/**
 * Resolve a folder scope against LIST results.
 * `all` skips Trash and Junk unless the caller opts in or names them.
 * Explicit mailbox names are kept even when LIST did not return them.
 */
export function resolveFolderPaths(
  listed: readonly ListedFolder[],
  special: ResolvedSpecialUse,
  request: FolderRequest,
): { paths: string[]; missing: string[] } {
  const byPath = new Map(listed.map((item) => [item.path, item]));
  const excluded = new Set<string>();
  for (const token of request.exclude) {
    for (const path of expandToken(token, listed, special)) {
      excluded.add(path);
    }
  }
  const trash = special.trash;
  const junk = special.junk;
  const selected = new Set<string>();
  const missing: string[] = [];
  if (request.all) {
    for (const mailbox of listed) {
      if (mailboxSelectable(mailbox)) {
        selected.add(mailbox.path);
      }
    }
  }
  for (const token of request.specialUse) {
    const paths = expandToken(token, listed, special);
    if (paths.length === 0) {
      missing.push(token);
    }
    for (const path of paths) {
      const folder = byPath.get(path);
      if (folder && !mailboxSelectable(folder)) {
        continue;
      }
      selected.add(path);
    }
  }
  for (const pattern of request.globs) {
    let hit = false;
    for (const mailbox of listed) {
      if (!mailboxSelectable(mailbox) || !globMatch(pattern, mailbox.path)) {
        continue;
      }
      selected.add(mailbox.path);
      hit = true;
    }
    if (!hit) {
      missing.push(pattern);
    }
  }
  for (const mailbox of request.mailboxes) {
    const folder = byPath.get(mailbox);
    if (folder && !mailboxSelectable(folder)) {
      throw new MailError(
        'MAILBOX_NOT_SELECTABLE',
        `Mailbox "${mailbox}" cannot be selected.`,
        'The folder is marked \\Noselect or \\NonExistent. Open a mailbox that can hold messages.',
      );
    }
    selected.add(mailbox);
    if (!folder) {
      missing.push(mailbox);
    }
  }
  const paths: string[] = [];
  for (const path of selected) {
    if (excluded.has(path)) {
      continue;
    }
    const role = byPath.get(path)?.specialUse?.toLowerCase();
    const isTrash = path === trash || role === '\\trash';
    const isJunk = path === junk || role === '\\junk';
    const named =
      request.mailboxes.includes(path) ||
      request.specialUse.some((token) => expandToken(token, listed, special).includes(path));
    if (isTrash && !request.includeTrash && !named) {
      continue;
    }
    if (isJunk && !request.includeJunk && !named) {
      continue;
    }
    paths.push(path);
  }
  if (paths.length === 0) {
    throw new MailError(
      'NOT_FOUND',
      'The folder scope did not match any mailbox.',
      'Pass a mailbox path, a special-use flag such as \\Sent, or all.',
    );
  }
  return { paths: uniquePaths(paths).sort(comparePath), missing };
}

function expandToken(
  token: string,
  listed: readonly ListedFolder[],
  special: ResolvedSpecialUse,
): string[] {
  const field = SPECIAL_NAMES[token.toLowerCase()];
  if (field) {
    const path = special[field];
    return typeof path === 'string' ? [path] : [];
  }
  return listed.filter((item) => item.path === token).map((item) => item.path);
}

export function globMatch(pattern: string, path: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(path);
}

export function comparePath(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    out.push(path);
  }
  return out;
}
