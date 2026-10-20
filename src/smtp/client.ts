import { readFileSync } from 'node:fs';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { mapTransportError } from '../errors.js';
import type { EndpointSettings, ResolvedAccount } from '../config/schema.js';
import { addressToAscii } from '../mime/address.js';

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
  const transport = nodemailer.createTransport(
    transportOptions(account, account.smtp, accessToken),
  );
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
        const info = await transport.sendMail({
          raw: input.raw,
          envelope: {
            from: addressToAscii(input.envelope.from),
            to: input.envelope.to.map(addressToAscii),
          },
          ...(input.dsn ? { dsn: toNodemailerDsn(input.dsn) } : {}),
        });
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
  const tls: SMTPTransport.Options['tls'] = {
    rejectUnauthorized: endpoint.tls.rejectUnauthorized,
  };
  if (endpoint.tls.servername) {
    tls.servername = endpoint.tls.servername;
  }
  if (endpoint.tls.caFile) {
    tls.ca = readFileSync(endpoint.tls.caFile);
  }
  const options: SMTPTransport.Options = {
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    tls,
    connectionTimeout: endpoint.timeoutMs,
    greetingTimeout: endpoint.timeoutMs,
    socketTimeout: endpoint.timeoutMs,
    name: 'mail-mcp',
  };
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
