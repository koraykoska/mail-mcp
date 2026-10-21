import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import { stripAddressComments } from '../../src/mime/outbound-headers.js';
import { MailService } from '../../src/service/mail-service.js';
import { TOOLS } from '../../src/tools/catalog.js';
import { createLogger } from '../../src/log.js';
import { simpleMessage } from '../fixtures/messages.js';
import { appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';
import type { SmtpSender } from '../../src/smtp/client.js';

function serviceFor(
  session: FakeSession,
  overrides: Parameters<typeof appConfig>[0] = {},
  smtp?: SmtpSender,
): MailService {
  return new MailService({
    config: appConfig({ appendSent: false, ...overrides }),
    pool: new FakePool(session) as never,
    smtpFactory: async () =>
      smtp ?? {
        verify: async () => undefined,
        send: async () => ({ accepted: [], rejected: [], pending: [], response: '250' }),
        close() {
          return undefined;
        },
      },
    logger: createLogger({ level: 'silent' }),
  });
}

function capturingSmtp(sent: Buffer[]): SmtpSender {
  return {
    verify: async () => undefined,
    send: async (input) => {
      sent.push(input.raw);
      return { accepted: ['ada@example.com'], rejected: [], pending: [], response: '250' };
    },
    close() {
      return undefined;
    },
  };
}

function draft(headers: string[], body = 'hello'): Buffer {
  return Buffer.from(
    [...headers, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body].join(
      '\r\n',
    ),
  );
}

function headerLines(raw: string, name: string): string[] {
  const block = raw.split(/\r?\n\r?\n/)[0] ?? '';
  return block.split(/\r?\n/).filter((line) => new RegExp(`^${name}:`, 'i').test(line));
}

const base = [
  'To: Ada <ada@example.com>',
  'Subject: Draft',
  'Date: Tue, 01 Jan 2026 00:00:00 +0000',
  'Message-ID: <draft@ex>',
];

describe('mail_send_draft address rewrite', () => {
  it('rewrites quoted, encoded-word, and comment forms on From, Reply-To, and Sender', async () => {
    const forms = [
      {
        from: '"Eve <eve@evil.test>" <user@example.com>',
        replyTo: '"Eve <eve@evil.test>" <user@example.com>',
        sender: '"Eve <eve@evil.test>" <user@example.com>',
      },
      {
        from: '=?utf-8?Q?Eve_=3Ceve=40evil.test=3E?= <user@example.com>',
        replyTo: '=?utf-8?Q?Eve_=3Ceve=40evil.test=3E?= <user@example.com>',
        sender: '=?utf-8?Q?Eve_=3Ceve=40evil.test=3E?= <user@example.com>',
      },
      {
        from: 'user@example.com (Eve <eve@evil.test>)',
        replyTo: 'user@example.com (Eve <eve@evil.test>)',
        sender: 'user@example.com (Eve <eve@evil.test>)',
      },
    ];
    for (const form of forms) {
      const session = new FakeSession(['IMAP4rev1']);
      session.ensure('Drafts', '\\Drafts');
      const sent: Buffer[] = [];
      const service = serviceFor(session, {}, capturingSmtp(sent));
      const saved = await session.append(
        'Drafts',
        draft([
          `From: ${form.from}`,
          `Sender: ${form.sender}`,
          `Reply-To: ${form.replyTo}`,
          ...base,
        ]),
        ['\\Draft'],
      );
      const result = await service.sendDraft({ mailbox: 'Drafts', uid: saved.uid ?? 0 });
      expect(result.identityReason).toBe('stored-draft');
      const wire = sent[0]?.toString('utf8') ?? '';
      expect(wire).not.toMatch(/eve@evil.test/i);
      expect(headerLines(wire, 'From')).toHaveLength(1);
      expect(headerLines(wire, 'Sender')).toHaveLength(1);
      expect(headerLines(wire, 'Reply-To')).toHaveLength(1);
      expect(wire).toMatch(/From:\s*User <user@example.com>/);
      expect(wire).toMatch(/Reply-To:\s*user@example.com/i);
      expect(wire).toMatch(/Sender:\s*user@example.com/i);
    }
  });

  it('keeps a quoted display name that is not another address', () => {
    expect(stripAddressComments('"User (desk)" <user@example.com>')).toBe(
      '"User (desk)" <user@example.com>',
    );
    expect(stripAddressComments('user@example.com (Eve <eve@evil.test>)')).toBe('user@example.com');
  });

  it('rewrites a kept Resent-From from the parsed address', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Drafts', '\\Drafts');
    const sent: Buffer[] = [];
    const service = serviceFor(session, {}, capturingSmtp(sent));
    const saved = await session.append(
      'Drafts',
      draft([
        'From: User <user@example.com>',
        'Resent-From: "Eve <eve@evil.test>" <user@example.com>',
        ...base,
      ]),
      ['\\Draft'],
    );
    await service.sendDraft({ mailbox: 'Drafts', uid: saved.uid ?? 0 });
    const wire = sent[0]?.toString('utf8') ?? '';
    expect(wire).not.toMatch(/eve@evil.test/i);
    expect(headerLines(wire, 'Resent-From')).toHaveLength(1);
    expect(wire).toMatch(/Resent-From:\s*user@example.com/i);
  });
});

