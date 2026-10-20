import { domainOf, type MailAddress } from './address.js';

export interface ReplyPlan {
  to: MailAddress[];
  cc: MailAddress[];
}

function sameAddress(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function includesAddress(list: MailAddress[], address: string): boolean {
  return list.some((item) => sameAddress(item.address, address));
}

/**
 * Reply-all recipients: the original From becomes To.
 * Original To and Cc are kept on Cc, minus our own addresses and the new To.
 */
export function planReplyAll(
  original: { from: MailAddress[]; to: MailAddress[]; cc: MailAddress[]; replyTo: MailAddress[] },
  ownAddresses: string[],
): ReplyPlan {
  const own = new Set(ownAddresses.map((item) => item.toLowerCase()));
  const primary = original.replyTo.length > 0 ? original.replyTo : original.from;
  const to = primary.filter((item) => !own.has(item.address.toLowerCase()));
  const cc: MailAddress[] = [];
  for (const candidate of [...original.to, ...original.cc]) {
    if (own.has(candidate.address.toLowerCase())) {
      continue;
    }
    if (includesAddress(to, candidate.address) || includesAddress(cc, candidate.address)) {
      continue;
    }
    cc.push(candidate);
  }
  return { to, cc };
}

export function planReply(
  original: { from: MailAddress[]; replyTo: MailAddress[] },
  ownAddresses: string[],
): MailAddress[] {
  const own = new Set(ownAddresses.map((item) => item.toLowerCase()));
  const primary = original.replyTo.length > 0 ? original.replyTo : original.from;
  return primary.filter((item) => !own.has(item.address.toLowerCase()));
}

export function quotePlain(body: string, fromLabel: string, dateLabel: string): string {
  const header = `On ${dateLabel}, ${fromLabel} wrote:`;
  const quoted = body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `${header}\n${quoted}`;
}

export function ownAddressesOf(
  email: string,
  identities: Array<{ email: string }>,
  user: string,
): string[] {
  const values = [email, user, ...identities.map((item) => item.email)];
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

export function domainAllowed(address: string, allowList: readonly string[]): boolean {
  if (allowList.length === 0) {
    return true;
  }
  const domain = domainOf(address);
  return allowList.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}
