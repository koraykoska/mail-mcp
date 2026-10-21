import { MailError } from '../errors.js';

/**
 * Structured IMAP SEARCH request. Every field is ANDed.
 * `or` needs at least two clauses. `not` and `and` nest the same shape.
 * Dates are `YYYY-MM-DD` or full ISO timestamps; time of day is ignored for BEFORE/SINCE/ON.
 */
export interface SearchCriteria {
  all?: boolean;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  text?: string;
  header?: { name: string; value?: string };
  since?: string;
  before?: string;
  on?: string;
  sentSince?: string;
  sentBefore?: string;
  sentOn?: string;
  larger?: number;
  smaller?: number;
  seen?: boolean;
  answered?: boolean;
  flagged?: boolean;
  deleted?: boolean;
  draft?: boolean;
  recent?: boolean;
  keyword?: string;
  unkeyword?: string;
  uid?: string;
  seq?: string;
  modseq?: string;
  emailId?: string;
  threadId?: string;
  gmraw?: string;
  labels?: { has?: string[]; not?: string[] };
  not?: SearchCriteria;
  or?: SearchCriteria[];
  and?: SearchCriteria[];
}

export type SearchCapability = 'gmail' | 'condstore' | 'objectid';

export interface CompiledSearch {
  /** Object accepted by ImapFlow `search()`. */
  query: Record<string, unknown>;
  requires: SearchCapability[];
}

/**
 * Keys the search evaluator handles. They are never sent to the server:
 * `NOT UID` and `NOT <sequence>` are not portable, and neither is a NOT
 * wrapped around a mix of text and flag tests.
 */
export const CLIENT_QUERY_KEYS = ['$and', '$or', '$complement'] as const;

/** True when the query must be resolved with UID sets instead of one SEARCH. */
export function isClientQuery(query: Record<string, unknown>): boolean {
  return CLIENT_QUERY_KEYS.some((key) => key in query);
}

/**
 * AND extra IMAP keys onto a compiled query by juxtaposition.
 * `1:*` does not narrow a query that already names a UID set.
 */
export function andSearchQuery(
  compiled: CompiledSearch,
  extra: Record<string, unknown>,
): CompiledSearch {
  if (isMatchAll(compiled.query)) {
    return { query: { ...extra }, requires: [...compiled.requires] };
  }
  if (
    extra.uid === '1:*' &&
    typeof compiled.query.uid === 'string' &&
    !isClientQuery(compiled.query)
  ) {
    return { query: compiled.query, requires: [...compiled.requires] };
  }
  return {
    query: andQueries([compiled.query, extra]),
    requires: [...compiled.requires],
  };
}

/** AND a UID set onto a compiled query. `1:5` and `8:*` are sequence-set text. */
export function andSearchUid(compiled: CompiledSearch, range: string): CompiledSearch {
  return andSearchQuery(compiled, { uid: range });
}

export function compileSearch(criteria: SearchCriteria | undefined): CompiledSearch {
  if (!criteria || Object.keys(criteria).length === 0 || criteria.all) {
    const onlyAll =
      !criteria ||
      Object.keys(criteria).every((key) => key === 'all') ||
      Object.keys(criteria).length === 0;
    if (onlyAll) {
      return { query: { all: true }, requires: [] };
    }
  }
  const requires: SearchCapability[] = [];
  const query = compileNode(criteria ?? { all: true }, requires);
  return { query, requires: [...new Set(requires)] };
}

