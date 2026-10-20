import { MailError } from '../errors.js';
import {
  andSearchUid,
  compileSearch,
  type CompiledSearch,
  type SearchCriteria,
} from '../imap/search.js';
import type { ImapSession, MessageSummary, OpenMailbox } from '../imap/session.js';
import { headerValue } from '../mime/headers.js';
import {
  assertCursorFits,
  decodeSnapshotCursor,
  DEFAULT_PAGE_LIMIT,
  encodeSnapshotCursor,
  MAX_BODY_PAGE,
  MAX_SUMMARY_PAGE,
  orderFromKeys,
  pageKeys,
  pageRows,
  scopeKey,
  snapshotPayload,
  sortKeysFor,
  type PageOrder,
  type PageRow,
  type SnapshotCursor,
  type SnapshotFolder,
} from '../page/snapshot.js';
import type { SortKey } from '../imap/sort.js';

export interface PageRequest {
  limit?: number;
  cursor?: string;
  order?: PageOrder;
}

export interface FolderScan {
  mailbox: string;
  uidValidity: string;
  upperUid: number;
  matched: number;
  scanned: number;
  omitted: number;
  truncated: boolean;
  summaries: MessageSummary[];
  /** Server SORT order when the whole snapshot fit in one ordered UID list. */
  serverUids?: number[];
}

export function pageLimit(
  requested: number | undefined,
  fallback: number,
  maxPage: number,
  bodies: boolean,
): number {
  const cap = Math.min(maxPage, bodies ? MAX_BODY_PAGE : MAX_SUMMARY_PAGE);
  const size = requested ?? fallback;
  if (!Number.isInteger(size) || size < 1) {
    throw new MailError('INVALID_ARGUMENT', 'limit must be a positive integer.');
  }
  if (size > cap) {
    throw new MailError(
      'SIZE_LIMIT',
      `limit ${size} is above the maximum of ${cap}.`,
      bodies
        ? 'Calls that include bodies accept at most 20.'
        : 'Raise limits.maxPageSize, up to 200 for summaries.',
    );
  }
  return size;
}

export function resolveOrder(input: { sort?: SortKey[]; order?: PageOrder }): {
  keys: SortKey[];
  order: PageOrder;
} {
  const keys = input.sort?.length ? input.sort : sortKeysFor(input.order ?? 'newest-first');
  const derived = orderFromKeys(keys);
  if (input.order && input.sort?.length && input.order !== derived) {
    throw new MailError(
      'INVALID_ARGUMENT',
      `order ${input.order} does not match the first sort key.`,
      'Omit order, or set it to the same direction as sort.',
    );
  }
  return { keys, order: input.order && !input.sort?.length ? input.order : derived };
}

export function readPageCursor(value: string | undefined): SnapshotCursor | undefined {
  if (!value) {
    return undefined;
  }
  return decodeSnapshotCursor(value);
}

