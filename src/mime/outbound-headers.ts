import iconv from 'iconv-lite';
import { MailError } from '../errors.js';
import {
  formatAddressList,
  parseAddressList,
  stripAddressComments,
  type MailAddress,
} from './address.js';

export { stripAddressComments };

/**
 * Header names Nodemailer keeps. The composer deletes this class, then lowercases,
 * so a check that runs on the raw key misses ` Reply-To` and `Reply-To:`.
 */
const HEADER_NAME_JUNK = new RegExp(
  `[\\s${String.fromCharCode(0)}-${String.fromCharCode(32)}${String.fromCharCode(127)}:]`,
  'g',
);

/** RFC 5322 token: printable ASCII without space, controls, DEL, or tspecials. */
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * RFC 5322 field-name: printable ASCII except colon (ftext).
 * Whitespace before the colon is not part of a field name.
 */
const FIELD_NAME = /^[!-9;-~]+$/;

/**
 * Custom `headers` may set these names, plus any X-* field that is not a routing alias.
 * In-Reply-To and References are set only by the reply path.
 */
export const HEADER_ALLOWLIST = new Set([
  'list-unsubscribe',
  'list-unsubscribe-post',
  'auto-submitted',
  'precedence',
  'importance',
  'keywords',
  'comments',
]);

/**
 * Header names a custom header must not set. An X- name is denied when the
 * remainder after the X- prefix equals one of these, or starts with resent- or
 * apparently-.
 */
const ROUTING_HEADER_NAMES = new Set([
  'from',
  'sender',
  'reply-to',
  'to',
  'cc',
  'bcc',
  'return-path',
  'errors-to',
  'disposition-notification-to',
  'return-receipt-to',
  'read-receipt-to',
  'mail-reply-to',
  'mail-followup-to',
  'message-id',
  'resent-from',
  'resent-sender',
  'resent-to',
  'resent-cc',
  'resent-bcc',
  'resent-reply-to',
  'resent-message-id',
  'resent-date',
  'apparently-from',
  'apparently-to',
  'original-from',
  'original-sender',
  'original-to',
  'original-recipient',
  'envelope-from',
  'envelope-sender',
  'envelope-to',
  'confirm-reading-to',
  'rcpt-to',
]);

/**
 * Trailing tokens that make an X- name an address header. Compared after the
 * name is lowercased and split on "-" and "_". CamelCase is not a boundary.
 */
const ADDRESS_BEARING_NAMES = new Set([
  'to',
  'from',
  'sender',
  'cc',
  'bcc',
  'recipient',
  'reply-to',
  'errors-to',
  'return-path',
  'rcpt-to',
  'delivered-to',
  'apparently-to',
  'apparently-from',
  'original-from',
  'original-sender',
  'original-to',
  'original-recipient',
  'receipt-to',
  'read-receipt-to',
  'return-receipt-to',
  'notification-to',
  'disposition-notification-to',
  'confirm-reading-to',
  'reading-to',
  'mdn-to',
  'mail-followup-to',
  'followup-to',
  'mail-reply-to',
]);

/** Any one of these tokens denies the X- name, wherever it sits. */
const X_DENY_TOKENS = new Set(['resent', 'envelope', 'rcpt', 'bounce']);

/**
 * Compact forms of the lowercased name after "-" and "_" are removed.
 * "to" alone is not a suffix, so X-Notification and X-Photo stay allowed.
 */
const COMPACT_ADDRESS_SUFFIXES = [
  'apparentlyto',
  'notificationto',
  'followupto',
  'deliveredto',
  'originalto',
  'readingto',
  'returnpath',
  'receiptto',
  'recipient',
  'errorsto',
  'replyto',
  'rcptto',
  'sender',
  'mdnto',
  'from',
];

const COMPACT_CONTAINS = ['resent', 'envelope', 'rcpt', 'bounce'] as const;

const STRUCTURED_FIELD: Record<string, string> = {
  from: 'from',
  sender: 'from',
  'reply-to': 'replyTo',
  to: 'to',
  cc: 'cc',
  bcc: 'bcc',
  'resent-from': 'from',
  'resent-sender': 'from',
  'resent-reply-to': 'replyTo',
  'resent-to': 'to',
  'resent-cc': 'cc',
  'resent-bcc': 'bcc',
  'disposition-notification-to': 'from',
  'return-receipt-to': 'from',
  'mail-reply-to': 'replyTo',
  'mail-followup-to': 'replyTo',
  'errors-to': 'from',
  'apparently-from': 'from',
  'message-id': 'from',
  'return-path': 'from',
};