function compileNode(
  criteria: SearchCriteria,
  requires: SearchCapability[],
): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  const parts: Record<string, unknown>[] = [];
  assignText(flat, 'from', criteria.from);
  assignText(flat, 'to', criteria.to);
  assignText(flat, 'cc', criteria.cc);
  assignText(flat, 'bcc', criteria.bcc);
  assignText(flat, 'subject', criteria.subject);
  assignText(flat, 'body', criteria.body);
  assignText(flat, 'text', criteria.text);
  if (criteria.header) {
    if (!criteria.header.name) {
      throw new MailError('INVALID_ARGUMENT', 'header.name is required when header is set.');
    }
    flat.header = { [criteria.header.name]: criteria.header.value ?? true };
  }
  assignDate(flat, 'since', criteria.since);
  assignDate(flat, 'before', criteria.before);
  assignDate(flat, 'on', criteria.on);
  assignDate(flat, 'sentSince', criteria.sentSince);
  assignDate(flat, 'sentBefore', criteria.sentBefore);
  assignDate(flat, 'sentOn', criteria.sentOn);
  if (criteria.larger !== undefined) {
    flat.larger = criteria.larger;
  }
  if (criteria.smaller !== undefined) {
    flat.smaller = criteria.smaller;
  }
  assignBool(flat, 'seen', criteria.seen);
  assignBool(flat, 'answered', criteria.answered);
  assignBool(flat, 'flagged', criteria.flagged);
  assignBool(flat, 'deleted', criteria.deleted);
  assignBool(flat, 'draft', criteria.draft);
  assignBool(flat, 'recent', criteria.recent);
  if (criteria.keyword) {
    flat.keyword = criteria.keyword;
  }
  if (criteria.unkeyword) {
    flat.unKeyword = criteria.unkeyword;
  }
  if (criteria.uid) {
    flat.uid = criteria.uid;
  }
  if (criteria.seq) {
    flat.seq = criteria.seq;
  }
  if (criteria.modseq) {
    requires.push('condstore');
    if (!/^\d+$/.test(criteria.modseq)) {
      throw new MailError('INVALID_ARGUMENT', 'modseq must be a decimal integer string.');
    }
    flat.modseq = BigInt(criteria.modseq);
  }
  if (criteria.emailId) {
    requires.push('objectid');
    flat.emailId = criteria.emailId;
  }
  if (criteria.threadId) {
    requires.push('objectid');
    flat.threadId = criteria.threadId;
  }
  if (criteria.gmraw) {
    requires.push('gmail');
    flat.gmailraw = criteria.gmraw;
  }
  if (criteria.labels) {
    requires.push('gmail');
    flat.labels = criteria.labels;
  }
  if (criteria.not) {
    parts.push(compileNot(compileNode(criteria.not, requires)));
  }
  if (criteria.or) {
    if (criteria.or.length < 2) {
      throw new MailError('INVALID_ARGUMENT', 'search.or needs at least two clauses.');
    }
    parts.push(compileOr(criteria.or.map((clause) => compileNode(clause, requires))));
  }
  if (criteria.and) {
    for (const clause of criteria.and) {
      parts.push(compileNode(clause, requires));
    }
  }
  if (criteria.all) {
    flat.all = true;
  }
  const pieces: Record<string, unknown>[] = [];
  if (Object.keys(flat).length > 0) {
    pieces.push(flat);
  }
  pieces.push(...parts);
  return andQueries(pieces);
}

function assignText(target: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value !== undefined && value !== '') {
    target[key] = value;
  }
}

