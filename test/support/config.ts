import type { AppConfig, ResolvedAccount } from '../../src/config/schema.js';

export function account(overrides: Partial<ResolvedAccount> = {}): ResolvedAccount {
  const base: ResolvedAccount = {
    id: 'work',
    provider: 'generic',
    email: 'user@example.com',
    user: 'user',
    auth: { type: 'password', password: 'secret' },
    imap: {
      host: '127.0.0.1',
      port: 3143,
      secure: false,
      starttls: 'disabled',
      timeoutMs: 10_000,
      tls: { rejectUnauthorized: false },
    },
    smtp: {
      host: '127.0.0.1',
      port: 3025,
      secure: false,
      starttls: 'disabled',
      timeoutMs: 10_000,
      tls: { rejectUnauthorized: false },
    },
    identities: [{ id: 'default', email: 'user@example.com', name: 'User', default: true }],
    readOnly: false,
    allowSend: true,
    allowDelete: true,
    allowPermanentDelete: false,
    recipientDomainAllowList: [],
    allowFromDomains: [],
    appendSent: true,
    limits: {
      pageSize: 25,
      maxPageSize: 200,
      maxBodyChars: 100_000,
      maxAttachmentBytes: 1024 * 1024,
      maxMessageBytes: 2 * 1024 * 1024,
      maxSortCandidates: 5000,
      maxBulk: 50,
      bulkBudgetMs: 20_000,
    },
  };
  return { ...base, ...overrides, limits: { ...base.limits, ...(overrides.limits ?? {}) } };
}

export function appConfig(
  overrides: Partial<ResolvedAccount> = {},
  extra: Partial<AppConfig> = {},
): AppConfig {
  const resolved = account(overrides);
  return {
    defaultAccount: resolved.id,
    logLevel: 'silent',
    poolSize: 2,
    limits: resolved.limits,
    accounts: { [resolved.id]: resolved },
    secrets: ['secret'],
    ...extra,
  };
}