/** Address headers on a stored draft that must be configured identities. */
const STORED_ADDRESS_HEADER_LIST = [
  'from',
  'sender',
  'reply-to',
  'resent-from',
  'resent-sender',
  'resent-to',
  'resent-cc',
  'resent-bcc',
  'resent-reply-to',
  'disposition-notification-to',
  'return-receipt-to',
  'mail-reply-to',
  'mail-followup-to',
  'errors-to',
  'apparently-from',
] as const;

const STORED_ADDRESS_HEADERS = new Set<string>(STORED_ADDRESS_HEADER_LIST);

/** Present on a stored draft, these are refused rather than forwarded. */
const STORED_REJECTED_HEADERS = new Set(['return-path', 'resent-message-id', 'resent-date']);

export function canonicalHeaderName(name: string): string {
  return name.replace(HEADER_NAME_JUNK, '').toLowerCase();
}

export function headerNameChanged(name: string): boolean {
  return canonicalHeaderName(name) !== name.toLowerCase();
}

export function isHeaderToken(canonical: string): boolean {
  return HEADER_TOKEN.test(canonical);
}

function headerHint(name: string): string {
  const canonical = canonicalHeaderName(name);
  if (canonical.startsWith('x-') && routingHeaderDenied(name)) {
    return (
      'An X- header is lowercased first and split on "-" and "_", never on camelCase. ' +
      'Each token is checked with all digits removed, and again with look-alike digits mapped ' +
      '(0 as o, 1 as l and as i, 3 as e, 4 as a, 5 as s, 7 as t) and the other digits removed. ' +
      'Any match rejects the name. A token that becomes from, to, cc, bcc, or recipient is ' +
      'rejected in any position. It is rejected when the last token is ' +
      'to, from, sender, cc, bcc, or recipient, when the trailing tokens are an address-bearing ' +
      'name (reply-to, errors-to, return-path, rcpt-to, delivered-to, apparently-to, ' +
      'apparently-from, original-from, original-sender, original-to, original-recipient, ' +
      'receipt-to, read-receipt-to, return-receipt-to, notification-to, ' +
      'disposition-notification-to, confirm-reading-to, reading-to, mdn-to, mail-followup-to, ' +
      'followup-to, mail-reply-to), or when any token is resent, envelope, rcpt, or bounce. ' +
      'The lowercased name with "-" and "_" removed is checked the same way, and it is rejected when ' +
      'it ends with from, sender, recipient, replyto, errorsto, returnpath, deliveredto, ' +
      'receiptto, notificationto, readingto, mdnto, apparentlyto, followupto, originalto, or ' +
      'rcptto, or when it contains resent, envelope, rcpt, or bounce. Names such as ' +
      'X-Report-Abuse-To, X-Complaint-To, X-Authenticated-Sender, and X-Forwarded-To are ' +
      'rejected on purpose. Other X-* headers are allowed.'
    );
  }
  const field = STRUCTURED_FIELD[canonical];
  if (field) {
    return `Use the structured ${field} field. from, replyTo, to, cc, and bcc are the address fields.`;
  }
  return 'Use the structured fields from, replyTo, to, cc, and bcc. Custom headers are limited to X-* (except routing aliases) and List-Unsubscribe, List-Unsubscribe-Post, Auto-Submitted, Precedence, Importance, Keywords, and Comments.';
}

export function isFieldName(name: string): boolean {
  return FIELD_NAME.test(name);
}

/**
 * True when `name` is a routing or receipt header, or an X- alias of one.
 * The name is lowercased before it is split. CamelCase is not a boundary.
 * A trailing token sequence that equals an address-bearing header name is denied.
 * Any token equal to resent, envelope, rcpt, or bounce is denied. Each token is
 * matched with all digits removed and with look-alike digits mapped (0 as o,
 * 1 as l and as i, 3 as e, 4 as a, 5 as s, 7 as t). A token that becomes from,
 * to, cc, bcc, or recipient is denied in any position. sender is denied only as
 * the last token or a compact suffix, so X-Sender-IP stays allowed. The compact
 * form is checked the same way. This is a best-effort guard: MTAs and Nodemailer
 * do not read these names as routing headers. X-Report-Abuse-To is denied because
 * its last token is an address token; that over-block is intentional, as is
 * denying from, to, cc, bcc, or recipient when the token is not last, and names
 * that only spell those words after the look-alike mapping (X-From0, X-Enve1ope,
 * X-Bounc3, X-3nv3l0p3, X-B0unc3).
 */