function assignBool(
  target: Record<string, unknown>,
  key: string,
  value: boolean | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function assignDate(target: Record<string, unknown>, key: string, value: string | undefined): void {
  if (!value) {
    return;
  }
  const date = parseImapDate(value);
  target[key] = date;
}

export function parseImapDate(value: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    return new Date(Date.UTC(year, month - 1, day));
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new MailError(
      'INVALID_ARGUMENT',
      `Date "${value}" is not YYYY-MM-DD or an ISO timestamp.`,
    );
  }
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

export function assertSearchCapabilities(
  requires: SearchCapability[],
  has: (capability: string) => boolean,
): void {
  for (const requirement of requires) {
    if (requirement === 'gmail' && !has('X-GM-EXT-1')) {
      throw new MailError(
        'CAPABILITY_UNSUPPORTED',
        'This search uses Gmail extensions (X-GM-RAW, labels, or thread id) and the server does not advertise X-GM-EXT-1.',
      );
    }
    if (requirement === 'condstore' && !has('CONDSTORE')) {
      throw new MailError(
        'CAPABILITY_UNSUPPORTED',
        'MODSEQ search requires the CONDSTORE extension.',
      );
    }
    if (requirement === 'objectid' && !has('OBJECTID') && !has('X-GM-EXT-1')) {
      throw new MailError(
        'CAPABILITY_UNSUPPORTED',
        'emailId and threadId search require OBJECTID or Gmail X-GM-EXT-1.',
      );
    }
  }
}

export function isMatchAll(query: Record<string, unknown>): boolean {
  const keys = Object.keys(query);
  return keys.length === 1 && keys[0] === 'all' && query.all === true;
}

/**
 * Resolve a compiled query to UIDs.
 * `$and` intersects, `$or` unions, and `$complement` subtracts from every UID.
 * Anything else is one server SEARCH. The callback must not receive a client key.
 */
export async function evaluateSearch(
  query: Record<string, unknown>,
  run: (query: Record<string, unknown>) => Promise<number[]>,
): Promise<number[]> {
  if (Array.isArray(query.$and)) {
    let acc: Set<number> | undefined;
    for (const part of query.$and) {
      const ids = await evaluateSearch(part as Record<string, unknown>, run);
      const next = new Set(ids);
      acc = acc ? new Set([...acc].filter((uid) => next.has(uid))) : next;
    }
    return sorted([...(acc ?? [])]);
  }
  if (Array.isArray(query.$or)) {
    const acc = new Set<number>();
    for (const part of query.$or) {
      for (const uid of await evaluateSearch(part as Record<string, unknown>, run)) {
        acc.add(uid);
      }
    }
    return sorted([...acc]);
  }
  if (query.$complement && typeof query.$complement === 'object') {
    const universe = await run({ all: true });
    const inner = await evaluateSearch(query.$complement as Record<string, unknown>, run);
    const drop = new Set(inner);
    return universe.filter((uid) => !drop.has(uid));
  }
  return run(query);
}

/** True when a NOT above this node would have to negate a UID or sequence set. */
export function mentionsUidOrSeq(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => mentionsUidOrSeq(item));
  }
  const record = value as Record<string, unknown>;
  if ('uid' in record || 'seq' in record) {
    return true;
  }
  return Object.values(record).some((item) => mentionsUidOrSeq(item));
}

function sorted(uids: number[]): number[] {
  return uids.sort((left, right) => left - right);
}

function andQueries(parts: Record<string, unknown>[]): Record<string, unknown> {
  const nodes: Record<string, unknown>[] = [];
  for (const part of parts) {
    if (Array.isArray(part.$and)) {
      nodes.push(...(part.$and as Record<string, unknown>[]));
      continue;
    }
    if (isMatchAll(part)) {
      continue;
    }
    nodes.push(part);
  }
  if (nodes.length === 0) {
    return { all: true };
  }
  if (nodes.length === 1) {
    return nodes[0] ?? { all: true };
  }
  const merged: Record<string, unknown> = {};
  const rest: Record<string, unknown>[] = [];
  for (const part of nodes) {
    if (isClientQuery(part) || overlaps(merged, part)) {
      rest.push(part);
      continue;
    }
    Object.assign(merged, part);
  }
  const combined = [...(Object.keys(merged).length > 0 ? [merged] : []), ...rest];
  if (combined.length === 1) {
    return combined[0] ?? { all: true };
  }
  return { $and: combined };
}

function overlaps(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return Object.keys(right).some((key) => key in left);
}

/**
 * IMAP NOT is sent only for a single key that is not a UID, a sequence, or OR.
 * Anything else is the complement of a positive search, computed from UID sets.
 */
function compileNot(inner: Record<string, unknown>): Record<string, unknown> {
  if (isImapNotSafe(inner)) {
    return { not: inner };
  }
  return { $complement: inner };
}

function isImapNotSafe(query: Record<string, unknown>): boolean {
  if (isClientQuery(query) || mentionsUidOrSeq(query)) {
    return false;
  }
  const keys = Object.keys(query);
  if (keys.length !== 1) {
    return false;
  }
  const key = keys[0];
  if (!key || key === 'or' || key === 'uid' || key === 'seq') {
    return false;
  }
  if (key === 'not') {
    const nested = query.not;
    return (
      typeof nested === 'object' &&
      nested !== null &&
      isImapNotSafe(nested as Record<string, unknown>)
    );
  }
  return true;
}

function compileOr(parts: Record<string, unknown>[]): Record<string, unknown> {
  if (parts.every((part) => !isClientQuery(part))) {
    return { or: parts };
  }
  return { $or: parts };
}
