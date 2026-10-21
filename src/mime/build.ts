import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { MailError } from '../errors.js';
import { addressToAscii, formatAddress, type MailAddress } from './address.js';
import { canonicalHeaderName } from './outbound-headers.js';

export interface HeaderField {
  name: string;
  value: string;
}

export interface OutboundAttachment {
  filename?: string;
  contentType?: string;
  /** Base64 content. Mutually exclusive with `path` at the call site; path is read by nodemailer. */
  contentBase64?: string;
  path?: string;
  cid?: string;
  inline?: boolean;
}

export interface OutboundMessage {
  from: MailAddress;
  /** Header From when it differs from the envelope identity. One field, sanitized addresses. */
  fromHeader?: MailAddress[];
  sender?: MailAddress[];
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  replyTo?: MailAddress[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: OutboundAttachment[];
  headers?: Record<string, string>;
  /** One entry per draft field. Duplicate names stay separate and keep their spelling. */
  headerFields?: HeaderField[];
  inReplyTo?: string;
  references?: string;
  priority?: 'high' | 'normal' | 'low';
  readReceipt?: boolean;
  messageId?: string;
}

interface ComposerAttachment {
  filename?: string;
  contentType?: string;
  content?: Buffer;
  path?: string;
  cid?: string;
  contentDisposition?: 'inline' | 'attachment';
  encoding?: string;
}

interface ComposerMail {
  from: string;
  sender?: string;
  to: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: ComposerAttachment[];
  headers?: Record<string, string> | Array<{ key: string; value: string }>;
  inReplyTo?: string;
  references?: string;
  messageId?: string;
  priority?: 'high' | 'normal' | 'low';
}

/**
 * Build an RFC 5322 message. The same bytes are used for SMTP submission and the Sent APPEND
 * so the stored copy matches what was transmitted.
 */
export async function buildRawMessage(
  message: OutboundMessage,
  options?: { keepBcc?: boolean },
): Promise<Buffer> {
  if (!message.text && !message.html && !(message.attachments && message.attachments.length > 0)) {
    throw new MailError(
      'INVALID_ARGUMENT',
      'A message needs text, html, or at least one attachment.',
    );
  }
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(message.headers ?? {})) {
    record[key] = fitFreeTextHeader(key, value);
  }
  if (message.readReceipt) {
    record['Disposition-Notification-To'] = formatAddress(message.from);
  }
  const fields = (message.headerFields ?? []).map((field) => ({
    name: field.name,
    value: fitFreeTextHeader(field.name, field.value),
  }));
  const headers: Record<string, string> | Array<{ key: string; value: string }> =
    fields.length > 0
      ? [
          ...Object.entries(record).map(([key, value]) => ({ key, value })),
          ...fields.map((field) => ({ key: field.name, value: field.value })),
        ]
      : record;
  const fromList =
    message.fromHeader && message.fromHeader.length > 0 ? message.fromHeader : [message.from];
  const mail: ComposerMail = {
    from: fromList.map((item) => formatAddress(asciiAddress(item))).join(', '),
    to: message.to.map((item) => formatAddress(asciiAddress(item))).join(', '),
    subject: fitUnstructured('Subject', message.subject),
    headers,
  };
  if (message.sender && message.sender.length > 0) {
    mail.sender = message.sender.map((item) => formatAddress(asciiAddress(item))).join(', ');
  }
  if (message.cc && message.cc.length > 0) {
    mail.cc = message.cc.map((item) => formatAddress(asciiAddress(item))).join(', ');
  }
  if (message.bcc && message.bcc.length > 0) {
    mail.bcc = message.bcc.map((item) => formatAddress(asciiAddress(item))).join(', ');
  }
  if (message.replyTo && message.replyTo.length > 0) {
    mail.replyTo = message.replyTo.map((item) => formatAddress(asciiAddress(item))).join(', ');
  }
  if (message.text !== undefined) {
    mail.text = message.text;
  }
  if (message.html !== undefined) {
    mail.html = message.html;
  }
  const inReplyTo = fitMessageIdHeader('In-Reply-To', message.inReplyTo);
  if (inReplyTo) {
    mail.inReplyTo = inReplyTo;
  }
  const references = fitReferences(message.references);
  if (references) {
    mail.references = references;
  }
  if (message.priority) {
    mail.priority = message.priority;
  }
  const messageId = fitMessageIdHeader('Message-ID', message.messageId);
  if (messageId) {
    mail.messageId = messageId;
  }
  const attachments = (message.attachments ?? []).map(toComposerAttachment);
  if (attachments.length > 0) {
    mail.attachments = attachments;
  }
  const composer = new MailComposer(mail);
  try {
    const compiled = composer.compile();
    if (fields.length > 0) {
      const pending = fields.map((field) => field.name);
      compiled.normalizeHeaderKey = (key) => {
        const index = pending.findIndex(
          (name) => canonicalHeaderName(name) === canonicalHeaderName(key),
        );
        if (index < 0) {
          return key;
        }
        const original = pending[index] as string;
        pending.splice(index, 1);
        return original;
      };
    }
    if (options?.keepBcc) {
      (compiled as { keepBcc?: boolean }).keepBcc = true;
    }
    const raw = await compiled.build();
    assertHeaderLines(raw);
    return raw;
  } catch (error) {
    if (error instanceof MailError) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : 'compose failed';
    throw new MailError('INVALID_ARGUMENT', `Could not build the message: ${detail}`);
  }
}

