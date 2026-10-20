import { MailError } from './errors.js';

export interface PageCursor {
  v: 1 | 2 | 3;
  offset?: number;
  /** Last UID returned on the previous page. The next page starts after this UID in the same order. */
  afterUid?: number;
  /** Index in the sorted result where the next page starts. Independent of UID order. */
  position?: number;
  uidValidity?: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  nextCursor?: string;
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(value: string, expectedUidValidity?: string): PageCursor {
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
  const record = parsed as {
    v?: unknown;
    offset?: unknown;
    afterUid?: unknown;
    position?: unknown;
    uidValidity?: unknown;
  };
  const version = record.v;
  if (version !== 1 && version !== 2 && version !== 3) {
    throw new MailError('INVALID_ARGUMENT', 'The page cursor is not valid.');
  }
  if (
    version === 1 &&
    (typeof record.offset !== 'number' || !Number.isInteger(record.offset) || record.offset < 0)
  ) {
    throw new MailError('INVALID_ARGUMENT', 'The page cursor is not valid.');
  }
  if (
    version === 2 &&
    (typeof record.afterUid !== 'number' ||
      !Number.isInteger(record.afterUid) ||
      record.afterUid < 1)
  ) {
    throw new MailError('INVALID_ARGUMENT', 'The page cursor is not valid.');
  }
  if (
    version === 3 &&
    (typeof record.position !== 'number' ||
      !Number.isInteger(record.position) ||
      record.position < 0)
  ) {
    throw new MailError('INVALID_ARGUMENT', 'The page cursor is not valid.');
  }
  const cursor: PageCursor = {
    v: version,
    ...(typeof record.offset === 'number' ? { offset: record.offset } : {}),
    ...(typeof record.afterUid === 'number' ? { afterUid: record.afterUid } : {}),
    ...(typeof record.position === 'number' ? { position: record.position } : {}),
    ...(typeof record.uidValidity === 'string' ? { uidValidity: record.uidValidity } : {}),
  };
  if (expectedUidValidity && cursor.uidValidity && cursor.uidValidity !== expectedUidValidity) {
    throw new MailError(
      'UIDVALIDITY_CHANGED',
      `This page token was issued for UIDVALIDITY ${cursor.uidValidity}, but the mailbox is now ${expectedUidValidity}.`,
      'Repeat the list or search without a cursor.',
    );
  }
  return cursor;
}

export function clampLimit(requested: number | undefined, fallback: number, max: number): number {
  const value = requested ?? fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new MailError('INVALID_ARGUMENT', `limit must be an integer between 1 and ${max}.`);
  }
  if (value > max) {
    throw new MailError(
      'SIZE_LIMIT',
      `limit ${value} exceeds the configured maximum of ${max}.`,
      'Lower limit or raise limits.maxPageSize in the configuration.',
    );
  }
  return value;
}

/**
 * Slice `ordered` at `position`. `ordered` is already in sort order, so the next page
 * is the next slice of that result even when UIDs and internal dates disagree.
 */
export function pageByPosition(
  ordered: readonly number[],
  limit: number,
  position: number,
  uidValidity?: string,
): { uids: number[]; nextCursor: string | null; offset: number } {
  if (!Number.isInteger(position) || position < 0) {
    throw new MailError('INVALID_ARGUMENT', 'The page cursor is not valid.');
  }
  const uids = ordered.slice(position, position + limit);
  const next = position + uids.length;
  const nextCursor =
    next < ordered.length
      ? encodeCursor({ v: 3, position: next, ...(uidValidity ? { uidValidity } : {}) })
      : null;
  return { uids, nextCursor, offset: position };
}

/** Slice an ordered UID list after `afterUid`. The list is in sort order, not numeric UID order. */
export function pageAfterUid(
  ordered: readonly number[],
  limit: number,
  afterUid: number | undefined,
  uidValidity?: string,
): { uids: number[]; nextCursor: string | null; offset: number } {
  let start = 0;
  if (afterUid !== undefined) {
    const index = ordered.indexOf(afterUid);
    if (index < 0) {
      throw new MailError(
        'INVALID_ARGUMENT',
        `The page cursor points at UID ${afterUid}, which is no longer in this result.`,
        'Repeat the list or search without a cursor.',
      );
    }
    start = index + 1;
  }
  const uids = ordered.slice(start, start + limit);
  const last = uids[uids.length - 1];
  const nextCursor =
    last !== undefined && start + uids.length < ordered.length
      ? encodeCursor({ v: 2, afterUid: last, ...(uidValidity ? { uidValidity } : {}) })
      : null;
  return { uids, nextCursor, offset: start };
}

export function paginate<T>(items: readonly T[], offset: number, limit: number): Page<T> {
  const slice = items.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  const page: Page<T> = {
    items: [...slice],
    total: items.length,
    offset,
    limit,
  };
  if (nextOffset < items.length) {
    page.nextCursor = encodeCursor({ v: 1, offset: nextOffset });
  }
  return page;
}