export function routingHeaderDenied(name: string): boolean {
  const canonical = canonicalHeaderName(name);
  if (routingNameDenied(canonical)) {
    return true;
  }
  if (!canonical.startsWith('x-')) {
    return false;
  }
  let remainder = canonical.slice(2);
  while (remainder.startsWith('x-')) {
    remainder = remainder.slice(2);
  }
  if (!remainder || routingNameDenied(remainder)) {
    return true;
  }
  return xHeaderDenied(canonical);
}

/** Address words denied in any token position. sender stays last-token only. */
const ANY_POSITION_TOKENS = new Set(['from', 'to', 'cc', 'bcc', 'recipient']);

const LOOKALIKE_DIGIT: Record<string, string> = {
  '0': 'o',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
};

/** Digits removed, plus look-alike mappings of 1 to both l and i. */
function tokenVariants(piece: string): string[] {
  const stripped = piece.replace(/\d/g, '');
  return [...new Set([stripped, mapLookalike(piece, 'l'), mapLookalike(piece, 'i')])].filter(
    (token) => token.length > 0,
  );
}

function mapLookalike(piece: string, one: 'l' | 'i'): string {
  let out = '';
  for (const char of piece) {
    if (char === '1') {
      out += one;
      continue;
    }
    const mapped = LOOKALIKE_DIGIT[char];
    if (mapped) {
      out += mapped;
      continue;
    }
    if (char >= '0' && char <= '9') {
      continue;
    }
    out += char;
  }
  return out;
}

function variantSequences(groups: readonly (readonly string[])[]): string[][] {
  const product = groups.reduce((count, group) => count * group.length, 1);
  if (product > 256) {
    const width = groups.reduce((widest, group) => Math.max(widest, group.length), 0);
    const sequences: string[][] = [];
    for (let index = 0; index < width; index += 1) {
      sequences.push(groups.map((group) => group[Math.min(index, group.length - 1)] ?? ''));
    }
    return sequences;
  }
  let sequences: string[][] = [[]];
  for (const group of groups) {
    const next: string[][] = [];
    for (const sequence of sequences) {
      for (const token of group) {
        next.push([...sequence, token]);
      }
    }
    sequences = next;
  }
  return sequences;
}

function sequenceDenied(tokens: readonly string[]): boolean {
  if (tokens.some((token) => X_DENY_TOKENS.has(token) || ANY_POSITION_TOKENS.has(token))) {
    return true;
  }
  for (let start = 0; start < tokens.length; start += 1) {
    if (ADDRESS_BEARING_NAMES.has(tokens.slice(start).join('-'))) {
      return true;
    }
  }
  return false;
}

function compactDenied(compact: string): boolean {
  if (COMPACT_CONTAINS.some((token) => compact.includes(token))) {
    return true;
  }
  return COMPACT_ADDRESS_SUFFIXES.some((suffix) => compact.endsWith(suffix));
}

function xHeaderDenied(canonical: string): boolean {
  let rest = canonical;
  while (rest.startsWith('x-') || rest.startsWith('x_')) {
    rest = rest.slice(2);
  }
  const groups = rest
    .split(/[-_]+/)
    .filter((piece) => piece.length > 0)
    .map((piece) => tokenVariants(piece))
    .filter((group) => group.length > 0);
  if (groups.length === 0) {
    return true;
  }
  if (variantSequences(groups).some((tokens) => sequenceDenied(tokens))) {
    return true;
  }
  return tokenVariants(canonical.replace(/[-_]/g, '')).some((compact) => compactDenied(compact));
}

function routingNameDenied(name: string): boolean {
  return (
    ROUTING_HEADER_NAMES.has(name) || name.startsWith('resent-') || name.startsWith('apparently-')
  );
}

