import { MailError } from './errors.js';
import type { ResolvedAccount } from './config/schema.js';
import { domainAllowed } from './mime/reply.js';
import type { MailAddress } from './mime/address.js';

export type MutationKind = 'mailbox-write' | 'message-write' | 'delete' | 'permanent' | 'send';

/**
 * Enforce per-account safety switches. Read operations are always allowed.
 */
export function assertMutation(account: ResolvedAccount, kind: MutationKind): void {
  if (account.readOnly) {
    throw new MailError(
      'PERMISSION_DENIED',
      `Account "${account.id}" is readOnly, so ${kind} is not allowed.`,
      'Use another account or set readOnly to false in the configuration.',
    );
  }
  if (kind === 'send' && !account.allowSend) {
    throw new MailError('PERMISSION_DENIED', `Account "${account.id}" has allowSend set to false.`);
  }
  if ((kind === 'delete' || kind === 'permanent') && !account.allowDelete) {
    throw new MailError(
      'PERMISSION_DENIED',
      `Account "${account.id}" has allowDelete set to false.`,
      'Moving to Trash and permanent delete are both blocked.',
    );
  }
  if (kind === 'permanent' && !account.allowPermanentDelete) {
    throw new MailError(
      'PERMISSION_DENIED',
      `Account "${account.id}" does not allow permanent delete or expunge.`,
      'Set allowPermanentDelete to true to enable UID EXPUNGE and mail_expunge_mailbox. Delete without permanent moves mail to Trash.',
    );
  }
}

export function assertRecipients(account: ResolvedAccount, recipients: MailAddress[]): void {
  if (account.recipientDomainAllowList.length === 0) {
    return;
  }
  const blocked = recipients.filter(
    (recipient) => !domainAllowed(recipient.address, account.recipientDomainAllowList),
  );
  if (blocked.length > 0) {
    throw new MailError(
      'PERMISSION_DENIED',
      `Recipient domain is not allowed: ${blocked.map((item) => item.address).join(', ')}.`,
      `Allowed domains: ${account.recipientDomainAllowList.join(', ')}.`,
    );
  }
}

export function mutationKindsForAccount(account: ResolvedAccount): Set<MutationKind> {
  const kinds = new Set<MutationKind>();
  if (account.readOnly) {
    return kinds;
  }
  kinds.add('mailbox-write');
  kinds.add('message-write');
  if (account.allowDelete) {
    kinds.add('delete');
  }
  if (account.allowDelete && account.allowPermanentDelete) {
    kinds.add('permanent');
  }
  if (account.allowSend) {
    kinds.add('send');
  }
  return kinds;
}

/**
 * A mutating tool is registered when at least one account is allowed to call it.
 * Calls are still checked per account.
 */
export function anyAccountAllows(accounts: ResolvedAccount[], kind: MutationKind): boolean {
  return accounts.some((account) => mutationKindsForAccount(account).has(kind));
}
