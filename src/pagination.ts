import { MailError } from './errors.js';

export interface PageCursor {
  v: 1;
  offset: number;
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
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { v?: unknown }).v !== 1 ||
    typeof (parsed as { offset?: unknown }).offset !== 'number' ||
    !Number.isInteger((parsed as { offset: number }).offset) ||
    (parsed as { offset: number }).offset < 0
  ) {
    throw new MailError('INVALID_ARGUMENT', 'The page cursor is not valid.');
  }
  const cursor = parsed as PageCursor;
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
