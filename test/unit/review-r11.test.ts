import { describe, expect, it } from 'vitest';
import { formatAddress, parseAddress, parseAddressList } from '../../src/mime/address.js';
import { routingHeaderDenied } from '../../src/mime/outbound-headers.js';
import { MailService } from '../../src/service/mail-service.js';
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
    'utf8',
  );
}

function messageIdsOf(result: Record<string, unknown>): string[] {
  return (result.items as Array<{ messageId: string | null }>)
    .map((item) => item.messageId ?? '')
    .sort();
}

const base = [
  'From: User <user@example.com>',
  'Subject: Draft',
  'Date: Tue, 01 Jan 2026 00:00:00 +0000',
  'Message-ID: <draft@ex>',
];

describe('case-insensitive X- header rule', () => {
  const denied = [
    'X-MDN-tO',
    'X-Google-Original-fRoM',
    'X-oRiGiNaLfRoM',
    'X-Original_fRoM',
    'X-aPpArEnTlYfRoM',
    'X-cOnFiRmReAdInGtO',
    'X-eNvElOpE',
    'X-bOuNcE',
    'X-rEtUrNpAtH',
    'X-Delivered-tO',
    'X-Notification-tO',
    'X-Receipt-tO',
    'X-Followup-tO',
    'X-Reading-tO',
    'X-RCPTTO',
    'X-OriginalRecipient',
    'X-Google-Original-Recipient',
    'X-Original-From2',
    'X-From2',
    'X-Report-Abuse-To',
    'X-Complaint-To',
    'X-Authenticated-Sender',
    'X-Forwarded-To',
    'X-X_From',
  ];
  const allowed = [
    'X-Entity',
    'X-Mailer',
    'X-Priority',
    'X-Campaign',
    'X-Auto-Response-Suppress',
    'X-Feedback-ID',
    'X-Originating-IP',
    'X-Original-Arrival-Time',
    'X-Spam-Status',
    'X-Loop',
    'X-BeenThere',
    'X-Request-Id',
    'X-Sender-IP',
    'X-Notification',
    'X-GitHub-Notification',
    'X-Photo',
  ];

  it('denies staggered and digit spellings and keeps the safe names', async () => {
    expect(denied.every((name) => routingHeaderDenied(name))).toBe(true);
    expect(allowed.every((name) => routingHeaderDenied(name))).toBe(false);

    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Drafts', '\\Drafts');
    const sent: Buffer[] = [];
    const service = serviceFor(session, capturingSmtp(sent));
    for (const name of denied) {
      await expect(
        service.send({
          to: ['ada@example.com'],
          subject: 'Hi',
          text: 'body',
          headers: { [name]: 'eve@evil.test' },
        }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    const saved = await session.append(
      'Drafts',
      draft(['To: Ada <ada@example.com>', ...base, 'X-MDN-tO: eve@evil.test']),
      ['\\Draft'],
    );
    await expect(
      service.sendDraft({ mailbox: 'Drafts', uid: saved.uid ?? 0 }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(sent).toHaveLength(0);

    const headers = Object.fromEntries(allowed.map((name) => [name, `ok-${name}`]));
    await service.send({
      to: ['ada@example.com'],
      subject: 'Hi',
      text: 'body',
      headers,
    });
    const wire = sent[0]?.toString('utf8') ?? '';
    expect(wire).not.toMatch(/eve@evil.test/);
    for (const name of allowed) {
      expect(wire.toLowerCase()).toContain(`${name.toLowerCase()}:`);
      expect(wire).toContain(`ok-${name}`);
    }
    await service.send({
      to: ['ada@example.com'],
      subject: 'Hi',
      text: 'body',
      headers: { 'X-sender-ip': 'ok-X-sender-ip' },
    });
    const senderIp = sent[1]?.toString('utf8') ?? '';
    expect(senderIp.toLowerCase()).toContain('x-sender-ip:');
    expect(senderIp).toContain('ok-X-sender-ip');
    expect(routingHeaderDenied('X-sender-ip')).toBe(false);
    const kept = await session.append(
      'Drafts',
      draft([
        'To: Ada <ada@example.com>',
        ...base,
        'X-Photo: kept',
        'X-sender-ip: 203.0.113.5',
        'X-Original-Arrival-Time: today',
      ]),
      ['\\Draft'],
    );
    await service.sendDraft({ mailbox: 'Drafts', uid: kept.uid ?? 0 });
    const draftWire = sent[2]?.toString('utf8') ?? '';
    expect(draftWire).toMatch(/X-Photo:\s*kept/i);
    expect(draftWire).toMatch(/X-sender-ip:\s*203\.0\.113\.5/i);
    expect(draftWire).toMatch(/X-Original-Arrival-Time:\s*today/i);
    expect(draftWire).not.toMatch(/eve@evil.test/);

    const text = TOOLS.find((tool) => tool.name === 'mail_send_message')?.description ?? '';
    expect(text).toMatch(/followup/);
    expect(text).toMatch(/Other X-\* headers stay allowed/);
    expect(text).not.toMatch(/contains reply, receipt, notification/);
    expect(text).toMatch(/X-Report-Abuse-To/);
  });
});

describe('Trash-only seed walks both directions', () => {
  it('returns the parent and the grandchild for both seeds', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    for (let index = 1; index <= 9; index += 1) {
      session.ensure(`Box${index}`);
    }
    const service = serviceFor(session);
    await session.append(
      'INBOX',
      simpleMessage({
        subject: 'Parent',
        messageId: '<parent@ex>',
        text: 'parent',
        date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Trash',
      simpleMessage({
        subject: 'Child',
        messageId: '<child@ex>',
        inReplyTo: '<parent@ex>',
        references: '<parent@ex>',
        text: 'child',
        date: 'Tue, 02 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const grandchild = await session.append(
      'INBOX',
      simpleMessage({
        subject: 'Grandchild',
        messageId: '<grand@ex>',
        inReplyTo: '<child@ex>',
        references: '<child@ex>',
        text: 'grand',
        date: 'Wed, 03 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const byId = await service.getThread({ messageId: '<child@ex>' });
    const byUid = await service.getThread({ mailbox: 'INBOX', uid: grandchild.uid });
    expect(messageIdsOf(byId)).toEqual(['<grand@ex>', '<parent@ex>']);
    expect(messageIdsOf(byUid)).toEqual(['<grand@ex>', '<parent@ex>']);
    expect(byId.threadKey).toBe(byUid.threadKey);
    expect(byId.excludedMatches).toEqual([{ mailbox: 'Trash', count: 1 }]);
    expect(byUid.excludedMatches).toEqual([{ mailbox: 'Trash', count: 1 }]);
    expect(byUid.rounds).toBeGreaterThanOrEqual(1);
    expect(byId.rounds).toBeGreaterThanOrEqual(1);
    const thread = TOOLS.find((tool) => tool.name === 'mail_get_thread')?.description ?? '';
    expect(thread).toMatch(/every id they cite in In-Reply-To or References/);
    expect(thread).toMatch(/both directions/);
    expect(thread).toMatch(/name Junk or Trash in folders/);
  });

  it('does not count a neighbor whose id only shares a substring', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    session.ensure('Notes');
    const service = serviceFor(session);
    await session.append(
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
      'Notes',
      simpleMessage({
        subject: 'Near',
        messageId: '<xroot@ex>',
        text: 'near',
        date: 'Tue, 02 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Trash',
      simpleMessage({
        subject: 'Also near',
        messageId: '<other@ex>',
        references: '<xroot@ex>',
        text: 'trash',
        date: 'Wed, 03 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const result = await service.getThread({ messageId: '<root@ex>' });
    expect(messageIdsOf(result)).toEqual(['<root@ex>']);
    expect(result.excludedMatches).toEqual([]);
  });

  it('skips the out-of-scope search when every mailbox is in scope', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    const service = serviceFor(session);
    const root = await session.append(
      'INBOX',
      simpleMessage({ messageId: '<root@ex>', text: 'root' }),
      [],
    );
    const result = await service.getThread({
      mailbox: 'INBOX',
      uid: root.uid,
      folders: ['INBOX', 'Sent', 'Drafts', 'Trash'],
    });
    expect(messageIdsOf(result)).toEqual(['<root@ex>']);
    expect(result.excludedMatches).toEqual([]);
  });
});

describe('thread cap ignores the placeholder seed', () => {
  it('keeps the one in-scope reply when maxMessages is 1', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    const service = serviceFor(session);
    await session.append(
      'Trash',
      simpleMessage({
        subject: 'Root',
        messageId: '<root@ex>',
        text: 'root',
        date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'INBOX',
      simpleMessage({
        subject: 'Reply',
        messageId: '<reply@ex>',
        inReplyTo: '<root@ex>',
        references: '<root@ex>',
        text: 'reply',
        date: 'Tue, 02 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const result = await service.getThread({ messageId: '<root@ex>', maxMessages: 1 });
    expect(messageIdsOf(result)).toEqual(['<reply@ex>']);
    expect(result.total).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.excludedMatches).toEqual([{ mailbox: 'Trash', count: 1 }]);
  });

  it('returns 100 in-scope messages at the default cap', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    const service = serviceFor(session);
    await session.append(
      'Trash',
      simpleMessage({
        subject: 'Root',
        messageId: '<root@ex>',
        text: 'root',
        date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    for (let index = 1; index <= 100; index += 1) {
      await session.append(
        'INBOX',
        simpleMessage({
          subject: `Reply ${index}`,
          messageId: `<reply-${index}@ex>`,
          inReplyTo: '<root@ex>',
          references: '<root@ex>',
          text: `reply ${index}`,
          date: 'Tue, 02 Jan 2026 00:00:00 +0000',
        }),
        [],
      );
    }
    const result = await service.getThread({ messageId: '<root@ex>', limit: 100 });
    expect(result.total).toBe(100);
    expect(result.items).toHaveLength(100);
    expect(result.truncated).toBe(false);
    expect(result.excludedMatches).toEqual([{ mailbox: 'Trash', count: 1 }]);
  });
});

describe('quoted display names', () => {
  it('keeps parentheses in a quoted display name and still drops a comment', async () => {
    const formatted = formatAddress({ name: 'Bob (work)', address: 'bob@example.com' });
    expect(formatted).toBe('"Bob (work)" <bob@example.com>');
    expect(parseAddress(formatted)).toEqual({ name: 'Bob (work)', address: 'bob@example.com' });
    expect(formatAddress({ name: 'Ada Lovelace', address: 'ada@example.com' })).toBe(
      'Ada Lovelace <ada@example.com>',
    );
    const comment = parseAddressList('bob@example.com (Eve <eve@evil.test>)');
    expect(comment).toEqual([{ address: 'bob@example.com' }]);

    const session = new FakeSession(['IMAP4rev1']);
    const sent: Buffer[] = [];
    const service = serviceFor(session, capturingSmtp(sent));
    await service.send({
      to: [{ name: 'Bob (work)', address: 'bob@example.com' }],
      subject: 'Hi',
      text: 'body',
    });
    const wire = sent[0]?.toString('utf8') ?? '';
    expect(wire).toContain('Bob (work)');
    expect(wire).not.toMatch(/eve@evil.test/);
    const to = wire.split(/\r?\n/).find((line) => line.toLowerCase().startsWith('to:'));
    expect(to).toBeDefined();
    expect(parseAddress(to?.slice(3) ?? '').name).toBe('Bob (work)');
  });
});
