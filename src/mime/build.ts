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
  const record: Record<string, string> = { ...(message.headers ?? {}) };
  if (message.readReceipt) {
    record['Disposition-Notification-To'] = formatAddress(message.from);
  }
  const fields = message.headerFields ?? [];
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
    subject: message.subject,
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

function assertHeaderLines(raw: Buffer): void {
  const text = raw.toString('binary');
  const headerEnd = text.indexOf('\r\n\r\n');
  const block = headerEnd === -1 ? text : text.slice(0, headerEnd);
  for (const line of block.split('\r\n')) {
    if (Buffer.byteLength(line) > MAX_HEADER_LINE_OCTETS) {
      throw new MailError(
        'INVALID_ARGUMENT',
        `A header line is ${Buffer.byteLength(line)} octets, over the limit of ${MAX_HEADER_LINE_OCTETS}.`,
        'Message-ID, In-Reply-To, and References ids that cannot fit on one line are omitted. A Message-ID that is omitted is replaced.',
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
