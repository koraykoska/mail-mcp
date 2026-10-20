import { simpleParser, type Attachment, type ParsedMail, type AddressObject } from 'mailparser';
import { convert as htmlToText } from 'html-to-text';
import { decodeBody } from '../charset.js';
import type { AddressParts, BodyNode } from '../imap/session.js';

export interface ParsedAttachment {
  partId?: string;
  filename?: string;
  contentType: string;
  size: number;
  disposition?: string;
  cid?: string;
  inline: boolean;
  content?: Buffer;
}

export interface ParsedMessage {
  headers: Record<string, string>;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  date?: string;
  from: AddressParts[];
  to: AddressParts[];
  cc: AddressParts[];
  bcc: AddressParts[];
  replyTo: AddressParts[];
  text?: string;
  html?: string;
  htmlAsText?: string;
  attachments: ParsedAttachment[];
}

export async function parseRawMessage(source: Buffer): Promise<ParsedMessage> {
  const parsed = await simpleParser(source, { skipImageLinks: true });
  return fromParsedMail(parsed);
}

export function fromParsedMail(parsed: ParsedMail): ParsedMessage {
  const headers: Record<string, string> = {};
  for (const [key, value] of parsed.headers) {
    headers[key.toLowerCase()] = headerToString(value);
  }
  const html = typeof parsed.html === 'string' ? parsed.html : undefined;
  const result: ParsedMessage = {
    headers,
    from: addressesOf(parsed.from),
    to: addressesOf(parsed.to),
    cc: addressesOf(parsed.cc),
    bcc: addressesOf(parsed.bcc),
    replyTo: addressesOf(parsed.replyTo),
    references: referenceList(parsed.references),
    attachments: (parsed.attachments ?? []).map(mapAttachment),
  };
  if (parsed.subject) {
    result.subject = parsed.subject;
  }
  if (parsed.messageId) {
    result.messageId = parsed.messageId;
  }
  if (parsed.inReplyTo) {
    result.inReplyTo = parsed.inReplyTo;
  }
  if (parsed.date) {
    result.date = parsed.date.toISOString();
  }
  if (parsed.text) {
    result.text = parsed.text;
  }
  if (html) {
    result.html = html;
    result.htmlAsText = htmlToText(html, { wordwrap: 100 });
  }
  return result;
}

export function renderHtml(html: string): string {
  return htmlToText(html, { wordwrap: 100 });
}

export function capText(
  value: string | undefined,
  maxChars: number,
): { text?: string; truncated: boolean } {
  if (value === undefined) {
    return { truncated: false };
  }
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, maxChars), truncated: true };
}

function mapAttachment(attachment: Attachment): ParsedAttachment {
  const mapped: ParsedAttachment = {
    contentType: attachment.contentType || 'application/octet-stream',
    size: attachment.size,
    inline: attachment.contentDisposition === 'inline' || Boolean(attachment.cid),
    content: attachment.content,
  };
  if (attachment.filename) {
    mapped.filename = attachment.filename;
  }
  if (attachment.contentDisposition) {
    mapped.disposition = attachment.contentDisposition;
  }
  if (attachment.cid) {
    mapped.cid = attachment.cid;
  }
  return mapped;
}

function addressesOf(value: AddressObject | AddressObject[] | undefined): AddressParts[] {
  if (!value) {
    return [];
  }
  const objects = Array.isArray(value) ? value : [value];
  const out: AddressParts[] = [];
  for (const object of objects) {
    for (const entry of object.value ?? []) {
      const item: AddressParts = {};
      if (entry.name) {
        item.name = entry.name;
      }
      if (entry.address) {
        item.address = entry.address;
      }
      out.push(item);
    }
  }
  return out;
}

function referenceList(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function headerToString(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => headerToString(item)).join(', ');
  }
  if (typeof value === 'object' && value !== null && 'text' in value) {
    return String((value as { text: unknown }).text);
  }
  return String(value);
}

export function findTextPart(
  node: BodyNode | null,
): { part: string; kind: 'plain' | 'html' } | undefined {
  if (!node) {
    return undefined;
  }
  const type = `${node.type}/${node.subtype ?? ''}`.toLowerCase();
  if (type === 'text/plain' || type === 'text/html') {
    return { part: node.part || '1', kind: type === 'text/plain' ? 'plain' : 'html' };
  }
  let html: { part: string; kind: 'plain' | 'html' } | undefined;
  for (const child of node.children) {
    const found = findTextPart(child);
    if (found?.kind === 'plain') {
      return found;
    }
    if (found?.kind === 'html') {
      html = found;
    }
  }
  return html;
}

export function decodePart(content: Buffer, charset: string | undefined): string {
  return decodeBody(content, charset);
}
