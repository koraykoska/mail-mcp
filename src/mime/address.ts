import { domainToASCII, domainToUnicode } from 'node:url';
import { MailError } from '../errors.js';

export interface MailAddress {
  name?: string;
  address: string;
}

const ADDRESS_RE = /^(?:"((?:\\.|[^"])*)"|([^<>"]*?))\s*<([^<>]+)>$/;

/**
 * Parse a single mailbox address. Accepts `Name <local@domain>` and bare addresses.
 * The domain is stored in Unicode; {@link addressToAscii} converts it for SMTP/IMAP.
 */
export function parseAddress(input: string): MailAddress {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new MailError('INVALID_ARGUMENT', 'An email address was empty.');
  }
  const wrapped = ADDRESS_RE.exec(trimmed);
  if (wrapped) {
    const name = (wrapped[1] ?? wrapped[2] ?? '').trim().replace(/^"|"$/g, '');
    const address = normalizeAddress(wrapped[3] ?? '');
    const parsed: MailAddress = { address };
    if (name) {
      parsed.name = name;
    }
    return parsed;
  }
  if (trimmed.includes(' ')) {
    throw new MailError(
      'INVALID_ARGUMENT',
      `Could not parse the address "${trimmed}".`,
      'Use local@domain or "Display Name <local@domain>".',
    );
  }
  return { address: normalizeAddress(trimmed) };
}

export function parseAddressList(value: string | string[] | undefined): MailAddress[] {
  if (!value) {
    return [];
  }
  const parts = Array.isArray(value) ? value : splitAddresses(value);
  return parts.map((part) => parseAddress(part)).filter((item) => item.address.length > 0);
}

export function formatAddress(address: MailAddress): string {
  if (!address.name) {
    return address.address;
  }
  const quoted = /[",<>]/.test(address.name)
    ? `"${address.name.replace(/"/g, '\\"')}"`
    : address.name;
  return `${quoted} <${address.address}>`;
}

export function formatAddressList(addresses: MailAddress[]): string {
  return addresses.map(formatAddress).join(', ');
}

/** Punycode the domain so IDN addresses survive SMTP. */
export function addressToAscii(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) {
    return address;
  }
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const ascii = domainToASCII(domain);
  return `${local}@${ascii || domain}`;
}

export function addressToUnicode(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) {
    return address;
  }
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  return `${local}@${domainToUnicode(domain) || domain}`;
}

export function domainOf(address: string): string {
  const ascii = addressToAscii(address);
  const at = ascii.lastIndexOf('@');
  return at >= 0 ? ascii.slice(at + 1).toLowerCase() : '';
}

function normalizeAddress(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.includes('@')) {
    throw new MailError('INVALID_ARGUMENT', `Address "${trimmed}" is missing a domain.`);
  }
  return addressToUnicode(trimmed);
}

function splitAddresses(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote = false;
  let angle = 0;
  for (const char of value) {
    if (char === '"') {
      quote = !quote;
      current += char;
      continue;
    }
    if (!quote && char === '<') {
      angle += 1;
    }
    if (!quote && char === '>') {
      angle = Math.max(0, angle - 1);
    }
    if (char === ',' && !quote && angle === 0) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}
