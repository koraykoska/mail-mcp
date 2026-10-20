import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { MailError } from '../errors.js';
import { addressToAscii, formatAddress, type MailAddress } from './address.js';

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
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  replyTo?: MailAddress[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: OutboundAttachment[];
  headers?: Record<string, string>;
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
  to: string;
  cc?: string;
  bcc?: string;
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: ComposerAttachment[];
  headers?: Record<string, string>;
  inReplyTo?: string;
  references?: string;
  messageId?: string;
  priority?: 'high' | 'normal' | 'low';
}

/**
 * Build an RFC 5322 message. The same bytes are used for SMTP submission and the Sent APPEND
 * so the stored copy matches what was transmitted.
 */
export async function buildRawMessage(message: OutboundMessage): Promise<Buffer> {
  if (!message.text && !message.html && !(message.attachments && message.attachments.length > 0)) {
    throw new MailError(
      'INVALID_ARGUMENT',
      'A message needs text, html, or at least one attachment.',
    );
  }
  const headers: Record<string, string> = { ...(message.headers ?? {}) };
  if (message.readReceipt) {
    headers['Disposition-Notification-To'] = formatAddress(message.from);
  }
  const mail: ComposerMail = {
    from: formatAddress(asciiAddress(message.from)),
    to: message.to.map((item) => formatAddress(asciiAddress(item))).join(', '),
    subject: message.subject,
    headers,
  };
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
  if (message.inReplyTo) {
    mail.inReplyTo = message.inReplyTo;
  }
  if (message.references) {
    mail.references = message.references;
  }
  if (message.priority) {
    mail.priority = message.priority;
  }
  if (message.messageId) {
    mail.messageId = message.messageId;
  }
  const attachments = (message.attachments ?? []).map(toComposerAttachment);
  if (attachments.length > 0) {
    mail.attachments = attachments;
  }
  const composer = new MailComposer(mail);
  try {
    return await composer.compile().build();
  } catch (error) {
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