function headerAllowed(name: string): boolean {
  const canonical = canonicalHeaderName(name);
  if (routingHeaderDenied(name)) {
    return false;
  }
  return canonical.startsWith('x-') || HEADER_ALLOWLIST.has(canonical);
}

function rejectHeader(name: string, canonical: string): never {
  throw new MailError(
    'PERMISSION_DENIED',
    `The ${name.trim() || canonical} header cannot be set from headers.`,
    headerHint(name),
  );
}

/**
 * Keep an allow-listed header map. Names that Nodemailer would rewrite, and names
 * that are not tokens, are rejected. Nothing is dropped quietly.
 */
export function guardOutboundHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const canonical = canonicalHeaderName(name);
    if (!canonical || headerNameChanged(name) || !isHeaderToken(canonical)) {
      throw new MailError(
        'PERMISSION_DENIED',
        `Header name "${name}" is not a valid field name.`,
        'A header name is a token. Spaces, controls, and a colon are rejected rather than stripped.',
      );
    }
    if (!headerAllowed(name)) {
      rejectHeader(name, canonical);
    }
    out[canonical] = value;
  }
  return out;
}

/** Copy allow-listed headers out of a parsed message. Other names are not forwarded on a rebuild. */
export function allowlistedHeaderEntries(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const canonical = canonicalHeaderName(name);
    if (!canonical || headerNameChanged(name) || !isHeaderToken(canonical)) {
      continue;
    }
    if (headerAllowed(name)) {
      out[canonical] = value;
    }
  }
  return out;
}

export interface RawHeaderField {
  name: string;
  value: string;
}

export interface DraftAddressHeaders {
  from: MailAddress[];
  sender: MailAddress[];
  replyTo: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  /** Address headers other than From, Sender, Reply-To, To, Cc, Bcc, and Resent-Bcc, already sanitized. */
  kept: Record<string, string>;
  /**
   * Allow-listed headers from the raw header block, one entry per field.
   * The field name is the original spelling. Duplicate names are not joined.
   */
  rawHeaders: Array<{ name: string; value: string }>;
}

const SINGLETON_HEADERS = ['from', 'sender', 'reply-to'] as const;

/**
 * Unfold the header block and require every field name to be an RFC 5322 field-name.
 * `From :` is rejected here: the space is not part of a field name.
 */
export function readRawHeaderFields(source: Buffer | string): RawHeaderField[] {
  const text = typeof source === 'string' ? source : source.toString('utf8');
  const splitAt = text.search(/\r?\n\r?\n/);
  const block = splitAt >= 0 ? text.slice(0, splitAt) : text;
  const unfolded: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }
    if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length > 0) {
      const previous = unfolded[unfolded.length - 1] ?? '';
      unfolded[unfolded.length - 1] = `${previous} ${line.trim()}`;
      continue;
    }
    unfolded.push(line);
  }
  const fields: RawHeaderField[] = [];
  for (const line of unfolded) {
    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw new MailError(
        'PERMISSION_DENIED',
        'The draft has a header line without a field name.',
        'Each header is a field name, a colon, and a value.',
      );
    }
    const name = line.slice(0, colon);
    if (!isFieldName(name)) {
      throw new MailError(
        'PERMISSION_DENIED',
        `Header name "${name.trim() || name}" is not a valid field name.`,
        'A field name is printable ASCII without whitespace or a colon.',
      );
    }
    fields.push({ name, value: line.slice(colon + 1).trim() });
  }
  return fields;
}

function parseStoredAddresses(name: string, value: string): MailAddress[] {
  let addresses: MailAddress[];
  try {
    addresses = parseAddressList(stripAddressComments(value));
  } catch (error) {
    if (error instanceof MailError) {
      throw new MailError(
        'PERMISSION_DENIED',
        `The ${name} header is not a list of addresses.`,
        error.hint,
      );
    }
    throw error;
  }
  const sanitized = replyAddresses(addresses);
  if (sanitized.length === 0) {
    throw new MailError('PERMISSION_DENIED', `The ${name} header is not a list of addresses.`);
  }
  return sanitized;
}

/**
 * Walk every raw header, including a second copy of From, Sender, or Reply-To.
 * Address checks use the unfolded value with comments removed. Display names that
 * hide another address are dropped, the same way a composed Reply-To is emitted.
 */
