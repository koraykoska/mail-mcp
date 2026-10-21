import { MailError } from '../errors.js';
import { compareSortable, type SortKey, type SortableMessage } from '../imap/sort.js';

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_SUMMARY_PAGE = 200;
export const MAX_BODY_PAGE = 20;
export const DEFAULT_TOP_N = 10;
export const MAX_TOP_N = 100;
export const DEFAULT_THREAD_MESSAGES = 100;
export const MAX_THREAD_MESSAGES = 500;
export const DEFAULT_THREAD_ROUNDS = 4;
export const MAX_THREAD_ROUNDS = 8;

export type PageOrder = 'newest-first' | 'oldest-first';

export interface PageAnchor {
  mailbox: string;
  uid: number;
  /** Distinguishes the same UID after a UIDVALIDITY change inside one cursor. */
  uidValidity?: string;
  /** Attachment rows share a UID. The part id makes the row unique. */
  partId?: string;
  date: string;
  field: SortKey['field'];
  reverse: boolean;
  value: string;
}

export interface SnapshotFolder {
  mailbox: string;
  uidValidity: string;
  /** Highest UID that existed when the first page was taken. Later UIDs are outside this walk. */
  upperUid: number;
  matched: number;
  scanned: number;
  omitted: number;
  truncated: boolean;
}

export interface SnapshotCursor {
  v: 4;
  order: PageOrder;
  sort: SortKey[];
  cap: number;
  scope: string;
  folders: Array<{ mailbox: string; uidValidity: string; upperUid: number }>;
  anchor?: PageAnchor;
  /** Set when the page is a list of keys rather than message UIDs. */
  anchorKey?: string;
  keys?: string[];
  /**
   * Frozen excludedMatches for a thread page. One row per folder, not per
   * message, so a later page can reuse the closure without storing its ids.
   */
  excluded?: Array<{ mailbox: string; count: number }>;
}

export interface PageRow extends SortableMessage {
  mailbox: string;
  uid: number;
  uidValidity?: string;
  partId?: string;
  date?: string;
}

export function sortKeysFor(order: PageOrder, sort?: readonly SortKey[]): SortKey[] {
  if (sort && sort.length > 0) {
    return sort.map((key) => ({ field: key.field, ...(key.reverse ? { reverse: true } : {}) }));
  }
  return [{ field: 'arrival', reverse: order !== 'oldest-first' }];
}

export function orderFromKeys(keys: readonly SortKey[]): PageOrder {
  const first = keys[0];
  if (!first) {
    return 'newest-first';
  }
  if (first.field === 'arrival' || first.field === 'date') {
    return first.reverse ? 'newest-first' : 'oldest-first';
  }
  return first.reverse ? 'newest-first' : 'oldest-first';
}

/** Total order: requested keys, then date, folder path, and UID. */
export function comparePageRows(left: PageRow, right: PageRow, keys: readonly SortKey[]): number {
  for (const key of keys) {
    const compared = compareSortable(left, right, key.field);
    if (compared !== 0) {
      return key.reverse ? -compared : compared;
    }
  }
  const date = compareSortable(left, right, 'date');
  if (date !== 0) {
    return date;
  }
  if (left.mailbox < right.mailbox) {
    return -1;
  }
  if (left.mailbox > right.mailbox) {
    return 1;
  }
  if (left.uid !== right.uid) {
    return left.uid - right.uid;
  }
  const leftPart = left.partId ?? '';
  const rightPart = right.partId ?? '';
  if (leftPart < rightPart) {
    return -1;
  }
  if (leftPart > rightPart) {
    return 1;
  }
  return 0;
}

export function orderRows<T extends PageRow>(rows: readonly T[], keys: readonly SortKey[]): T[] {
  return [...rows].sort((left, right) => comparePageRows(left, right, keys));
}

export function encodeSnapshotCursor(cursor: SnapshotCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeSnapshotCursor(value: string): SnapshotCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new MailError(
      'INVALID_ARGUMENT',
      'The page cursor is not valid.',
      'Omit cursor to start from the first page.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new MailError('INVALID_ARGUMENT', 'The page cursor is not valid.');
  }
  const record = parsed as { v?: unknown };
  if (record.v !== 4) {
    throw new MailError(
      'INVALID_ARGUMENT',
      'The page cursor is not valid.',
      'Omit cursor to start from the first page.',
    );
  }
  return readCursor(parsed);
}

