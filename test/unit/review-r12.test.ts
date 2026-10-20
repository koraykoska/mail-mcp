import { describe, expect, it } from 'vitest';
import { routingHeaderDenied } from '../../src/mime/outbound-headers.js';
import { MailService } from '../../src/service/mail-service.js';
import type { SmtpSender } from '../../src/smtp/client.js';
import { createLogger } from '../../src/log.js';
import { simpleMessage } from '../fixtures/messages.js';
import { appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';

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

function messageIdsOf(result: Record<string, unknown>): string[] {
  return (result.items as Array<{ messageId: string | null }>)
    .map((item) => item.messageId ?? '')
    .sort();
}

describe('excludedMatches follows out-of-scope ids', () => {
  it('counts a later folder that cites only the excluded child for both seeds', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    session.ensure('Projects');
    const service = serviceFor(session);
    const parent = await session.append(
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
    await session.append(
      'Projects',
      simpleMessage({
        subject: 'Later',
        messageId: '<later@ex>',
        inReplyTo: '<child@ex>',
        references: '<child@ex>',
        text: 'later',
        date: 'Wed, 03 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const byId = await service.getThread({ messageId: '<child@ex>' });
    const byUid = await service.getThread({ mailbox: 'INBOX', uid: parent.uid });
    const expected = [
      { mailbox: 'Projects', count: 1 },
      { mailbox: 'Trash', count: 1 },
    ];
    expect(messageIdsOf(byId)).toEqual(['<parent@ex>']);
    expect(messageIdsOf(byUid)).toEqual(['<parent@ex>']);
    expect(byId.threadKey).toBe(byUid.threadKey);
    expect(byId.excludedMatches).toEqual(expected);
    expect(byUid.excludedMatches).toEqual(expected);
  });

  it('counts a second out-of-scope hop for both seeds', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    session.ensure('Side');
    session.ensure('Projects');
    const service = serviceFor(session);
    const parent = await session.append(
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
    await session.append(
      'Side',
      simpleMessage({
        subject: 'Mid',
        messageId: '<mid@ex>',
        inReplyTo: '<child@ex>',
        references: '<child@ex>',
        text: 'mid',
        date: 'Wed, 03 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Projects',
      simpleMessage({
        subject: 'Later',
        messageId: '<later@ex>',
        inReplyTo: '<mid@ex>',
        references: '<mid@ex>',
        text: 'later',
        date: 'Thu, 04 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const byId = await service.getThread({ messageId: '<child@ex>' });
    const byUid = await service.getThread({ mailbox: 'INBOX', uid: parent.uid });
    const expected = [
      { mailbox: 'Projects', count: 1 },
      { mailbox: 'Side', count: 1 },
      { mailbox: 'Trash', count: 1 },
    ];
    expect(messageIdsOf(byId)).toEqual(['<parent@ex>']);
    expect(messageIdsOf(byUid)).toEqual(['<parent@ex>']);
    expect(byId.threadKey).toBe(byUid.threadKey);
    expect(byId.excludedMatches).toEqual(expected);
    expect(byUid.excludedMatches).toEqual(expected);
  });
});

describe('three out-of-scope hops', () => {
  async function chain(): Promise<{
    service: MailService;
    parentUid: number;
  }> {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    session.ensure('Hop1');
    session.ensure('Hop2');
    session.ensure('Hop3');
    const service = serviceFor(session);
    const parent = await session.append(
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
    await session.append(
      'Hop1',
      simpleMessage({
        subject: 'Hop 1',
        messageId: '<h1@ex>',
        inReplyTo: '<child@ex>',
        references: '<child@ex>',
        text: 'hop1',
        date: 'Wed, 03 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Hop2',
      simpleMessage({
        subject: 'Hop 2',
        messageId: '<h2@ex>',
        inReplyTo: '<h1@ex>',
        references: '<h1@ex>',
        text: 'hop2',
        date: 'Thu, 04 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Hop3',
      simpleMessage({
        subject: 'Hop 3',
        messageId: '<h3@ex>',
        inReplyTo: '<h2@ex>',
        references: '<h2@ex>',
        text: 'hop3',
        date: 'Fri, 05 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'INBOX',
      simpleMessage({
        subject: 'Grandchild',
        messageId: '<grand@ex>',
        inReplyTo: '<h3@ex>',
        references: '<h3@ex>',
        text: 'grand',
        date: 'Sat, 06 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    return { service, parentUid: parent.uid ?? 0 };
  }

  const expected = [
    { mailbox: 'Hop1', count: 1 },
    { mailbox: 'Hop2', count: 1 },
    { mailbox: 'Hop3', count: 1 },
    { mailbox: 'Trash', count: 1 },
  ];

  it('lists every intermediate folder for the parent uid and the Trash Message-ID', async () => {
    const { service, parentUid } = await chain();
    const byUid = await service.getThread({
      mailbox: 'INBOX',
      uid: parentUid,
      maxRounds: 8,
    });
    const byId = await service.getThread({ messageId: '<child@ex>', maxRounds: 8 });
    expect(messageIdsOf(byUid)).toEqual(['<grand@ex>', '<parent@ex>']);
    expect(messageIdsOf(byId)).toEqual(['<grand@ex>', '<parent@ex>']);
    expect(byUid.threadKey).toBe(byId.threadKey);
    expect(byUid.truncated).toBe(false);
    expect(byId.truncated).toBe(false);
    expect(byUid.excludedMatches).toEqual(expected);
    expect(byId.excludedMatches).toEqual(expected);
  });

  it('reaches the grandchild from both seeds inside the default round budget', async () => {
    const { service, parentUid } = await chain();
    const byUid = await service.getThread({ mailbox: 'INBOX', uid: parentUid });
    const byId = await service.getThread({ messageId: '<child@ex>' });
    expect(messageIdsOf(byUid)).toEqual(['<grand@ex>', '<parent@ex>']);
    expect(messageIdsOf(byId)).toEqual(['<grand@ex>', '<parent@ex>']);
    expect(byUid.truncated).toBe(byId.truncated);
    expect(byUid.truncated).toBe(false);
    expect(byUid.excludedMatches).toEqual(expected);
    expect(byId.excludedMatches).toEqual(expected);
  });
});

describe('digits inside an X- token', () => {
  const denied = [
    'X-From2-Not',
    'X-Fr0m',
    'X-Envel0pe',
    'X-B0unce',
    'X-From2',
    'X-Envelope2',
    'X-Original-From2',
  ];
  const allowed = [
    'X-Sender-IP',
    'X-Sender-IP2',
    'X-Notification',
    'X-Notification2',
    'X-Photo',
    'X-Original-Arrival-Time',
    'X-GitHub-Notification',
    'X-Entity',
    'X-Mailer',
    'X-Priority',
    'X-Campaign',
    'X-Auto-Response-Suppress',
    'X-Feedback-ID',
    'X-Originating-IP',
    'X-Spam-Status',
    'X-Loop',
    'X-BeenThere',
    'X-Request-Id',
  ];

  it('rejects embedded digits and keeps the documented allow list', async () => {
    expect(denied.every((name) => routingHeaderDenied(name))).toBe(true);
    expect(allowed.every((name) => routingHeaderDenied(name))).toBe(false);
    expect(routingHeaderDenied('X-2')).toBe(true);
    expect(routingHeaderDenied('X-Photo-2')).toBe(false);

    const session = new FakeSession(['IMAP4rev1']);
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
  });
});
