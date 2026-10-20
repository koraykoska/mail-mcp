import iconv from 'iconv-lite';
import { MailError } from '../errors.js';
import { formatAddressList, parseAddressList, type MailAddress } from './address.js';

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
 * X- names that are aliases of routing or receipt headers. Other X-* fields stay allowed.
 * Documented in README and docs/SECURITY.md.
 */
export const DENIED_X_HEADERS = [
  'X-Reply-To',
  'X-Confirm-Reading-To',
  'X-Sender',
  'X-Envelope-From',
  'X-Envelope-Sender',
  'X-Envelope-To',
  'X-Original-From',
  'X-Original-Sender',
  'X-Original-To',
  'X-Original-Recipient',
  'X-Apparently-From',
  'X-Apparently-To',
  'X-Rcpt-To',
] as const;

const DENIED_X_HEADER_SET = new Set<string>(DENIED_X_HEADERS.map((name) => name.toLowerCase()));

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

function headerHint(canonical: string): string {
  if (DENIED_X_HEADER_SET.has(canonical)) {
    return `The ${canonical} header is an alias of a routing or receipt field. Use from, replyTo, to, cc, or bcc. Other X-* headers are allowed. Denied: ${DENIED_X_HEADERS.join(', ')}.`;
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

function headerAllowed(canonical: string): boolean {
  if (DENIED_X_HEADER_SET.has(canonical)) {
    return false;
  }
  return canonical.startsWith('x-') || HEADER_ALLOWLIST.has(canonical);
}

function rejectHeader(name: string, canonical: string): never {
  throw new MailError(
    'PERMISSION_DENIED',
    `The ${name.trim() || canonical} header cannot be set from headers.`,
    headerHint(canonical),
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
    if (!headerAllowed(canonical)) {
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
    if (headerAllowed(canonical)) {
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
  /** Address headers other than From, Sender, Reply-To, Bcc, and Resent-Bcc, already sanitized. */
  kept: Record<string, string>;
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

/** Remove RFC 5322 comments. Parentheses inside a quoted display name stay. */
export function stripAddressComments(value: string): string {
  let out = '';
  let quote = false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? '';
    if (depth > 0) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
      }
      continue;
    }
    if (char === '"') {
      quote = !quote;
      out += char;
      continue;
    }
    if (char === '(' && !quote) {
      depth = 1;
      continue;
    }
    out += char;
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim();
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
  const keptLists = new Map<string, MailAddress[]>();
  for (const field of fields) {
    const canonical = field.name.toLowerCase();
    counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
    if (DENIED_X_HEADER_SET.has(canonical) || STORED_REJECTED_HEADERS.has(canonical)) {
      throw new MailError(
        'PERMISSION_DENIED',
        `The ${field.name} header cannot be sent from a draft.`,
        headerHint(canonical),
      );
    }
    if (canonical.startsWith('resent-') && !STORED_ADDRESS_HEADERS.has(canonical)) {
      throw new MailError(
        'PERMISSION_DENIED',
        `The ${field.name} header cannot be sent from a draft.`,
        headerHint(canonical),
      );
    }
    if (!STORED_ADDRESS_HEADERS.has(canonical)) {
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
  return { from, sender, replyTo, kept };
}

/** Emit Reply-To from the parsed addresses. A display name that hides another address is dropped. */
export function replyAddresses(addresses: readonly MailAddress[]): MailAddress[] {
  return addresses.map((item) => {
    const visible = item.name ? decodeEncodedWords(item.name) : '';
    if (!visible || /[@<>]/.test(visible)) {
      return { address: item.address };
    }
    return { name: visible, address: item.address };
  });
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
        return value;
      }
    },
  );
}