function readCursor(parsed: unknown): SnapshotCursor {
  const record = parsed as Record<string, unknown>;
  if (record.order !== 'newest-first' && record.order !== 'oldest-first') {
    throw new MailError('INVALID_ARGUMENT', 'The page cursor is not valid.');
  }
  if (
    !Array.isArray(record.sort) ||
    typeof record.scope !== 'string' ||
    typeof record.cap !== 'number'
  ) {
    throw new MailError('INVALID_ARGUMENT', 'The page cursor is not valid.');
  }
  if (!Array.isArray(record.folders)) {
    throw new MailError('INVALID_ARGUMENT', 'The page cursor is not valid.');
  }
  const sort: SortKey[] = record.sort.map((item) => {
    const key = item as { field?: unknown; reverse?: unknown };
    if (typeof key.field !== 'string') {
      throw new MailError('INVALID_ARGUMENT', 'The page cursor is not valid.');
    }
    return {
      field: key.field as SortKey['field'],
      ...(key.reverse === true ? { reverse: true } : {}),
    };
  });
  const folders = record.folders.map((item) => {
    const folder = item as { mailbox?: unknown; uidValidity?: unknown; upperUid?: unknown };
    if (
      typeof folder.mailbox !== 'string' ||
      typeof folder.uidValidity !== 'string' ||
      typeof folder.upperUid !== 'number' ||
      !Number.isInteger(folder.upperUid) ||
      folder.upperUid < 0
    ) {
      throw new MailError('INVALID_ARGUMENT', 'The page cursor is not valid.');
    }
    return { mailbox: folder.mailbox, uidValidity: folder.uidValidity, upperUid: folder.upperUid };
  });
  const cursor: SnapshotCursor = {
    v: 4,
    order: record.order,
    sort,
    cap: record.cap,
    scope: record.scope,
    folders,
  };
  if (record.anchor !== undefined) {
    cursor.anchor = readAnchor(record.anchor);
  }
  if (typeof record.anchorKey === 'string') {
    cursor.anchorKey = record.anchorKey;
  }
  if (Array.isArray(record.keys) && record.keys.every((item) => typeof item === 'string')) {
    cursor.keys = record.keys;
  }
  if (record.excluded !== undefined) {
    if (!Array.isArray(record.excluded) || record.excluded.length > 500) {
      throw new MailError('INVALID_ARGUMENT', 'The page cursor is not valid.');
    }
    cursor.excluded = record.excluded.map((item) => {
      const row = item as { mailbox?: unknown; count?: unknown };
      if (
        typeof row.mailbox !== 'string' ||
        row.mailbox.length === 0 ||
        row.mailbox.length > 1000 ||
        typeof row.count !== 'number' ||
        !Number.isInteger(row.count) ||
        row.count < 0
      ) {
        throw new MailError('INVALID_ARGUMENT', 'The page cursor is not valid.');
      }
      return { mailbox: row.mailbox, count: row.count };
    });
  }
  return cursor;
}

function readAnchor(value: unknown): PageAnchor {
  if (typeof value !== 'object' || value === null) {
    throw new MailError('INVALID_ARGUMENT', 'The page cursor is not valid.');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.mailbox !== 'string' ||
    typeof record.uid !== 'number' ||
    typeof record.date !== 'string' ||
    typeof record.field !== 'string' ||
    typeof record.reverse !== 'boolean' ||
    typeof record.value !== 'string'
  ) {
    throw new MailError('INVALID_ARGUMENT', 'The page cursor is not valid.');
  }
  const anchor: PageAnchor = {
    mailbox: record.mailbox,
    uid: record.uid,
    date: record.date,
    field: record.field as SortKey['field'],
    reverse: record.reverse,
    value: record.value,
  };
  if (typeof record.uidValidity === 'string') {
    anchor.uidValidity = record.uidValidity;
  }
  if (typeof record.partId === 'string') {
    anchor.partId = record.partId;
  }
  return anchor;
}

export function scopeKey(paths: readonly string[]): string {
  return [...paths].sort().join('\n');
}

/**
 * Reject a cursor that belongs to a different scope, order, or folder generation.
 * A uidValidity change is CURSOR_INVALIDATED rather than a silently shifted page.
 */