function asciiAddress(address: MailAddress): MailAddress {
  const next: MailAddress = { address: addressToAscii(address.address) };
  if (address.name) {
    next.name = address.name;
  }
  return next;
}

/** RFC 5322: a line MUST be no more than 998 octets, excluding the CRLF. */
const MAX_HEADER_LINE_OCTETS = 998;

/**
 * A msg-id is one token. Folding would leave a space in the id, so an id that
 * cannot fit on one line next to its header name is omitted. A Message-ID that
 * is omitted is replaced by the composer. An In-Reply-To or References id that
 * is omitted is left off. Ids that fit are kept, and a list is folded on the
 * spaces between them.
 */
function fitMessageIdHeader(name: string, value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const id = bracketId(value);
  if (!id || !idFits(name, id)) {
    return undefined;
  }
  return id;
}

function fitReferences(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const ids: string[] = [];
  for (const part of value.split(/\s+/)) {
    const id = bracketId(part);
    if (id && idFits('References', id)) {
      ids.push(id);
    }
  }
  if (ids.length === 0) {
    return undefined;
  }
  return ids.join(' ');
}

function bracketId(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed;
  }
  return `<${trimmed.replace(/^<|>$/g, '')}>`;
}

function idFits(name: string, id: string): boolean {
  return Buffer.byteLength(`${name}: ${id}`) <= MAX_HEADER_LINE_OCTETS;
}

/** Unstructured fields this builder emits as free text. Structured headers are left alone. */
const FREE_TEXT_HEADERS = new Set(['comments', 'keywords']);

/**
 * A whitespace-delimited token that cannot sit on one line next to its header
 * name is encoded with the whole value. RFC 2047 drops the whitespace between
 * adjacent encoded-words, so the decoded text keeps the original characters,
 * including spaces that were inside the value. A token that fits is left for
 * the composer, which already encodes non-ASCII text.
 */
function fitFreeTextHeader(name: string, value: string): string {
  const canonical = canonicalHeaderName(name);
  if (!FREE_TEXT_HEADERS.has(canonical)) {
    return value;
  }
  return fitUnstructured(name, value);
}

function fitUnstructured(name: string, value: string): string {
  const overflows = value
    .split(/\s+/)
    .some(
      (token) =>
        token.length > 0 && Buffer.byteLength(`${name}: ${token}`) > MAX_HEADER_LINE_OCTETS,
    );
  if (!overflows) {
    return value;
  }
  return encodeUtf8Words(value);
}

/**
 * RFC 2047 encoded-words, each at most 75 characters. 45 UTF-8 bytes become 60
 * Base64 characters. Words are separated by a space so folding breaks
 * between them and never inside a word. A chunk never splits a UTF-8 sequence.
 */
function encodeUtf8Words(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  const words: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(offset + 45, bytes.length);
    while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) {
      end -= 1;
    }
    if (end === offset) {
      end = Math.min(offset + 45, bytes.length);
    }
    words.push(`=?UTF-8?B?${bytes.subarray(offset, end).toString('base64')}?=`);
    offset = end;
  }
  return words.join(' ');
}

function assertHeaderLines(raw: Buffer): void {
  const text = raw.toString('binary');
  const headerEnd = text.indexOf('\r\n\r\n');
  const block = headerEnd === -1 ? text : text.slice(0, headerEnd);
  let name = 'header';
  for (const line of block.split('\r\n')) {
    if (line.length > 0 && line[0] !== ' ' && line[0] !== '\t') {
      const colon = line.indexOf(':');
      if (colon > 0) {
        name = line.slice(0, colon);
      }
    }
    const octets = Buffer.byteLength(line);
    if (octets > MAX_HEADER_LINE_OCTETS) {
      throw new MailError(
        'INVALID_ARGUMENT',
        `The ${name} header has a line of ${octets} octets, over the limit of ${MAX_HEADER_LINE_OCTETS}.`,
        `${name} is longer than one line can hold. Subject, Comments, and Keywords are encoded to fit. Message-ID, In-Reply-To, and References ids that cannot fit on one line are omitted. A Message-ID that is omitted is replaced.`,
      );
    }
  }
}

function toComposerAttachment(attachment: OutboundAttachment): ComposerAttachment {
  if (!attachment.contentBase64 && !attachment.path) {
    throw new MailError('INVALID_ARGUMENT', 'Each attachment needs contentBase64 or path.');
  }
  const item: ComposerAttachment = {};
  if (attachment.filename) {
    item.filename = attachment.filename;
  }
  if (attachment.contentType) {
    item.contentType = attachment.contentType;
  }
  if (attachment.path) {
    item.path = attachment.path;
  }
  if (attachment.contentBase64) {
    item.content = Buffer.from(attachment.contentBase64, 'base64');
    item.encoding = 'base64';
  }
  if (attachment.cid) {
    item.cid = attachment.cid;
  }
  if (attachment.inline) {
    item.contentDisposition = 'inline';
  }
  return item;
}

export function envelopeRecipients(message: OutboundMessage, override?: string[]): string[] {
  if (override && override.length > 0) {
    return override.map(addressToAscii);
  }
  return [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].map((item) =>
    addressToAscii(item.address),
  );
}
