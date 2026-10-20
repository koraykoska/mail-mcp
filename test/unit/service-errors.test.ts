import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import { createLogger } from '../../src/log.js';
import { MailService } from '../../src/service/mail-service.js';
import { account, appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';
import type { SmtpSender } from '../../src/smtp/client.js';
import { simpleMessage } from '../fixtures/messages.js';

function make(session = new FakeSession(), overrides: Parameters<typeof appConfig>[0] = {}) {
  const smtp: SmtpSender = {
    async verify() {
      return undefined;
    },
    async send(input) {
      return {
        accepted: input.envelope.to,
        rejected: [],
        pending: [],
        response: '250 ok',
      };
    },
    close() {
      return undefined;
    },
  };
  const config = appConfig(overrides);
  return new MailService({
    config,
    pool: new FakePool(session),
    smtpFactory: async () => smtp,
    logger: createLogger({ level: 'silent', secrets: config.secrets }),
  });
}

describe('service error paths', () => {
  it('rejects empty search, unknown quota, and missing capabilities', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    const service = make(session);
    await expect(service.searchMessages({ mailbox: 'INBOX' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(service.quota(undefined)).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    });
    await expect(service.serverId()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await expect(
      service.setFlags({
        mailbox: 'INBOX',
        uids: [1],
        flags: ['\\Seen'],
        operation: 'add',
        unchangedSince: '1',
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
  });

  it('enforces size, send, and delete guards', async () => {
    const session = new FakeSession();
    await session.append('INBOX', simpleMessage({ text: 'hello' }), []);
    const service = make(session, {
      limits: { ...account().limits, maxMessageBytes: 10, maxBulk: 1, maxSortCandidates: 0 },
      allowSend: false,
      allowDelete: false,
      allowPermanentDelete: false,
    });
    await expect(service.getSource({ mailbox: 'INBOX', uid: 1 })).rejects.toMatchObject({
      code: 'SIZE_LIMIT',
    });
    await expect(
      service.send({ to: ['ada@example.com'], subject: 's', text: 't' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(service.deleteMessages({ mailbox: 'INBOX', uids: [1] })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(service.expunge(undefined, 'INBOX')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(
      service.bulk({ mailbox: 'INBOX', uids: [], action: 'addFlags', flags: ['\\Seen'] }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.waitForChanges({ timeoutMs: 10 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('requires SMTP, a reply address, and an attachments directory', async () => {
    const session = new FakeSession();
    await session.append('INBOX', simpleMessage({ from: 'user@example.com', text: 'mine' }), []);
    const config = appConfig();
    delete config.accounts.work?.smtp;
    const service = new MailService({
      config,
      pool: new FakePool(session),
      smtpFactory: async () => {
        throw new Error('no');
      },
      logger: createLogger({ level: 'silent' }),
    });
    await expect(
      service.send({ to: ['ada@example.com'], subject: 's', text: 't' }),
    ).rejects.toMatchObject({ code: 'CONFIG_ERROR' });
    const probe = await service.verifySmtp();
    expect(probe.smtp).toMatchObject({ ok: false });
    await expect(service.reply({ mailbox: 'INBOX', uid: 1, text: 're' })).rejects.toBeInstanceOf(
      MailError,
    );
    await expect(
      service.append({
        mailbox: 'INBOX',
        to: ['ada@example.com'],
        subject: 's',
        text: 't',
        attachments: [{ path: '/etc/hosts', filename: 'hosts' }],
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
