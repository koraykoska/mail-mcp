import { describe, expect, it } from 'vitest';
import { MailService } from '../../src/service/mail-service.js';
import { HEADER_ALLOWLIST } from '../../src/mime/outbound-headers.js';
import { TOOLS } from '../../src/tools/catalog.js';
import { createLogger } from '../../src/log.js';
import { simpleMessage } from '../fixtures/messages.js';
import { appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';
import type { SmtpSender } from '../../src/smtp/client.js';

function serviceFor(session: FakeSession, smtp?: SmtpSender): MailService {
  return new MailService({
    config: appConfig({ appendSent: false }),
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

function capturingSmtp(sent: Buffer[], envelopes: string[][]): SmtpSender {
  return {
    verify: async () => undefined,
    send: async (input) => {
      sent.push(input.raw);
      envelopes.push(input.envelope.to);
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
    'utf8',
  );
}

function headerBlock(raw: string): string {
  return raw.split(/\r?\n\r?\n/)[0] ?? '';
}

const base = [
  'From: User <user@example.com>',
  'Subject: Draft',
  'Date: Tue, 01 Jan 2026 00:00:00 +0000',
  'Message-ID: <draft@ex>',
];

describe('recipient display names', () => {
  it('drops an embedded address, an encoded-word, and a comment on To, Cc, and Bcc', async () => {
    const forms = [
      {
        to: '"Eve <eve@evil.test>" <ada@example.com>',
        cc: 'ada@example.com (Eve <eve@evil.test>)',
      },
      {
        to: '=?utf-8?Q?Eve_=3Ceve=40evil.test=3E?= <ada@example.com>',
        cc: '"Eve \uFF1Ceve\uFF20evil.test\uFF1E" <ada@example.com>',
      },
    ];
    for (const form of forms) {
      const session = new FakeSession(['IMAP4rev1']);
      session.ensure('Drafts', '\\Drafts');
      const sent: Buffer[] = [];
      const envelopes: string[][] = [];
      const service = serviceFor(session, capturingSmtp(sent, envelopes));
      const saved = await session.append(
        'Drafts',
        draft([
          `To: ${form.to}`,
          `Cc: ${form.cc}`,
          'Bcc: "Eve <eve@evil.test>" <bcc@example.com>',
          ...base,
        ]),
        ['\\Draft'],
      );
      await service.sendDraft({ mailbox: 'Drafts', uid: saved.uid ?? 0 });
      const wire = sent[0]?.toString('utf8') ?? '';
      const headers = headerBlock(wire);
      expect(headers).not.toMatch(/eve@evil.test/i);
      expect(headers).toMatch(/To:\s*ada@example.com/i);
      expect(headers).toMatch(/Cc:\s*ada@example.com/i);
      expect(headers).not.toMatch(/^Bcc:/im);
      expect(envelopes[0]?.every((item) => item.endsWith('@example.com'))).toBe(true);
      expect(envelopes[0]).toEqual(expect.arrayContaining(['ada@example.com', 'bcc@example.com']));
      expect(envelopes[0]?.join(' ')).not.toMatch(/eve@evil.test/i);
      sent.length = 0;
      envelopes.length = 0;
    }
  });

  it('sanitizes To and Cc on send, reply, and forward', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    const sent: Buffer[] = [];
    const envelopes: string[][] = [];
    const service = serviceFor(session, capturingSmtp(sent, envelopes));
    await service.send({
      to: [{ name: 'Eve <eve@evil.test>', address: 'ada@example.com' }],
      cc: [{ name: '=?x-unknown?Q?Eve_=3Ceve=40evil.test=3E?=', address: 'bob@example.com' }],
      subject: 'Hi',
      text: 'body',
    });
    const sentHeaders = headerBlock(sent[0]?.toString('utf8') ?? '');
    expect(sentHeaders).not.toMatch(/eve@evil.test/i);
    expect(sentHeaders).toMatch(/To:\s*ada@example.com/i);
    expect(sentHeaders).toMatch(/Cc:\s*bob@example.com/i);

    const original = await session.append(
      'INBOX',
      simpleMessage({
        from: 'Ada <ada@example.com>',
        to: '"Eve <eve@evil.test>" <bob@example.com>',
        messageId: '<orig@ex>',
        text: 'original',
      }),
      [],
    );
    await service.reply({
      mailbox: 'INBOX',
      uid: original.uid ?? 0,
      replyAll: true,
      text: 'reply',
    });
    const replyHeaders = headerBlock(sent[1]?.toString('utf8') ?? '');
    expect(replyHeaders).not.toMatch(/eve@evil.test/i);
    expect(replyHeaders).toMatch(/Cc:\s*bob@example.com/i);

    await service.forward({
      mailbox: 'INBOX',
      uid: original.uid ?? 0,
      to: [{ name: 'Eve \uFF1Ceve\uFF20evil.test\uFF1E', address: 'cara@example.com' }],
      cc: [{ name: 'Eve <eve@evil.test>', address: 'dee@example.com' }],
      text: 'forward',
    });
    const forwardHeaders = headerBlock(sent[2]?.toString('utf8') ?? '');
    expect(forwardHeaders).not.toMatch(/eve@evil.test/i);
    expect(forwardHeaders).toMatch(/To:\s*cara@example.com/i);
    expect(forwardHeaders).toMatch(/Cc:\s*dee@example.com/i);
  });
});

describe('draft allow-listed headers', () => {
  it('round-trips every allow-listed header name through mail_send_draft', async () => {
    const kept: Record<string, string> = {
      'List-Unsubscribe': '<mailto:unsub@example.com>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'Auto-Submitted': 'auto-generated',
      Precedence: 'bulk',
      Importance: 'high',
      Keywords: 'draft-keywords',
      Comments: 'draft-comment',
      'X-Entity': '42',
    };
    expect([...HEADER_ALLOWLIST]).toEqual(
      [...HEADER_ALLOWLIST].filter((name) =>
        Object.keys(kept).some((key) => key.toLowerCase() === name),
      ),
    );
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Drafts', '\\Drafts');
    const sent: Buffer[] = [];
    const service = serviceFor(session, capturingSmtp(sent, []));
    const saved = await session.append(
      'Drafts',
      draft([
        'To: Ada <ada@example.com>',
        ...base,
        ...Object.entries(kept).map(([name, value]) => `${name}: ${value}`),
      ]),
      ['\\Draft'],
    );
    await service.sendDraft({ mailbox: 'Drafts', uid: saved.uid ?? 0 });
    const headers = headerBlock(sent[0]?.toString('utf8') ?? '');
    for (const [name, value] of Object.entries(kept)) {
      expect(headers).toContain(`${name}: ${value}`);
    }
    expect(headers).not.toMatch(/\[object Object\]/);
    expect(headers).not.toMatch(/^priority:/im);
  });
});

describe('excludedMatches for both seeds', () => {
  it('reports the same path-ordered counts for a Message-ID seed and a uid seed', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    session.ensure('Junk', '\\Junk');
    session.ensure('Projects');
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
    const outside = [
      ['Trash', '<trash@ex>'],
      ['Junk', '<junk@ex>'],
      ['Projects', '<projects@ex>'],
    ] as const;
    for (const [mailbox, messageId] of outside) {
      await session.append(
        mailbox,
        simpleMessage({
          subject: 'Re: Root',
          messageId,
          inReplyTo: '<root@ex>',
          references: '<root@ex>',
          text: mailbox,
          date: 'Tue, 02 Jan 2026 00:00:00 +0000',
        }),
        [],
      );
    }
    const byId = await service.getThread({ messageId: '<root@ex>' });
    const byUid = await service.getThread({ mailbox: 'INBOX', uid: root.uid });
    const again = await service.getThread({ messageId: '<root@ex>' });
    const expected = [
      { mailbox: 'Junk', count: 1 },
      { mailbox: 'Projects', count: 1 },
      { mailbox: 'Trash', count: 1 },
    ];
    expect(byId.excludedMatches).toEqual(expected);
    expect(byUid.excludedMatches).toEqual(expected);
    expect(again.excludedMatches).toEqual(expected);
    expect(byId.threadKey).toBe(byUid.threadKey);
    const boxes = (byId.items as Array<{ mailbox: string }>).map((item) => item.mailbox);
    expect(boxes).not.toEqual(expect.arrayContaining(['Trash', 'Junk', 'Projects']));
  });

  it('does not open a Message-ID that exists only in Trash', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    const service = serviceFor(session);
    await session.append(
      'Trash',
      simpleMessage({
        subject: 'Only',
        messageId: '<only@ex>',
        text: 'only',
      }),
      [],
    );
    const hidden = await service.getThread({ messageId: '<only@ex>' });
    expect(hidden.items).toEqual([]);
    expect(hidden.excludedMatches).toEqual([{ mailbox: 'Trash', count: 1 }]);
    const opened = await service.getThread({ messageId: '<only@ex>', folders: ['Trash'] });
    expect(
      (opened.items as Array<{ mailbox: string }>).some((item) => item.mailbox === 'Trash'),
    ).toBe(true);
    const text = TOOLS.find((tool) => tool.name === 'mail_get_thread')?.description ?? '';
    expect(text).toMatch(/excludedMatches/);
    expect(text).toMatch(/name Junk or Trash in folders/);
  });
});

describe('X- routing rule', () => {
  it('rejects X- aliases by the routing-header rule and keeps X-Entity', async () => {
    const names = [
      'X-Mail-Reply-To',
      'X-Return-Receipt-To',
      'X-Disposition-Notification-To',
      'X-Errors-To',
      'X-Read-Receipt-To',
      'X-Confirm-Reading-To',
      'X-Bounce-To',
      'X-Resent-From',
      'X-Followup-To',
    ];
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Drafts', '\\Drafts');
    const sent: Buffer[] = [];
    const service = serviceFor(session, capturingSmtp(sent, []));
    for (const name of names) {
      await expect(
        service.send({
          to: ['ada@example.com'],
          subject: 'Hi',
          text: 'body',
          headers: { [name]: 'eve@evil.test' },
        }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      const saved = await session.append(
        'Drafts',
        draft(['To: Ada <ada@example.com>', ...base, `${name}: eve@evil.test`]),
        ['\\Draft'],
      );
      await expect(
        service.sendDraft({ mailbox: 'Drafts', uid: saved.uid ?? 0 }),
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
    const text = TOOLS.find((tool) => tool.name === 'mail_send_message')?.description ?? '';
    expect(text).toMatch(/followup/);
    expect(text).toMatch(/Other X-\* headers stay allowed/);
  });
});

describe('display-name compatibility form', () => {
  it('drops a fullwidth lookalike and an unknown-charset encoded-word', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Drafts', '\\Drafts');
    const sent: Buffer[] = [];
    const service = serviceFor(session, capturingSmtp(sent, []));
    const saved = await session.append(
      'Drafts',
      draft([
        'To: Ada <ada@example.com>',
        'Reply-To: "Eve \uFF1Ceve\uFF20evil.test\uFF1E" <user@example.com>',
        'From: "=?x-unknown?Q?Eve_=3Ceve=40evil.test=3E?=" <user@example.com>',
        ...base.filter((line) => !line.startsWith('From:')),
      ]),
      ['\\Draft'],
    );
    await service.sendDraft({ mailbox: 'Drafts', uid: saved.uid ?? 0 });
    const headers = headerBlock(sent[0]?.toString('utf8') ?? '');
    expect(headers).not.toMatch(/eve@evil.test/i);
    expect(headers).not.toMatch(/\uFF20/);
    expect(headers).not.toMatch(/=\?x-unknown/i);
    expect(headers).toMatch(/Reply-To:\s*user@example.com/i);
    expect(headers).toMatch(/From:\s*User <user@example.com>/);
  });
});