export async function scanFolders(
  session: ImapSession,
  paths: readonly string[],
  options: {
    compiled: CompiledSearch;
    keys: readonly SortKey[];
    order: PageOrder;
    cursor?: SnapshotCursor;
    maxPerFolder: number;
    singleUidValidity?: string;
    /** When true, summaries are loaded even if a server UID list is enough to page. */
    materialize?: boolean;
  },
): Promise<{ scans: FolderScan[]; sortSource: 'server' | 'client' }> {
  const scans: FolderScan[] = [];
  let sortSource: 'server' | 'client' = 'client';
  for (const mailbox of paths) {
    const scan = await session.withMailbox(mailbox, 'read', async (box) => {
      if (
        options.singleUidValidity &&
        paths.length === 1 &&
        options.singleUidValidity !== box.uidValidity
      ) {
        throw new MailError(
          'UIDVALIDITY_CHANGED',
          `UIDVALIDITY is ${box.uidValidity}, not ${options.singleUidValidity}.`,
          'List the mailbox again. UIDs from the previous session are not safe to use.',
        );
      }
      const storedUpper = options.cursor?.folders.find(
        (item) => item.mailbox === mailbox,
      )?.upperUid;
      if (storedUpper !== undefined && storedUpper < 1) {
        return emptyScan(mailbox, box, storedUpper);
      }
      // A fresh page searches every current UID and freezes the highest one.
      // Later pages reuse that bound, so mail that arrives afterwards stays out.
      // The bound is the highest UID the search returned, not a cached UIDNEXT:
      // a stale UIDNEXT would drop the newest message.
      const range = storedUpper === undefined ? '1:*' : `1:${storedUpper}`;
      const ranged = andSearchUid(options.compiled, range);
      const found = (await box.search(ranged)).filter((uid) =>
        storedUpper === undefined ? true : uid <= storedUpper,
      );
      const upperUid =
        storedUpper ?? found.reduce((highest, uid) => (uid > highest ? uid : highest), 0);
      if (upperUid < 1) {
        return emptyScan(mailbox, box, upperUid);
      }
      const matched = found.filter((uid) => uid <= upperUid);
      const canSort = session.hasCapability('SORT');
      let serverUids: number[] | undefined;
      if (canSort && matched.length > 0) {
        try {
          const sorted = await box.serverSort(ranged, [...options.keys]);
          if (sorted && !sorted.partial) {
            const allow = new Set(matched);
            serverUids = sorted.uids.filter((uid) => allow.has(uid) && uid <= upperUid);
            sortSource = paths.length === 1 ? 'server' : sortSource;
          }
        } catch (error) {
          if (
            !(error instanceof MailError) ||
            (error.code !== 'PROTOCOL_ERROR' && error.code !== 'CAPABILITY_UNSUPPORTED')
          ) {
            throw error;
          }
        }
      }
      let scannedIds = serverUids ?? matched;
      let omitted = 0;
      let truncated = false;
      if (scannedIds.length > options.maxPerFolder && !serverUids) {
        const ordered = [...scannedIds].sort((left, right) => left - right);
        const window =
          options.order === 'oldest-first'
            ? ordered.slice(0, options.maxPerFolder)
            : ordered.slice(-options.maxPerFolder);
        omitted = ordered.length - window.length;
        scannedIds = window;
        truncated = omitted > 0;
      }
      if (serverUids && serverUids.length > options.maxPerFolder && paths.length > 1) {
        omitted = serverUids.length - options.maxPerFolder;
        scannedIds = serverUids.slice(0, options.maxPerFolder);
        truncated = true;
        serverUids = scannedIds;
      }
      const fetchIds = !options.materialize && paths.length === 1 && serverUids ? [] : scannedIds;
      const summaries = await box.fetchSummaries(fetchIds, {
        snippet: false,
        snippetChars: 0,
      });
      const byUid = new Map(summaries.map((item) => [item.uid, item]));
      const orderedSummaries = fetchIds
        .map((uid) => byUid.get(uid))
        .filter((item): item is MessageSummary => Boolean(item));
      return {
        mailbox,
        uidValidity: box.uidValidity,
        upperUid,
        matched: matched.length,
        scanned: paths.length === 1 && serverUids ? serverUids.length : orderedSummaries.length,
        omitted,
        truncated,
        summaries: orderedSummaries,
        ...(serverUids ? { serverUids } : {}),
      } satisfies FolderScan;
    });
    scans.push(scan);
  }
  if (paths.length === 1 && scans[0]?.serverUids) {
    sortSource = 'server';
  }
  return { scans, sortSource };
}

function emptyScan(mailbox: string, box: OpenMailbox, upperUid: number): FolderScan {
  return {
    mailbox,
    uidValidity: box.uidValidity,
    upperUid,
    matched: 0,
    scanned: 0,
    omitted: 0,
    truncated: false,
    summaries: [],
  };
}

export interface SummaryRow extends PageRow {
  summary: MessageSummary;
  uidValidity: string;
}

export function rowsFromScans(scans: readonly FolderScan[]): SummaryRow[] {
  const rows: SummaryRow[] = [];
  for (const scan of scans) {
    for (const summary of scan.summaries) {
      rows.push(rowFromSummary(scan, summary));
    }
  }
  return rows;
}

export function rowFromSummary(
  scan: Pick<FolderScan, 'mailbox' | 'uidValidity'>,
  summary: MessageSummary,
): SummaryRow {
  return {
    mailbox: scan.mailbox,
    uid: summary.uid,
    uidValidity: scan.uidValidity,
    date: summary.date,
    arrival: summary.internalDate,
    from: summary.from[0]?.address ?? summary.from[0]?.name,
    to: summary.to[0]?.address ?? summary.to[0]?.name,
    cc: summary.cc[0]?.address,
    subject: summary.subject,
    size: summary.size,
    summary,
  };
}

export function folderPayload(scans: readonly FolderScan[]): SnapshotFolder[] {
  return scans.map((scan) => ({
    mailbox: scan.mailbox,
    uidValidity: scan.uidValidity,
    upperUid: scan.upperUid,
    matched: scan.matched,
    scanned: scan.scanned,
    omitted: scan.omitted,
    truncated: scan.truncated,
  }));
}

