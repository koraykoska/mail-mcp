import { providerById, type ProviderId } from '../config/providers.js';

export const SPECIAL_USES = [
  '\\Inbox',
  '\\Sent',
  '\\Drafts',
  '\\Trash',
  '\\Junk',
  '\\Archive',
  '\\All',
  '\\Flagged',
] as const;

export type SpecialUse = (typeof SPECIAL_USES)[number];

export interface SpecialMailbox {
  path: string;
  name: string;
  flags: string[];
  specialUse?: string;
  specialUseSource?: string;
}

export interface ResolvedSpecialUse {
  inbox?: string;
  sent?: string;
  drafts?: string;
  trash?: string;
  junk?: string;
  archive?: string;
  all?: string;
  flagged?: string;
  sources: Record<string, string>;
}

const ROLE_TO_FIELD: Record<string, keyof Omit<ResolvedSpecialUse, 'sources'>> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'all',
  '\\Flagged': 'flagged',
};

/**
 * Resolve SPECIAL-USE mailboxes. Explicit account overrides win, then server flags,
 * then provider name hints (Gmail's localized folders, Outlook "Sent Items", and so on).
 */
export function resolveSpecialUse(
  mailboxes: SpecialMailbox[],
  provider: ProviderId,
  overrides: { sent?: string; trash?: string; drafts?: string } = {},
): ResolvedSpecialUse {
  const result: ResolvedSpecialUse = { sources: {} };
  const preset = providerById(provider);
  const set = (
    field: keyof Omit<ResolvedSpecialUse, 'sources'>,
    path: string,
    source: string,
  ): void => {
    if (!result[field]) {
      result[field] = path;
      result.sources[field] = source;
    }
  };
  if (overrides.sent) {
    set('sent', overrides.sent, 'config');
  }
  if (overrides.trash) {
    set('trash', overrides.trash, 'config');
  }
  if (overrides.drafts) {
    set('drafts', overrides.drafts, 'config');
  }
  for (const mailbox of mailboxes) {
    const role = mailbox.specialUse;
    if (!role) {
      continue;
    }
    const field = ROLE_TO_FIELD[role];
    if (field) {
      set(field, mailbox.path, mailbox.specialUseSource ?? 'extension');
    }
  }
  const inbox = mailboxes.find(
    (mailbox) => mailbox.path.toUpperCase() === 'INBOX' || mailbox.name.toUpperCase() === 'INBOX',
  );
  if (inbox) {
    set('inbox', inbox.path, 'name');
  }
  const hints: Array<[keyof Omit<ResolvedSpecialUse, 'sources'>, string[]]> = [
    ['sent', preset.specialUse.sent],
    ['trash', preset.specialUse.trash],
    ['drafts', preset.specialUse.drafts],
    ['junk', preset.specialUse.junk],
    ['archive', preset.specialUse.archive],
  ];
  for (const [field, names] of hints) {
    if (result[field]) {
      continue;
    }
    const match = mailboxes.find((mailbox) =>
      names.some(
        (name) => mailbox.path === name || mailbox.name.toLowerCase() === name.toLowerCase(),
      ),
    );
    if (match) {
      set(field, match.path, 'name');
    }
  }
  return result;
}
