import { z } from 'zod';
import { PROVIDER_IDS, type ProviderId } from './providers.js';

export const starttlsModeSchema = z.enum(['required', 'optional', 'disabled']);
export type StarttlsMode = z.infer<typeof starttlsModeSchema>;

export const tlsSchema = z
  .object({
    rejectUnauthorized: z
      .boolean()
      .default(true)
      .describe(
        'When false, certificate verification is skipped. Unsafe outside a trusted local bridge.',
      ),
    caFile: z
      .string()
      .min(1)
      .optional()
      .describe('PEM file with one or more CA certificates to trust.'),
    servername: z
      .string()
      .min(1)
      .optional()
      .describe('TLS SNI / certificate name when it differs from the host.'),
  })
  .strict();

export const endpointSchema = z
  .object({
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    connectHost: z
      .string()
      .min(1)
      .optional()
      .describe(
        'TCP host when it differs from host, such as 127.0.0.1 for an SSH tunnel. TLS still verifies host.',
      ),
    connectPort: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe('TCP port when it differs from port. TLS still verifies host.'),
    secure: z
      .boolean()
      .optional()
      .describe(
        'True for implicit TLS (typically 993 or 465). False for cleartext that may upgrade with STARTTLS.',
      ),
    starttls: starttlsModeSchema
      .optional()
      .describe(
        'required (default when secure is false), optional, or disabled. disabled is cleartext and must be explicit.',
      ),
    timeoutMs: z.number().int().positive().optional(),
    tls: tlsSchema.optional(),
  })
  .strict();

export const authSchema = z
  .object({
    type: z.enum(['password', 'xoauth2', 'oauth2']).optional(),
    password: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    tokenUrl: z.string().url().optional(),
    scope: z.string().min(1).optional(),
  })
  .strict();

export const identitySchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().optional(),
    email: z.string().min(3),
    replyTo: z.string().min(3).optional(),
    default: z.boolean().optional(),
  })
  .strict();

export const rateSchema = z
  .object({
    max: z.number().int().positive(),
    windowMs: z.number().int().positive(),
  })
  .strict();

export const limitsSchema = z
  .object({
    pageSize: z.number().int().positive().default(25),
    maxPageSize: z.number().int().positive().default(200),
    maxBodyChars: z.number().int().positive().default(100_000),
    maxAttachmentBytes: z
      .number()
      .int()
      .positive()
      .default(15 * 1024 * 1024),
    maxMessageBytes: z
      .number()
      .int()
      .positive()
      .default(35 * 1024 * 1024),
    maxSortCandidates: z.number().int().positive().default(5_000),
    maxBulk: z.number().int().positive().default(200),
  })
  .strict();

export const accountSchema = z
  .object({
    provider: z.enum(PROVIDER_IDS).optional(),
    email: z.string().min(3).optional(),
    user: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    auth: authSchema.optional(),
    imap: endpointSchema.optional(),
    smtp: endpointSchema.optional(),
    identities: z.array(identitySchema).optional(),
    readOnly: z.boolean().optional(),
    allowSend: z.boolean().optional(),
    allowDelete: z.boolean().optional(),
    allowPermanentDelete: z.boolean().optional(),
    recipientDomainAllowList: z.array(z.string().min(1)).optional(),
    allowFromDomains: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'When set, From may be any address at these domains in addition to the configured identities. Certificate checks are unrelated and stay enabled.',
      ),
    sendRateLimit: rateSchema.optional(),
    appendSent: z.union([z.boolean(), z.literal('auto')]).optional(),
    sentMailbox: z.string().min(1).optional(),
    trashMailbox: z.string().min(1).optional(),
    draftsMailbox: z.string().min(1).optional(),
    limits: limitsSchema.partial().optional(),
  })
  .strict();

export const configFileSchema = z
  .object({
    $schema: z.string().min(1).optional().describe('JSON Schema URL. Ignored by the loader.'),
    defaultAccount: z.string().min(1).optional(),
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).optional(),
    poolSize: z.number().int().min(1).max(8).optional(),
    attachmentsDir: z
      .string()
      .min(1)
      .optional()
      .describe('If set, mail_download_attachment can only write inside this directory.'),
    limits: limitsSchema.partial().optional(),
    accounts: z.record(z.string().min(1), accountSchema).optional(),
  })
  .strict();

export type RawConfigFile = z.infer<typeof configFileSchema>;
export type RawAccount = z.infer<typeof accountSchema>;

export interface TlsSettings {
  rejectUnauthorized: boolean;
  caFile?: string;
  servername?: string;
}

export interface EndpointSettings {
  host: string;
  port: number;
  /** TCP dial host. Defaults to `host`. TLS still uses `host` or `tls.servername`. */
  connectHost?: string;
  /** TCP dial port. Defaults to `port`. */
  connectPort?: number;
  secure: boolean;
  starttls: StarttlsMode;
  timeoutMs: number;
  tls: TlsSettings;
}

export interface Identity {
  id: string;
  name?: string;
  email: string;
  replyTo?: string;
  default: boolean;
}

export type AuthSettings =
  | { type: 'password'; password: string }
  | { type: 'xoauth2'; accessToken: string }
  | {
      type: 'oauth2';
      accessToken?: string;
      refreshToken: string;
      clientId: string;
      clientSecret: string;
      tokenUrl: string;
      scope?: string;
    };

export interface Limits {
  pageSize: number;
  maxPageSize: number;
  maxBodyChars: number;
  maxAttachmentBytes: number;
  maxMessageBytes: number;
  maxSortCandidates: number;
  maxBulk: number;
}

export interface ResolvedAccount {
  id: string;
  provider: ProviderId;
  email: string;
  user: string;
  auth: AuthSettings;
  imap: EndpointSettings;
  smtp?: EndpointSettings;
  identities: Identity[];
  readOnly: boolean;
  allowSend: boolean;
  allowDelete: boolean;
  allowPermanentDelete: boolean;
  recipientDomainAllowList: string[];
  /** Extra domains whose addresses may be used as From. Empty means identities only. */
  allowFromDomains: string[];
  sendRateLimit?: { max: number; windowMs: number };
  /** false skips the Sent APPEND. true always appends. auto skips Gmail. */
  appendSent: boolean | 'auto';
  sentMailbox?: string;
  trashMailbox?: string;
  draftsMailbox?: string;
  limits: Limits;
}

export interface AppConfig {
  defaultAccount: string;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  poolSize: number;
  limits: Limits;
  accounts: Record<string, ResolvedAccount>;
  /** When set, attachment saves are confined to this directory. */
  attachmentsDir?: string;
  /** Secret values collected so logs can scrub them. */
  secrets: string[];
}
