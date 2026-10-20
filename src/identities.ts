import { MailError } from './errors.js';
import type { Identity } from './config/schema.js';
import { domainOf, parseAddress, type MailAddress } from './mime/address.js';
import { domainAllowed } from './mime/reply.js';

export const IDENTITY_REASONS = [
  'explicit',
  'single-match',
  'default-no-match',
  'default-ambiguous',
  'stored-draft',
] as const;

export type IdentityReason = (typeof IDENTITY_REASONS)[number];

export interface IdentityChoice {
  id: string | null;
  email: string;
  name?: string;
  reason: IdentityReason;
  address: MailAddress;
}

/** Split a comma-separated identity list. Commas inside `<...>` are part of the address. */
export function splitIdentityList(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (const char of value) {
    if (char === '<') {
      depth += 1;
      current += char;
      continue;
    }
    if (char === '>') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === ',' && depth === 0) {
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

export function parseIdentityList(value: string): Array<{ name?: string; email: string }> {
  return splitIdentityList(value).map((part) => {
    const parsed = parseAddress(part);
    return parsed.name ? { name: parsed.name, email: parsed.address } : { email: parsed.address };
  });
}

export function normalizeMailbox(address: string): string {
  return address.trim().toLowerCase();
}

function defaultIdentity(identities: readonly Identity[], accountEmail: string): Identity {
  return (
    identities.find((item) => item.default) ??
    identities[0] ?? { id: 'default', email: accountEmail, default: true }
  );
}

function addressOf(identity: Identity, name?: string): MailAddress {
  const address: MailAddress = { address: identity.email };
  const chosen = name || identity.name;
  if (chosen) {
    address.name = chosen;
  }
  return address;
}

/**
 * Choose the From identity.
 * An explicit `from` wins. Otherwise, for a reply or forward, select an identity
 * only when exactly one configured address appears in To or Cc. Zero or several
 * matches use the account default. Matching is a case-insensitive address compare.
 */
export function selectIdentity(input: {
  identities: readonly Identity[];
  accountEmail: string;
  allowFromDomains?: readonly string[];
  requested?: string | MailAddress;
  /** Original To and Cc addresses. Omit for a new message. */
  recipients?: readonly string[];
}): IdentityChoice {
  const identities = input.identities.length
    ? input.identities
    : [{ id: 'default', email: input.accountEmail, default: true }];
  if (input.requested) {
    const parsed =
      typeof input.requested === 'string' ? parseAddress(input.requested) : input.requested;
    const match = identities.find(
      (item) => normalizeMailbox(item.email) === normalizeMailbox(parsed.address),
    );
    const domainOk =
      !match &&
      (input.allowFromDomains?.length ?? 0) > 0 &&
      domainAllowed(parsed.address, input.allowFromDomains ?? []);
    if (
      !match &&
      !domainOk &&
      normalizeMailbox(parsed.address) !== normalizeMailbox(input.accountEmail)
    ) {
      throw new MailError(
        'PERMISSION_DENIED',
        `From address ${parsed.address} is not a configured identity.`,
        `Identities: ${identities.map((item) => item.email).join(', ')}.`,
      );
    }
    const identity = match ?? {
      id: 'unlisted',
      email: parsed.address,
      ...(parsed.name ? { name: parsed.name } : {}),
      default: false,
    };
    return {
      id: match ? match.id : null,
      email: parsed.address,
      ...(parsed.name || match?.name ? { name: parsed.name || match?.name } : {}),
      reason: 'explicit',
      address: addressOf(identity, parsed.name),
    };
  }
  if (input.recipients) {
    const wanted = new Set(input.recipients.map((item) => normalizeMailbox(item)).filter(Boolean));
    const hits = identities.filter((item) => wanted.has(normalizeMailbox(item.email)));
    const unique = new Map(hits.map((item) => [normalizeMailbox(item.email), item]));
    if (unique.size === 1) {
      const identity = [...unique.values()][0];
      if (!identity) {
        const fallback = defaultIdentity(identities, input.accountEmail);
        return {
          id: fallback.id,
          email: fallback.email,
          ...(fallback.name ? { name: fallback.name } : {}),
          reason: 'default-no-match',
          address: addressOf(fallback),
        };
      }
      return {
        id: identity.id,
        email: identity.email,
        ...(identity.name ? { name: identity.name } : {}),
        reason: 'single-match',
        address: addressOf(identity),
      };
    }
    const fallback = defaultIdentity(identities, input.accountEmail);
    return {
      id: fallback.id,
      email: fallback.email,
      ...(fallback.name ? { name: fallback.name } : {}),
      reason: unique.size === 0 ? 'default-no-match' : 'default-ambiguous',
      address: addressOf(fallback),
    };
  }
  const fallback = defaultIdentity(identities, input.accountEmail);
  return {
    id: fallback.id,
    email: fallback.email,
    ...(fallback.name ? { name: fallback.name } : {}),
    reason: 'default-no-match',
    address: addressOf(fallback),
  };
}

export function domainOfAddress(address: string): string {
  return domainOf(address);
}
