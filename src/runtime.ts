import { getAccessToken } from './auth/oauth.js';
import type { AppConfig } from './config/schema.js';
import { requireAccount } from './config/load.js';
import { ImapFlowSession } from './imap/flow-session.js';
import { ImapConnectionPool } from './imap/pool.js';
import { createLogger, type Logger } from './log.js';
import { MailService } from './service/mail-service.js';
import { createSmtpSender } from './smtp/client.js';

export interface Runtime {
  config: AppConfig;
  logger: Logger;
  service: MailService;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  config: AppConfig;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

/** Wire the IMAP pool, SMTP factory, and mail service for a loaded configuration. */
export function createRuntime(options: RuntimeOptions): Runtime {
  const logger =
    options.logger ??
    createLogger({ level: options.config.logLevel, secrets: options.config.secrets });
  for (const account of Object.values(options.config.accounts)) {
    if (!account.imap.tls.rejectUnauthorized || account.smtp?.tls.rejectUnauthorized === false) {
      logger.warn('tls certificate verification is disabled', { account: account.id });
    }
    if (account.imap.starttls === 'optional' || account.smtp?.starttls === 'optional') {
      logger.warn('starttls optional can stay on cleartext if the server does not offer it', {
        account: account.id,
      });
    }
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const pool = new ImapConnectionPool(
    async (accountId) => {
      const account = requireAccount(options.config, accountId);
      return new ImapFlowSession(
        account,
        (tokenOptions) =>
          getAccessToken(account.auth, account.id, fetchImpl, Date.now, tokenOptions),
        logger.child({ account: accountId }),
      );
    },
    options.config.poolSize,
    logger,
  );
  const service = new MailService({
    config: options.config,
    pool,
    logger,
    smtpFactory: async (account) => {
      const token = await getAccessToken(account.auth, account.id, fetchImpl);
      return createSmtpSender(account, token);
    },
  });
  return {
    config: options.config,
    logger,
    service,
    close: () => service.close(),
  };
}
