import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { MailError, mapTransportError } from '../errors.js';
import type { EndpointSettings, ResolvedAccount } from '../config/schema.js';
import { addressToAscii } from '../mime/address.js';
import { dialTarget } from '../net/connect.js';

export interface DsnOptions {
  /** Envelope id (ENVID). */
  id?: string;
  /** RET=FULL or RET=HDRS. */
  ret?: 'FULL' | 'HDRS';
  /** NOTIFY recipients. */
  notify?: Array<'never' | 'success' | 'failure' | 'delay'>;
  /** ORCPT */
  orcpt?: string;
}

export interface SmtpSendInput {
  raw: Buffer;
  envelope: { from: string; to: string[] };
  dsn?: DsnOptions;
  /** Ask for BODY=8BITMIME when the raw message contains octets above 7 bits. */
  eightBit?: boolean;
}

export interface SmtpSendResult {
  messageId?: string;
  accepted: string[];
  rejected: string[];
  pending: string[];
  response: string;
}

export interface SmtpSender {
  verify(): Promise<void>;
  send(input: SmtpSendInput): Promise<SmtpSendResult>;
  close(): void;
}

export function createSmtpSender(account: ResolvedAccount, accessToken?: string): SmtpSender {
  if (!account.smtp) {
    throw mapTransportError(new Error(`Account ${account.id} has no SMTP endpoint configured`));
  }
  const options = transportOptions(account, account.smtp, accessToken);
  const transport = nodemailer.createTransport(options);
  return {
    async verify() {
      try {
        await transport.verify();
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    async send(input) {
      try {
        if (input.eightBit) {
          const offered = await extensionOffered(options, '8BITMIME');
          if (!offered) {
            throw new MailError(
              'CAPABILITY_UNSUPPORTED',
              'The message contains 8-bit octets and the SMTP server does not advertise 8BITMIME.',
              'Send a 7-bit transfer encoding, or use a server that advertises 8BITMIME.',
            );
          }
        }
        const mail = {
          raw: input.raw,
          envelope: {
            from: addressToAscii(input.envelope.from),
            to: input.envelope.to.map(addressToAscii),
            ...(input.eightBit ? { use8BitMime: true } : {}),
          },
          ...(input.dsn ? { dsn: toNodemailerDsn(input.dsn) } : {}),
        };
        const info = await transport.sendMail(mail);
        return {
          messageId: typeof info.messageId === 'string' ? info.messageId : undefined,
          accepted: asStrings(info.accepted),
          rejected: asStrings(info.rejected),
          pending: asStrings(info.pending),
          response: typeof info.response === 'string' ? info.response : '',
        };
      } catch (error) {
        throw mapTransportError(error);
      }
    },
    close() {
      transport.close();
    },
  };
}

function transportOptions(
  account: ResolvedAccount,
  endpoint: EndpointSettings,
  accessToken: string | undefined,
): SMTPTransport.Options {
  const dial = dialTarget(endpoint);
  const tls: SMTPTransport.Options['tls'] = {
    rejectUnauthorized: endpoint.tls.rejectUnauthorized,
    servername: dial.servername,
  };
  if (endpoint.tls.caFile) {
    tls.ca = readFileSync(endpoint.tls.caFile);
  }
  const options = {
    host: dial.host,
    port: dial.port,
    secure: endpoint.secure,
    tls,
    connectionTimeout: endpoint.timeoutMs,
    greetingTimeout: endpoint.timeoutMs,
    socketTimeout: endpoint.timeoutMs,
    name: 'mail-mcp',
    servername: dial.servername,
  } as SMTPTransport.Options;
  if (!endpoint.secure && endpoint.starttls === 'required') {
    options.requireTLS = true;
  }
  if (!endpoint.secure && endpoint.starttls === 'disabled') {
    options.ignoreTLS = true;
    options.requireTLS = false;
  }
  if (account.auth.type === 'password') {
    options.auth = { user: account.user, pass: account.auth.password };
  } else if (accessToken) {
    options.auth = { type: 'OAuth2', user: account.user, accessToken };
  }
  return options;
}

function toNodemailerDsn(dsn: DsnOptions): Record<string, unknown> {
  const notify = dsn.notify?.join(',') ?? undefined;
  return {
    ...(dsn.id ? { id: dsn.id } : {}),
    ...(dsn.ret ? { return: dsn.ret } : {}),
    ...(notify ? { notify } : {}),
    ...(dsn.orcpt ? { recipient: dsn.orcpt } : {}),
  };
}

async function extensionOffered(
  options: SMTPTransport.Options,
  extension: string,
): Promise<boolean> {
  const require = createRequire(import.meta.url);
  const SMTPConnection = require('nodemailer/lib/smtp-connection/index.js') as new (
    options: SMTPTransport.Options,
  ) => {
    connect(callback: (error?: Error) => void): void;
    close(): void;
    _supportedExtensions?: string[];
    once(event: 'error', listener: (error: Error) => void): void;
  };
  return new Promise((resolve, reject) => {
    const connection = new SMTPConnection({
      ...options,
      connectionTimeout: options.connectionTimeout,
      greetingTimeout: options.greetingTimeout,
    });
    const finish = (error?: Error): void => {
      connection.close();
      if (error) {
        reject(mapTransportError(error));
        return;
      }
      resolve((connection._supportedExtensions ?? []).includes(extension));
    };
    connection.once('error', (error) => finish(error));
    connection.connect((error) => finish(error ?? undefined));
  });
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    if (typeof item === 'string') {
      return item;
    }
    if (typeof item === 'object' && item !== null && 'address' in item) {
      return String((item as { address: unknown }).address);
    }
    return String(item);
  });
}
