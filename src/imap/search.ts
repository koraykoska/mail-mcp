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
    parts.push({ not: compileNode(criteria.not, requires) });
  }
  if (criteria.or) {
    if (criteria.or.length < 2) {
      throw new MailError('INVALID_ARGUMENT', 'search.or needs at least two clauses.');
    }
    parts.push({ or: criteria.or.map((clause) => compileNode(clause, requires)) });
  }
  if (criteria.and) {
    for (const clause of criteria.and) {
      parts.push(compileNode(clause, requires));
    }
  }
  if (criteria.all) {
    flat.all = true;
  }
  const nonEmptyFlat = Object.keys(flat).length > 0 ? flat : undefined;
  const all = [...(nonEmptyFlat ? [nonEmptyFlat] : []), ...parts];
  if (all.length === 0) {
    return { all: true };
  }
  if (all.length === 1) {
    return all[0] ?? { all: true };
  }
  return { not: { or: all.map((item) => ({ not: item })) } };
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