export function assertCursorFits(
  cursor: SnapshotCursor,
  expected: {
    scope: string;
    order: PageOrder;
    sort: readonly SortKey[];
    cap: number;
    folders: ReadonlyArray<{ mailbox: string; uidValidity: string }>;
  },
): void {
  if (
    cursor.scope !== expected.scope ||
    cursor.order !== expected.order ||
    cursor.cap !== expected.cap ||
    sortSignature(cursor.sort) !== sortSignature(expected.sort)
  ) {
    throw new MailError(
      'CURSOR_INVALIDATED',
      'This page cursor was issued for a different order, folder scope, or cap.',
      'Repeat the call without a cursor.',
    );
  }
  for (const folder of expected.folders) {
    const stored = cursor.folders.find((item) => item.mailbox === folder.mailbox);
    if (!stored) {
      throw new MailError(
        'CURSOR_INVALIDATED',
        `This page cursor does not include ${folder.mailbox}.`,
        'Repeat the call without a cursor.',
      );
    }
    if (stored.uidValidity !== folder.uidValidity) {
      throw new MailError(
        'CURSOR_INVALIDATED',
        `UIDVALIDITY for ${folder.mailbox} is ${folder.uidValidity}, but this cursor was issued for ${stored.uidValidity}.`,
        'The mailbox was recreated. Start again without a cursor.',
      );
    }
  }
}

export interface PageSlice<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
  offset: number;
}

/**
 * Page a list that is already limited to a snapshot.
 * The next page starts strictly after the previous anchor in the total order.
 * If that anchor row was removed, the following row is returned and nothing after it is skipped.
 */
export function pageRows<T extends PageRow>(
  rows: readonly T[],
  options: {
    limit: number;
    keys: readonly SortKey[];
    cursor?: SnapshotCursor;
    buildCursor: (anchor: PageAnchor) => SnapshotCursor;
  },
): PageSlice<T> {
  const ordered = orderRows(rows, options.keys);
  let start = 0;
  const anchor = options.cursor?.anchor;
  if (anchor) {
    const index = ordered.findIndex((row) => samePageRow(row, anchor));
    if (index >= 0) {
      start = index + 1;
    } else {
      const anchorRow: PageRow = {
        mailbox: anchor.mailbox,
        uid: anchor.uid,
        date: anchor.date,
        [anchor.field]: anchor.value,
      };
      const found = ordered.findIndex((row) => comparePageRows(row, anchorRow, options.keys) > 0);
      start = found < 0 ? ordered.length : found;
    }
  }
  const items = ordered.slice(start, start + options.limit);
  const last = items[items.length - 1];
  const more = start + items.length < ordered.length;
  const primary = options.keys[0] ?? { field: 'arrival' as const, reverse: true };
  const nextCursor =
    last && more
      ? encodeSnapshotCursor(
          options.buildCursor({
            mailbox: last.mailbox,
            uid: last.uid,
            ...(last.uidValidity ? { uidValidity: last.uidValidity } : {}),
            ...(last.partId !== undefined ? { partId: last.partId } : {}),
            date: last.date ?? last.arrival ?? '',
            field: primary.field,
            reverse: Boolean(primary.reverse),
            value: canonical(last, primary.field),
          }),
        )
      : null;
  return { items, nextCursor, total: ordered.length, offset: start };
}

function samePageRow(row: PageRow, anchor: PageAnchor): boolean {
  if (row.mailbox !== anchor.mailbox || row.uid !== anchor.uid) {
    return false;
  }
  if ((row.partId ?? '') !== (anchor.partId ?? '')) {
    return false;
  }
  if (anchor.uidValidity && row.uidValidity && anchor.uidValidity !== row.uidValidity) {
    return false;
  }
  return true;
}

function sortSignature(keys: readonly SortKey[]): string {
  return JSON.stringify(
    keys.map((key) => ({ field: key.field, ...(key.reverse ? { reverse: true } : {}) })),
  );
}

function canonical(row: PageRow, field: SortKey['field']): string {
  if (field === 'size') {
    return row.size === undefined ? '' : String(row.size);
  }
  return row[field] ?? '';
}

/** Page a frozen key list. New keys are not visible until the caller drops the cursor. */
export function pageKeys(
  keys: readonly string[],
  limit: number,
  anchorKey: string | undefined,
): { keys: string[]; next: boolean; offset: number } {
  let start = 0;
  if (anchorKey !== undefined) {
    const index = keys.indexOf(anchorKey);
    if (index >= 0) {
      start = index + 1;
    } else {
      const found = keys.findIndex((key) => key > anchorKey);
      start = found < 0 ? keys.length : found;
    }
  }
  const slice = keys.slice(start, start + limit);
  return { keys: slice, next: start + slice.length < keys.length, offset: start };
}

export function snapshotPayload(folders: readonly SnapshotFolder[]): { folders: SnapshotFolder[] } {
  return {
    folders: folders.map((folder) => ({
      mailbox: folder.mailbox,
      uidValidity: folder.uidValidity,
      upperUid: folder.upperUid,
      matched: folder.matched,
      scanned: folder.scanned,
      omitted: folder.omitted,
      truncated: folder.truncated,
    })),
  };
}