describe('duplicate and spaced draft headers', () => {
  it('rejects a second From, Reply-To, or Sender, and a space before the colon', async () => {
    const cases = [
      ['From: User <user@example.com>', 'From: Eve <eve@evil.test>', ...base],
      ['From: User <user@example.com>', 'From: User <user@example.com>', ...base],
      [
        'From: User <user@example.com>',
        'Reply-To: User <user@example.com>',
        'Reply-To: Eve <eve@evil.test>',
        ...base,
      ],
      [
        'From: User <user@example.com>',
        'Sender: User <user@example.com>',
        'Sender: Eve <eve@evil.test>',
        ...base,
      ],
      ['From: User <user@example.com>', 'From : Eve <eve@evil.test>', ...base],
      ['From : User <user@example.com>', ...base],
    ];
    for (const headers of cases) {
      const session = new FakeSession(['IMAP4rev1']);
      session.ensure('Drafts', '\\Drafts');
      const sent: Buffer[] = [];
      const service = serviceFor(session, {}, capturingSmtp(sent));
      const saved = await session.append('Drafts', draft(headers), ['\\Draft']);
      await expect(
        service.sendDraft({ mailbox: 'Drafts', uid: saved.uid ?? 0 }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(sent).toHaveLength(0);
    }
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Drafts', '\\Drafts');
    const sent: Buffer[] = [];
    const service = serviceFor(session, {}, capturingSmtp(sent));
    const spaced = await session.append(
      'Drafts',
      draft(['From : User <user@example.com>', ...base]),
      ['\\Draft'],
    );
    const error = await service
      .sendDraft({ mailbox: 'Drafts', uid: spaced.uid ?? 0 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailError);
    expect(String((error as MailError).message)).toMatch(/not a valid field name/);
  });

  it('reports explicit when from is passed and stored-draft when it is omitted', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Drafts', '\\Drafts');
    const sent: Buffer[] = [];
    const service = serviceFor(session, {}, capturingSmtp(sent));
    const saved = await session.append(
      'Drafts',
      draft(['From: User <user@example.com>', ...base]),
      ['\\Draft'],
    );
    const replaced = await service.sendDraft({
      mailbox: 'Drafts',
      uid: saved.uid ?? 0,
      from: 'user@example.com',
    });
    expect(replaced.identityReason).toBe('explicit');
    expect(headerLines(sent[0]?.toString('utf8') ?? '', 'From')).toHaveLength(1);
  });
});

describe('routing X- aliases', () => {
  it('rejects X-Reply-To, X-Confirm-Reading-To, and the other routing aliases', async () => {
    const names = [
      'X-Reply-To',
      'X-Confirm-Reading-To',
      'X-Sender',
      'X-Envelope-From',
      'X-Original-From',
      'X-Apparently-From',
    ];
    const session = new FakeSession(['IMAP4rev1']);
    const sent: Buffer[] = [];
    const service = serviceFor(session, {}, capturingSmtp(sent));
    for (const name of names) {
      await expect(
        service.send({
          to: ['ada@example.com'],
          subject: 'Hi',
          text: 'body',
          headers: { [name]: 'Eve <eve@evil.test>' },
        }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    expect(sent).toHaveLength(0);
    await service.send({
      to: ['ada@example.com'],
      subject: 'Hi',
      text: 'body',
      headers: { 'X-Entity': '42' },
    });
    expect(sent[0]?.toString('utf8')).toMatch(/X-Entity:\s*42/);
    expect(sent[0]?.toString('utf8')).not.toMatch(/eve@evil.test/);
  });
});

describe('Message-ID thread scope', () => {
  it('keeps a Trash-only reply out of both seeds and reports excludedMatches', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    const service = serviceFor(session);
    const root = await session.append(
      'INBOX',
      simpleMessage({
        subject: 'Root',
        messageId: '<root@ex>',
        text: 'root',
        date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Trash',
      simpleMessage({
        subject: 'Re: Root',
        messageId: '<trash@ex>',
        inReplyTo: '<root@ex>',
        references: '<root@ex>',
        text: 'trash',
        date: 'Tue, 02 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const byId = await service.getThread({ messageId: '<root@ex>' });
    const byUid = await service.getThread({ mailbox: 'INBOX', uid: root.uid });
    const idBoxes = new Set((byId.items as Array<{ mailbox: string }>).map((item) => item.mailbox));
    const uidBoxes = new Set(
      (byUid.items as Array<{ mailbox: string }>).map((item) => item.mailbox),
    );
    expect(idBoxes.has('Trash')).toBe(false);
    expect(uidBoxes.has('Trash')).toBe(false);
    expect([...idBoxes].sort()).toEqual([...uidBoxes].sort());
    expect(byId.threadKey).toBe(byUid.threadKey);
    const excluded = byId.excludedMatches as Array<{ mailbox: string; count: number }>;
    expect(excluded).toEqual([{ mailbox: 'Trash', count: 1 }]);
    const text = TOOLS.find((tool) => tool.name === 'mail_get_thread')?.description ?? '';
    expect(text).toMatch(/excludedMatches/);
    expect(text).toMatch(/Junk and Trash stay out/);
    const draftText = TOOLS.find((tool) => tool.name === 'mail_send_draft')?.description ?? '';
    expect(draftText).toMatch(/stored-draft/);
    expect(draftText).toMatch(/one From, one Sender, and one Reply-To|written once/);
  });
});
