import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { MailError } from '../errors.js';
import { accountSchema, boundedCommandTimeout, configFileSchema, limitsSchema } from './schema.js';
import type {
  AppConfig,
  AuthSettings,
  EndpointSettings,
  Identity,
  Limits,
  RawAccount,
  ResolvedAccount,
  StarttlsMode,
  TlsSettings,
} from './schema.js';
import { providerById, type ProviderId } from './providers.js';
import { parseJsonc } from './jsonc.js';
import { substituteDeep } from './substitute.js';
import { parseIdentityList } from '../identities.js';
import { parseConnectAddress } from '../net/connect.js';

export interface LoadConfigOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

const DEFAULT_LIMITS: Limits = limitsSchema.parse({});

/**
 * Load configuration from a JSON/JSONC file and/or single-account environment variables.
 * Environment references inside the file are substituted before validation.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const filePath = options.configPath || env.MAIL_MCP_CONFIG;
  let fromFile: unknown = {};
  if (filePath) {
    const absolute = path.resolve(cwd, filePath);
    let text: string;
    try {
      text = readFileSync(absolute, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unreadable';
      throw new MailError(
        'CONFIG_ERROR',
        `Could not read configuration file ${absolute}: ${message}`,
      );
    }
    fromFile = substituteDeep(parseJsonc(text, absolute), env, absolute);
  }
  const parsedFile = parseWithZod(configFileSchema, fromFile, 'configuration');
  const accountsInput: Record<string, RawAccount> = { ...(parsedFile.accounts ?? {}) };
  const envAccount = !filePath || env.MAIL_IMAP_HOST ? accountFromEnv(env) : undefined;
  if (envAccount) {
    const envId = !filePath ? env.MAIL_ACCOUNT?.trim() || 'default' : 'default';
    accountsInput[envId] = mergeAccount(accountsInput[envId], envAccount);
  }
  const ids = Object.keys(accountsInput);
  if (ids.length === 0) {
    throw new MailError(
      'CONFIG_ERROR',
      'No mail accounts are configured.',
      'Set MAIL_IMAP_HOST, MAIL_USER and MAIL_PASSWORD, or pass --config with an accounts object.',
    );
  }
  const globalLimits = { ...DEFAULT_LIMITS, ...(parsedFile.limits ?? {}) };
  const secrets: string[] = [];
  const accounts: Record<string, ResolvedAccount> = {};
  for (const id of ids) {
    const raw = accountsInput[id];
    if (!raw) {
      continue;
    }
    accounts[id] = resolveAccount(id, raw, globalLimits, secrets);
  }
  const defaultAccount =
    parsedFile.defaultAccount ??
    (env.MAIL_ACCOUNT && accounts[env.MAIL_ACCOUNT] ? env.MAIL_ACCOUNT : undefined) ??
    (ids.length === 1 ? ids[0] : undefined);
  if (!defaultAccount || !accounts[defaultAccount]) {
    throw new MailError(
      'CONFIG_ERROR',
      'defaultAccount is required when more than one account is configured.',
      `Set defaultAccount to one of: ${ids.join(', ')}.`,
    );
  }
  const selected = accounts[defaultAccount];
  if (selected) {
    applyConnectOverride(selected, env);
  }
  return {
    defaultAccount,
    logLevel: parsedFile.logLevel ?? parseEnvLogLevel(env.MAIL_LOG_LEVEL) ?? 'info',
    poolSize: parsedFile.poolSize ?? positiveInt(env.MAIL_POOL_SIZE, 2),
    limits: globalLimits,
    accounts,
    ...(parsedFile.attachmentsDir ? { attachmentsDir: parsedFile.attachmentsDir } : {}),
    secrets,
  };
}

function applyConnectOverride(account: ResolvedAccount, env: NodeJS.ProcessEnv): void {
  if (env.MAIL_IMAP_CONNECT) {
    const parsed = parseConnectAddress(env.MAIL_IMAP_CONNECT);
    account.imap.connectHost = parsed.host;
    account.imap.connectPort = parsed.port;
  }
  if (env.MAIL_SMTP_CONNECT && account.smtp) {
    const parsed = parseConnectAddress(env.MAIL_SMTP_CONNECT);
    account.smtp.connectHost = parsed.host;
    account.smtp.connectPort = parsed.port;
  }
}

function mergeAccount(base: RawAccount | undefined, extra: RawAccount): RawAccount {
  if (!base) {
    return extra;
  }
  return {
    ...base,
    ...extra,
    auth: { ...(base.auth ?? {}), ...(extra.auth ?? {}) },
    imap: {
      ...(base.imap ?? {}),
      ...(extra.imap ?? {}),
      tls: { ...(base.imap?.tls ?? {}), ...(extra.imap?.tls ?? {}) },
    },
    smtp: {
      ...(base.smtp ?? {}),
      ...(extra.smtp ?? {}),
      tls: { ...(base.smtp?.tls ?? {}), ...(extra.smtp?.tls ?? {}) },
    },
    identities: extra.identities ?? base.identities,
    limits: { ...(base.limits ?? {}), ...(extra.limits ?? {}) },
  } as RawAccount;
}

function accountFromEnv(env: NodeJS.ProcessEnv): RawAccount | undefined {
  const hasImap = Boolean(env.MAIL_IMAP_HOST);
  const hasSmtp = Boolean(env.MAIL_SMTP_HOST);
  const hasUser = Boolean(env.MAIL_USER || env.MAIL_PASSWORD || env.MAIL_ACCESS_TOKEN);
  if (!hasImap && !hasSmtp && !hasUser) {
    return undefined;
  }
  const authType = env.MAIL_AUTH_TYPE;
  const account: RawAccount = {};
  if (env.MAIL_PROVIDER) {
    account.provider = parseProvider(env.MAIL_PROVIDER);
  }
  if (env.MAIL_FROM || env.MAIL_EMAIL) {
    account.email = env.MAIL_FROM || env.MAIL_EMAIL;
  }
  if (env.MAIL_IDENTITIES) {
    account.identities = parseIdentityList(env.MAIL_IDENTITIES).map((item, index) => ({
      id: `identity-${index + 1}`,
      email: item.email,
      ...(item.name ? { name: item.name } : {}),
      default: index === 0,
    }));
  }
  if (env.MAIL_USER) {
    account.user = env.MAIL_USER;
  }
  if (env.MAIL_PASSWORD) {
    account.password = env.MAIL_PASSWORD;
  }
  if (hasImap || env.MAIL_IMAP_PORT || env.MAIL_IMAP_SECURE || env.MAIL_IMAP_CONNECT) {
    const imapConnect = env.MAIL_IMAP_CONNECT
      ? parseConnectAddress(env.MAIL_IMAP_CONNECT)
      : undefined;
    account.imap = {
      host: env.MAIL_IMAP_HOST,
      port: env.MAIL_IMAP_PORT ? Number(env.MAIL_IMAP_PORT) : undefined,
      ...(imapConnect ? { connectHost: imapConnect.host, connectPort: imapConnect.port } : {}),
      secure: envFlag(env.MAIL_IMAP_SECURE),
      starttls: env.MAIL_IMAP_STARTTLS as RawAccount['imap'] extends infer T
        ? T extends { starttls?: infer S }
          ? S
          : never
        : never,
      timeoutMs: env.MAIL_IMAP_TIMEOUT_MS ? Number(env.MAIL_IMAP_TIMEOUT_MS) : undefined,
      tls: tlsFromEnv(env),
    };
  }
  if (hasSmtp || env.MAIL_SMTP_PORT || env.MAIL_SMTP_SECURE || env.MAIL_SMTP_CONNECT) {
    const smtpConnect = env.MAIL_SMTP_CONNECT
      ? parseConnectAddress(env.MAIL_SMTP_CONNECT)
      : undefined;
    account.smtp = {
      host: env.MAIL_SMTP_HOST,
      port: env.MAIL_SMTP_PORT ? Number(env.MAIL_SMTP_PORT) : undefined,
      ...(smtpConnect ? { connectHost: smtpConnect.host, connectPort: smtpConnect.port } : {}),
      secure: envFlag(env.MAIL_SMTP_SECURE),
      starttls: env.MAIL_SMTP_STARTTLS as 'required' | 'optional' | 'disabled' | undefined,
      timeoutMs: env.MAIL_SMTP_TIMEOUT_MS ? Number(env.MAIL_SMTP_TIMEOUT_MS) : undefined,
      tls: tlsFromEnv(env),
    };
  }
  if (
    authType ||
    env.MAIL_ACCESS_TOKEN ||
    env.MAIL_OAUTH_REFRESH_TOKEN ||
    env.MAIL_OAUTH_CLIENT_ID
  ) {
    account.auth = {
      type: authType as 'password' | 'xoauth2' | 'oauth2' | undefined,
      password: env.MAIL_PASSWORD,
      accessToken: env.MAIL_ACCESS_TOKEN,
      refreshToken: env.MAIL_OAUTH_REFRESH_TOKEN,
      clientId: env.MAIL_OAUTH_CLIENT_ID,
      clientSecret: env.MAIL_OAUTH_CLIENT_SECRET,
      tokenUrl: env.MAIL_OAUTH_TOKEN_URL,
      scope: env.MAIL_OAUTH_SCOPE,
    };
  }
  if (env.MAIL_READONLY) {
    account.readOnly = envBool(env.MAIL_READONLY);
  }
  if (env.MAIL_ALLOW_SEND) {
    account.allowSend = envBool(env.MAIL_ALLOW_SEND);
  }
  if (env.MAIL_ALLOW_DELETE) {
    account.allowDelete = envBool(env.MAIL_ALLOW_DELETE);
  }
  if (env.MAIL_ALLOW_PERMANENT_DELETE) {
    account.allowPermanentDelete = envBool(env.MAIL_ALLOW_PERMANENT_DELETE);
  }
  if (env.MAIL_RECIPIENT_DOMAINS) {
    account.recipientDomainAllowList = env.MAIL_RECIPIENT_DOMAINS.split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (env.MAIL_ALLOW_FROM_DOMAINS) {
    account.allowFromDomains = env.MAIL_ALLOW_FROM_DOMAINS.split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (env.MAIL_SEND_RATE_MAX && env.MAIL_SEND_RATE_WINDOW_MS) {
    account.sendRateLimit = {
      max: Number(env.MAIL_SEND_RATE_MAX),
      windowMs: Number(env.MAIL_SEND_RATE_WINDOW_MS),
    };
  }
  if (env.MAIL_APPEND_SENT) {
    account.appendSent = env.MAIL_APPEND_SENT === 'auto' ? 'auto' : envBool(env.MAIL_APPEND_SENT);
  }
  return parseWithZod(accountSchema, account, 'environment account');
}

function tlsFromEnv(
  env: NodeJS.ProcessEnv,
): { rejectUnauthorized: boolean; caFile?: string; servername?: string } | undefined {
  if (
    !env.MAIL_TLS_CA_FILE &&
    env.MAIL_TLS_REJECT_UNAUTHORIZED === undefined &&
    !env.MAIL_TLS_SERVERNAME
  ) {
    return undefined;
  }
  const tls: { rejectUnauthorized: boolean; caFile?: string; servername?: string } = {
    rejectUnauthorized:
      env.MAIL_TLS_REJECT_UNAUTHORIZED === undefined
        ? true
        : envBool(env.MAIL_TLS_REJECT_UNAUTHORIZED),
  };
  if (env.MAIL_TLS_CA_FILE) {
    tls.caFile = env.MAIL_TLS_CA_FILE;
  }
  if (env.MAIL_TLS_SERVERNAME) {
    tls.servername = env.MAIL_TLS_SERVERNAME;
  }
  return tls;
}

function resolveAccount(
  id: string,
  raw: RawAccount,
  globalLimits: Limits,
  secrets: string[],
): ResolvedAccount {
  const providerId: ProviderId = raw.provider ?? 'generic';
  const preset = providerById(providerId);
  const email = raw.email ?? raw.user;
  if (!email) {
    throw new MailError('CONFIG_ERROR', `Account "${id}" needs an email address (email or user).`);
  }
  const user = raw.user ?? email;
  const auth = resolveAuth(id, raw, preset.oauth?.tokenUrl, secrets);
  const imap = resolveEndpoint(
    id,
    'imap',
    raw.imap,
    preset.imap.host ? preset.imap : undefined,
    993,
    true,
  );
  const smtp =
    raw.smtp || preset.smtp.host
      ? resolveEndpoint(id, 'smtp', raw.smtp, preset.smtp.host ? preset.smtp : undefined, 465, true)
      : undefined;
  if (!imap.host) {
    throw new MailError(
      'CONFIG_ERROR',
      `Account "${id}" is missing imap.host.`,
      'Set imap.host or a provider preset such as "gmail".',
    );
  }
  const identities = resolveIdentities(id, raw.identities, email);
  collectSecrets(auth, secrets);
  const limits = { ...globalLimits, ...(raw.limits ?? {}) };
  const account: ResolvedAccount = {
    id,
    provider: providerId,
    email,
    user,
    auth,
    imap,
    identities,
    readOnly: raw.readOnly ?? false,
    allowSend: raw.allowSend ?? true,
    allowDelete: raw.allowDelete ?? true,
    allowPermanentDelete: raw.allowPermanentDelete ?? false,
    recipientDomainAllowList: (raw.recipientDomainAllowList ?? []).map((domain) =>
      domain.toLowerCase().replace(/^@/, ''),
    ),
    allowFromDomains: (raw.allowFromDomains ?? []).map((domain) =>
      domain.toLowerCase().replace(/^@/, ''),
    ),
    appendSent: raw.appendSent ?? 'auto',
    limits,
  };
  if (smtp?.host) {
    account.smtp = smtp;
  }
  if (raw.sendRateLimit) {
    account.sendRateLimit = raw.sendRateLimit;
  }
  if (raw.sentMailbox) {
    account.sentMailbox = raw.sentMailbox;
  }
  if (raw.trashMailbox) {
    account.trashMailbox = raw.trashMailbox;
  }
  if (raw.draftsMailbox) {
    account.draftsMailbox = raw.draftsMailbox;
  }
  if (account.readOnly && account.allowPermanentDelete) {
    throw new MailError(
      'CONFIG_ERROR',
      `Account "${id}" is readOnly and also allows permanent delete. Remove one of the two.`,
    );
  }
  return account;
}

function resolveAuth(
  id: string,
  raw: RawAccount,
  presetTokenUrl: string | undefined,
  _secrets: string[],
): AuthSettings {
  const auth = raw.auth ?? {};
  const password = auth.password ?? raw.password;
  const type =
    auth.type ??
    (auth.refreshToken ? 'oauth2' : undefined) ??
    (auth.accessToken ? 'xoauth2' : undefined) ??
    'password';
  if (type === 'password') {
    if (!password) {
      throw new MailError(
        'CONFIG_ERROR',
        `Account "${id}" uses password authentication but no password is set.`,
      );
    }
    return { type: 'password', password };
  }
  if (type === 'xoauth2') {
    if (!auth.accessToken) {
      throw new MailError(
        'CONFIG_ERROR',
        `Account "${id}" uses XOAUTH2 but auth.accessToken is missing.`,
      );
    }
    return { type: 'xoauth2', accessToken: auth.accessToken };
  }
  if (!auth.refreshToken || !auth.clientId || !auth.clientSecret) {
    throw new MailError(
      'CONFIG_ERROR',
      `Account "${id}" uses OAuth2 but refreshToken, clientId, and clientSecret are all required.`,
    );
  }
  const tokenUrl = auth.tokenUrl ?? presetTokenUrl;
  if (!tokenUrl) {
    throw new MailError(
      'CONFIG_ERROR',
      `Account "${id}" uses OAuth2 but no tokenUrl is set and the provider has no preset.`,
    );
  }
  const resolved: AuthSettings = {
    type: 'oauth2',
    refreshToken: auth.refreshToken,
    clientId: auth.clientId,
    clientSecret: auth.clientSecret,
    tokenUrl,
  };
  if (auth.accessToken) {
    resolved.accessToken = auth.accessToken;
  }
  if (auth.scope) {
    resolved.scope = auth.scope;
  }
  return resolved;
}

function resolveEndpoint(
  id: string,
  kind: 'imap' | 'smtp',
  raw: RawAccount['imap'],
  preset: { host: string; port: number; secure: boolean } | undefined,
  defaultPort: number,
  defaultSecure: boolean,
): EndpointSettings {
  const host = raw?.host || preset?.host || '';
  const secure = raw?.secure ?? preset?.secure ?? defaultSecure;
  const port = raw?.port ?? preset?.port ?? (secure ? defaultPort : kind === 'imap' ? 143 : 587);
  let starttls: StarttlsMode = raw?.starttls ?? (secure ? 'disabled' : 'required');
  if (secure) {
    starttls = 'disabled';
  }
  if (!secure && starttls === 'disabled' && raw?.starttls !== 'disabled') {
    starttls = 'required';
  }
  const tls: TlsSettings = {
    rejectUnauthorized: raw?.tls?.rejectUnauthorized ?? true,
  };
  if (raw?.tls?.caFile) {
    tls.caFile = raw.tls.caFile;
  }
  if (raw?.tls?.servername) {
    tls.servername = raw.tls.servername;
  }
  if (!host) {
    throw new MailError('CONFIG_ERROR', `Account "${id}" is missing ${kind}.host.`);
  }
  const endpoint: EndpointSettings = {
    host,
    port,
    secure,
    starttls,
    timeoutMs: boundedCommandTimeout(raw?.timeoutMs ?? 30_000),
    tls,
  };
  if (raw?.connectHost) {
    endpoint.connectHost = raw.connectHost;
  }
  if (raw?.connectPort) {
    endpoint.connectPort = raw.connectPort;
  }
  return endpoint;
}

function resolveIdentities(id: string, raw: RawAccount['identities'], email: string): Identity[] {
  const listed = raw ?? [];
  const withAccount =
    email && !listed.some((item) => item.email.toLowerCase() === email.toLowerCase())
      ? [...listed, { email, default: listed.length === 0 }]
      : listed;
  if (withAccount.length === 0) {
    return [{ id: 'default', email, default: true }];
  }
  const identities: Identity[] = withAccount.map((item, index) => {
    const identity: Identity = {
      id: item.id ?? `identity-${index + 1}`,
      email: item.email,
      default: item.default ?? false,
    };
    if (item.name) {
      identity.name = item.name;
    }
    if (item.replyTo) {
      identity.replyTo = item.replyTo;
    }
    return identity;
  });
  if (!identities.some((item) => item.default)) {
    const first = identities[0];
    if (first) {
      first.default = true;
    }
  }
  const defaults = identities.filter((item) => item.default);
  if (defaults.length > 1) {
    throw new MailError('CONFIG_ERROR', `Account "${id}" has more than one default identity.`);
  }
  return identities;
}

function collectSecrets(auth: AuthSettings, secrets: string[]): void {
  if (auth.type === 'password') {
    secrets.push(auth.password);
  } else if (auth.type === 'xoauth2') {
    secrets.push(auth.accessToken);
  } else {
    secrets.push(auth.refreshToken, auth.clientSecret);
    if (auth.accessToken) {
      secrets.push(auth.accessToken);
    }
  }
}

function parseWithZod<T>(
  schema: { parse: (value: unknown) => T },
  value: unknown,
  label: string,
): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new MailError('CONFIG_ERROR', `Invalid ${label}: ${details}`);
    }
    throw error;
  }
}

function envFlag(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  return envBool(value);
}

function envBool(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const lower = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lower)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(lower)) {
    return false;
  }
  throw new MailError('CONFIG_ERROR', `Expected a boolean environment value, received "${value}".`);
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new MailError('CONFIG_ERROR', `Expected a positive integer, received "${value}".`);
  }
  return parsed;
}

function parseEnvLogLevel(value: string | undefined): AppConfig['logLevel'] | undefined {
  if (!value) {
    return undefined;
  }
  const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
  if ((levels as readonly string[]).includes(value)) {
    return value as AppConfig['logLevel'];
  }
  throw new MailError('CONFIG_ERROR', `MAIL_LOG_LEVEL must be one of ${levels.join(', ')}.`);
}

function parseProvider(value: string): ProviderId {
  const known = [
    'generic',
    'gmail',
    'microsoft',
    'icloud',
    'fastmail',
    'yahoo',
    'proton-bridge',
  ] as const;
  if ((known as readonly string[]).includes(value)) {
    return value as ProviderId;
  }
  throw new MailError('CONFIG_ERROR', `MAIL_PROVIDER must be one of ${known.join(', ')}.`);
}

export function listAccountIds(config: AppConfig): string[] {
  return Object.keys(config.accounts);
}

export function requireAccount(config: AppConfig, accountId?: string): ResolvedAccount {
  const id = accountId || config.defaultAccount;
  const account = config.accounts[id];
  if (!account) {
    throw new MailError(
      'INVALID_ARGUMENT',
      `Unknown account "${id}".`,
      `Configured accounts: ${listAccountIds(config).join(', ') || '(none)'}.`,
    );
  }
  return account;
}
