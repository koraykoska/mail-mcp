import { domainToASCII, domainToUnicode } from 'node:url';
import { MailError } from '../errors.js';

export interface MailAddress {
  name?: string;
  address: string;
}

/**
 * Parse a single mailbox address. Accepts `Name <local@domain>` and bare addresses.
 * The domain is stored in Unicode; {@link addressToAscii} converts it for SMTP/IMAP.
 */
export function parseAddress(input: string): MailAddress {
  const trimmed = stripAddressComments(input).trim();
  if (!trimmed) {
    throw new MailError('INVALID_ARGUMENT', 'An email address was empty.');
  }
  if (trimmed.endsWith('>')) {
    const open = trimmed.lastIndexOf('<');
    if (open >= 0) {
      const address = normalizeAddress(trimmed.slice(open + 1, -1));
      let name = trimmed.slice(0, open).trim();
      if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
        name = unescapeQuoted(name.slice(1, -1));
      }
      const parsed: MailAddress = { address };
      if (name) {
        parsed.name = name;
      }
      return parsed;
    }
  }
  if (trimmed.includes(' ') || trimmed.includes('<')) {
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
  // Comments can contain commas. Strip them before the list is split.
  const parts = Array.isArray(value)
    ? value.flatMap((item) => splitAddresses(stripAddressComments(item)))
    : splitAddresses(stripAddressComments(value));
  return parts.map((part) => parseAddress(part)).filter((item) => item.address.length > 0);
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

export function formatAddress(address: MailAddress): string {
  if (!address.name) {
    return address.address;
  }
  const quoted = needsQuotes(address.name) ? `"${escapeQuoted(address.name)}"` : address.name;
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

/** RFC 5322 specials. A display name that contains one is quoted so it survives parsing. */
const RFC5322_SPECIAL = /[()<>[\]:;@\\,"]/;

function needsQuotes(name: string): boolean {
  return RFC5322_SPECIAL.test(name);
}

function escapeQuoted(name: string): string {
  let out = '';
  for (const char of name) {
    if (char === '\\' || char === '"') {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return out;
}

function unescapeQuoted(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? '';
    if (char === '\\' && index + 1 < value.length) {
      index += 1;
      out += value[index] ?? '';
    } else {
      out += char;
    }
  }
  return out;
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
