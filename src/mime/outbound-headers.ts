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
 * Custom `headers` may set these names, plus any X-* field.
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
const STORED_REJECTED_HEADERS = ['return-path', 'resent-message-id', 'resent-date'] as const;

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
  const field = STRUCTURED_FIELD[canonical];
  if (field) {
    return `Use the structured ${field} field. from, replyTo, to, cc, and bcc are the address fields.`;
  }
  return 'Use the structured fields from, replyTo, to, cc, and bcc. Custom headers are limited to X-* and List-Unsubscribe, List-Unsubscribe-Post, Auto-Submitted, Precedence, Importance, Keywords, and Comments.';
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
    if (!canonical.startsWith('x-') && !HEADER_ALLOWLIST.has(canonical)) {
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
    if (canonical.startsWith('x-') || HEADER_ALLOWLIST.has(canonical)) {
      out[canonical] = value;
    }
  }
  return out;
}

/**
 * A stored draft is checked on every send. From, Sender, Reply-To, every Resent-*
 * address, and the receipt and legacy reply headers must be configured identities.
 */
export function assertStoredSenderHeaders(
  headers: Record<string, string>,
  assertAddress: (address: string, label: string) => void,
): void {
  for (const name of STORED_REJECTED_HEADERS) {
    if (headers[name]) {
      throw new MailError(
        'PERMISSION_DENIED',
        `The ${name} header cannot be sent from a draft.`,
        headerHint(name),
      );
    }
  }
  for (const name of Object.keys(headers)) {
    if (name.startsWith('resent-') && !STORED_ADDRESS_HEADERS.has(name)) {
      throw new MailError(
        'PERMISSION_DENIED',
        `The ${name} header cannot be sent from a draft.`,
        headerHint(name),
      );
    }
  }
  for (const name of STORED_ADDRESS_HEADER_LIST) {
    const value = headers[name];
    if (!value) {
      continue;
    }
    let addresses: MailAddress[];
    try {
      addresses = parseAddressList(value);
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
    if (addresses.length === 0) {
      throw new MailError('PERMISSION_DENIED', `The ${name} header is not a list of addresses.`);
    }
    for (const item of addresses) {
      assertAddress(item.address, name);
    }
  }
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

export function sameReplyList(
  left: readonly MailAddress[],
  right: readonly MailAddress[],
): boolean {
  return formatAddressList(replyAddresses(left)) === formatAddressList(replyAddresses(right));
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
