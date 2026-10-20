export const PROVIDER_IDS = [
  'generic',
  'gmail',
  'microsoft',
  'icloud',
  'fastmail',
  'yahoo',
  'proton-bridge',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  /** Gmail stores a copy in Sent itself, so auto mode skips the extra APPEND. */
  appendSent: boolean;
  notes: string;
  oauth?: {
    tokenUrl: string;
    scopes: string[];
  };
  specialUse: {
    sent: string[];
    trash: string[];
    drafts: string[];
    junk: string[];
    archive: string[];
  };
}

export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  generic: {
    id: 'generic',
    label: 'Generic IMAP/SMTP',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    appendSent: true,
    notes: 'Set imap.host and smtp.host. Dovecot and Postfix submission are the usual pair.',
    specialUse: {
      sent: ['Sent', 'Sent Messages', 'Sent Items'],
      trash: ['Trash', 'Deleted', 'Deleted Items', 'Deleted Messages'],
      drafts: ['Drafts'],
      junk: ['Junk', 'Spam', 'Junk E-mail'],
      archive: ['Archive', 'Archives'],
    },
  },
  gmail: {
    id: 'gmail',
    label: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    appendSent: false,
    notes:
      'Enable IMAP in Gmail settings. Use an app password or OAuth2. Gmail copies sent mail itself.',
    oauth: {
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://mail.google.com/'],
    },
    specialUse: {
      sent: ['[Gmail]/Sent Mail', 'Sent', 'Sent Mail'],
      trash: ['[Gmail]/Trash', 'Trash'],
      drafts: ['[Gmail]/Drafts', 'Drafts'],
      junk: ['[Gmail]/Spam', 'Spam'],
      archive: ['[Gmail]/All Mail'],
    },
  },
  microsoft: {
    id: 'microsoft',
    label: 'Outlook / Microsoft 365',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    appendSent: true,
    notes:
      'SMTP submission on 587 uses STARTTLS. OAuth2 is the supported authentication for most tenants. The token URL defaults to the common tenant.',
    oauth: {
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: [
        'https://outlook.office.com/IMAP.AccessAsUser.All',
        'https://outlook.office.com/SMTP.Send',
        'offline_access',
      ],
    },
    specialUse: {
      sent: ['Sent Items', 'Sent'],
      trash: ['Deleted Items', 'Deleted'],
      drafts: ['Drafts'],
      junk: ['Junk Email', 'Junk'],
      archive: ['Archive'],
    },
  },
  icloud: {
    id: 'icloud',
    label: 'iCloud Mail',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    appendSent: true,
    notes:
      'Use an app-specific password from the Apple ID site. The username is the full iCloud email address.',
    specialUse: {
      sent: ['Sent Messages', 'Sent'],
      trash: ['Deleted Messages', 'Trash'],
      drafts: ['Drafts'],
      junk: ['Junk'],
      archive: ['Archive'],
    },
  },
  fastmail: {
    id: 'fastmail',
    label: 'Fastmail',
    imap: { host: 'imap.fastmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.fastmail.com', port: 465, secure: true },
    appendSent: true,
    notes: 'Create an app password. Fastmail supports IMAP SPECIAL-USE, IDLE, and CONDSTORE.',
    specialUse: {
      sent: ['Sent'],
      trash: ['Trash'],
      drafts: ['Drafts'],
      junk: ['Spam', 'Junk'],
      archive: ['Archive'],
    },
  },
  yahoo: {
    id: 'yahoo',
    label: 'Yahoo Mail',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    appendSent: true,
    notes: 'Yahoo requires an app password when two-step verification is on.',
    specialUse: {
      sent: ['Sent'],
      trash: ['Trash'],
      drafts: ['Drafts'],
      junk: ['Bulk Mail', 'Spam'],
      archive: ['Archive'],
    },
  },
  'proton-bridge': {
    id: 'proton-bridge',
    label: 'Proton Mail Bridge',
    imap: { host: '127.0.0.1', port: 1143, secure: false },
    smtp: { host: '127.0.0.1', port: 1025, secure: false },
    appendSent: true,
    notes:
      'Proton Bridge listens on localhost and uses STARTTLS with a certificate it generates. Trust that CA or set tls.rejectUnauthorized to false for the bridge only. The password is the Bridge password, not the Proton account password.',
    specialUse: {
      sent: ['Sent'],
      trash: ['Trash'],
      drafts: ['Drafts'],
      junk: ['Spam'],
      archive: ['Archive', 'All Mail'],
    },
  },
};

export function providerById(id: ProviderId): ProviderPreset {
  return PROVIDERS[id];
}