export function pageSummaryRows(
  rows: readonly SummaryRow[],
  options: {
    limit: number;
    keys: readonly SortKey[];
    order: PageOrder;
    cursor?: SnapshotCursor;
    scope: string;
    folders: readonly SnapshotFolder[];
  },
): { items: SummaryRow[]; nextCursor: string | null; total: number; offset: number } {
  if (options.cursor) {
    assertCursorFits(options.cursor, {
      scope: options.scope,
      order: options.order,
      sort: options.keys,
      cap: options.limit,
      folders: options.folders,
    });
  }
  return pageRows(rows, {
    limit: options.limit,
    keys: options.keys,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    buildCursor: (anchor) => ({
      v: 4 as const,
      order: options.order,
      sort: [...options.keys],
      cap: options.limit,
      scope: options.scope,
      folders: options.folders.map((folder) => ({
        mailbox: folder.mailbox,
        uidValidity: folder.uidValidity,
        upperUid: folder.upperUid,
      })),
      anchor,
    }),
  });
}

/** Page a single-folder server SORT list. Falls back when the anchor UID is gone. */
export function pageServerUids(
  uids: readonly number[],
  anchorUid: number | undefined,
  limit: number,
): { pageUids: number[]; total: number; offset: number; anchorMissing: boolean } {
  if (anchorUid === undefined) {
    return { pageUids: uids.slice(0, limit), total: uids.length, offset: 0, anchorMissing: false };
  }
  const index = uids.indexOf(anchorUid);
  if (index < 0) {
    return { pageUids: [], total: uids.length, offset: 0, anchorMissing: true };
  }
  const offset = index + 1;
  return {
    pageUids: uids.slice(offset, offset + limit),
    total: uids.length,
    offset,
    anchorMissing: false,
  };
}

export function listHeaders(raw: Buffer | null): {
  listUnsubscribe: string | null;
  listId: string | null;
  autoSubmitted: string | null;
  authenticationResults: string | null;
} {
  if (!raw) {
    return {
      listUnsubscribe: null,
      listId: null,
      autoSubmitted: null,
      authenticationResults: null,
    };
  }
  const text = raw.toString('utf8');
  return {
    listUnsubscribe: headerValue(text, 'list-unsubscribe') ?? null,
    listId: headerValue(text, 'list-id') ?? null,
    autoSubmitted: headerValue(text, 'auto-submitted') ?? null,
    authenticationResults: headerValue(text, 'authentication-results') ?? null,
  };
}

export function scopeFor(
  paths: readonly string[],
  search: SearchCriteria | undefined,
  maxPerFolder: number,
  extra = '',
): string {
  return `${scopeKey(paths)}\n${JSON.stringify(search ?? {})}\n${maxPerFolder}\n${extra}`;
}

export function cursorLimit(
  cursor: SnapshotCursor | undefined,
  requested: number | undefined,
  fallback: number,
): number | undefined {
  if (requested !== undefined) {
    return requested;
  }
  return cursor?.cap ?? fallback;
}

export function pageKeyList(
  keys: readonly string[],
  options: {
    limit: number;
    order: PageOrder;
    cursor?: SnapshotCursor;
    scope: string;
    sort: readonly SortKey[];
  },
): { keys: string[]; nextCursor: string | null; total: number; offset: number } {
  const ordered = options.order === 'newest-first' ? [...keys].sort().reverse() : [...keys].sort();
  const frozen = options.cursor?.keys ?? ordered;
  if (options.cursor) {
    assertCursorFits(options.cursor, {
      scope: options.scope,
      order: options.order,
      sort: options.sort,
      cap: options.limit,
      folders: [],
    });
    if (!options.cursor.keys) {
      throw new MailError('INVALID_ARGUMENT', 'The page cursor is not valid.');
    }
  }
  const sliced = pageKeys(frozen, options.limit, options.cursor?.anchorKey);
  const last = sliced.keys[sliced.keys.length - 1];
  const nextCursor =
    last && sliced.next
      ? encodeSnapshotCursor({
          v: 4,
          order: options.order,
          sort: [...options.sort],
          cap: options.limit,
          scope: options.scope,
          folders: [],
          keys: [...frozen],
          anchorKey: last,
        })
      : null;
  return { keys: sliced.keys, nextCursor, total: frozen.length, offset: sliced.offset };
}

export function compiledOf(search: SearchCriteria | undefined): CompiledSearch {
  return compileSearch(search);
}

export const DEFAULT_LIST_LIMIT = DEFAULT_PAGE_LIMIT;

export function snapshotOf(scans: readonly FolderScan[]): { folders: SnapshotFolder[] } {
  return snapshotPayload(folderPayload(scans));
}