export function assertDraftHeaders(
  fields: readonly RawHeaderField[],
  assertAddress: (address: string, label: string) => void,
): DraftAddressHeaders {
  const counts = new Map<string, number>();
  const from: MailAddress[] = [];
  const sender: MailAddress[] = [];
  const replyTo: MailAddress[] = [];
  const to: MailAddress[] = [];
  const cc: MailAddress[] = [];
  const bcc: MailAddress[] = [];
  const keptLists = new Map<string, MailAddress[]>();
  const rawHeaders: Array<{ name: string; value: string }> = [];
  for (const field of fields) {
    const canonical = field.name.toLowerCase();
    counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
    if (
      (canonical.startsWith('x-') && routingHeaderDenied(field.name)) ||
      STORED_REJECTED_HEADERS.has(canonical)
    ) {
      throw new MailError(
        'PERMISSION_DENIED',
        `The ${field.name} header cannot be sent from a draft.`,
        headerHint(field.name),
      );
    }
    if (canonical.startsWith('resent-') && !STORED_ADDRESS_HEADERS.has(canonical)) {
      throw new MailError(
        'PERMISSION_DENIED',
        `The ${field.name} header cannot be sent from a draft.`,
        headerHint(field.name),
      );
    }
    if (canonical === 'to' || canonical === 'cc' || canonical === 'bcc') {
      const sanitized = parseStoredAddresses(field.name, field.value);
      if (canonical === 'to') {
        to.push(...sanitized);
      } else if (canonical === 'cc') {
        cc.push(...sanitized);
      } else {
        bcc.push(...sanitized);
      }
      continue;
    }
    if (!STORED_ADDRESS_HEADERS.has(canonical)) {
      if (headerAllowed(field.name)) {
        rawHeaders.push({ name: field.name, value: field.value });
      }
      continue;
    }
    const sanitized = parseStoredAddresses(field.name, field.value);
    for (const item of sanitized) {
      assertAddress(item.address, field.name);
    }
    if (canonical === 'from') {
      from.push(...sanitized);
    } else if (canonical === 'sender') {
      sender.push(...sanitized);
    } else if (canonical === 'reply-to') {
      replyTo.push(...sanitized);
    } else if (canonical !== 'bcc' && canonical !== 'resent-bcc') {
      const list = keptLists.get(canonical) ?? [];
      list.push(...sanitized);
      keptLists.set(canonical, list);
    }
  }
  for (const name of SINGLETON_HEADERS) {
    if ((counts.get(name) ?? 0) > 1) {
      throw new MailError(
        'PERMISSION_DENIED',
        `The ${name} header appears more than once.`,
        'A draft may contain one From, one Sender, and one Reply-To.',
      );
    }
  }
  const kept: Record<string, string> = {};
  for (const [name, list] of keptLists) {
    kept[name] = formatAddressList(list);
  }
  return { from, sender, replyTo, to, cc, bcc, kept, rawHeaders };
}

const ENCODED_WORD = /=\?[^?]+\?[bBqQ]\?[^?]*\?=/;

/**
 * Emit an address list. A display name that hides another address is dropped.
 * The decoded name is NFKC-normalized before the `@` / `<>` check. A name that
 * is still an encoded-word after decoding (an unknown charset) is dropped too.
 */
export function replyAddresses(addresses: readonly MailAddress[]): MailAddress[] {
  return addresses.map((item) => {
    const decoded = item.name ? decodeEncodedWords(item.name) : '';
    if (!decoded || ENCODED_WORD.test(decoded) || unsafeDisplayName(decoded)) {
      return { address: item.address };
    }
    return { name: decoded.normalize('NFKC'), address: item.address };
  });
}

function unsafeDisplayName(value: string): boolean {
  return /[@<>]/.test(value.normalize('NFKC'));
}

function decodeEncodedWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (_all, charset: string, encoding: string, text: string) => {
      try {
        if (encoding.toLowerCase() === 'b') {
          return iconv.decode(Buffer.from(text, 'base64'), charset);
        }
        const bytes = text
          .replace(/_/g, ' ')
          .replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
            String.fromCharCode(Number.parseInt(hex, 16)),
          );
        return iconv.decode(Buffer.from(bytes, 'binary'), charset);
      } catch {
        return _all;
      }
    },
  );
}
