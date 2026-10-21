import { describe, expect, it } from 'vitest';
import { routingHeaderDenied } from '../../src/mime/outbound-headers.js';
import { decodeSnapshotCursor } from '../../src/page/snapshot.js';
import { MailService } from '../../src/service/mail-service.js';
import type { SmtpSender } from '../../src/smtp/client.js';
import { threadSearchCap } from '../../src/thread/walk.js';
import { createLogger } from '../../src/log.js';
import { simpleMessage } from '../fixtures/messages.js';
import { appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';

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

function withThrid(message: Buffer, threadId: string): Buffer {
  return Buffer.from(
    message.toString('utf8').replace('\r\n\r\n', `\r\nX-GM-THRID: ${threadId}\r\n\r\n`),
  );
}

describe('later pages reuse excludedMatches', () => {
  it('keeps Side, Side2, and Trash on page 2 for both seeds', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    session.ensure('Side');
    session.ensure('Side2');
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
      'INBOX',
      simpleMessage({
        subject: 'Sibling',
        messageId: '<sib@ex>',
        inReplyTo: '<parent@ex>',
        references: '<parent@ex>',
        text: 'sibling',
        date: 'Tue, 02 Jan 2026 00:00:00 +0000',
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
        date: 'Wed, 03 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Side',
      simpleMessage({
        subject: 'Side',
        messageId: '<side@ex>',
        inReplyTo: '<child@ex>',
        references: '<child@ex>',
        text: 'side',
        date: 'Thu, 04 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Side2',
      simpleMessage({
        subject: 'Side 2',
        messageId: '<side2@ex>',
        inReplyTo: '<side@ex>',
        references: '<side@ex>',
        text: 'side2',
        date: 'Fri, 05 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const expected = [
      { mailbox: 'Side', count: 1 },
      { mailbox: 'Side2', count: 1 },
      { mailbox: 'Trash', count: 1 },
    ];
    const byUid = await service.getThread({ mailbox: 'INBOX', uid: parent.uid ?? 0, limit: 1 });
    const byId = await service.getThread({ messageId: '<child@ex>', limit: 1 });
    expect(typeof byUid.nextCursor).toBe('string');
    expect(typeof byId.nextCursor).toBe('string');
    const uidPage = await service.getThread({
      mailbox: 'INBOX',
      uid: parent.uid ?? 0,
      limit: 1,
      cursor: String(byUid.nextCursor),
    });
    const idPage = await service.getThread({
      messageId: '<child@ex>',
      limit: 1,
      cursor: String(byId.nextCursor),
    });
    expect(byUid.excludedMatches).toEqual(expected);
    expect(byId.excludedMatches).toEqual(expected);
    expect(uidPage.excludedMatches).toEqual(expected);
    expect(idPage.excludedMatches).toEqual(expected);
    expect(byUid.threadKey).toBe(byId.threadKey);
    expect(uidPage.threadKey).toBe(byUid.threadKey);
    expect(idPage.threadKey).toBe(byUid.threadKey);
    expect(byUid.truncated).toBe(false);
    expect(uidPage.truncated).toBe(false);
    expect(idPage.truncated).toBe(false);
    const stored = decodeSnapshotCursor(String(byUid.nextCursor));
    expect(stored.excluded).toEqual(expected);
    expect(stored.keys?.every((key) => key.includes('\0'))).toBe(true);
  });

  it('keeps every hop on page 2 of a three-hop chain', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    session.ensure('Hop1');
    session.ensure('Hop2');
    session.ensure('Hop3');
    const service = serviceFor(session);
    const parent = await session.append(
      'INBOX',
      simpleMessage({
        messageId: '<parent@ex>',
        text: 'parent',
        date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Trash',
      simpleMessage({
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
        messageId: '<h1@ex>',
        inReplyTo: '<child@ex>',
        references: '<child@ex>',
        text: 'h1',
        date: 'Wed, 03 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Hop2',
      simpleMessage({
        messageId: '<h2@ex>',
        inReplyTo: '<h1@ex>',
        references: '<h1@ex>',
        text: 'h2',
        date: 'Thu, 04 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Hop3',
      simpleMessage({
        messageId: '<h3@ex>',
        inReplyTo: '<h2@ex>',
        references: '<h2@ex>',
        text: 'h3',
        date: 'Fri, 05 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'INBOX',
      simpleMessage({
        messageId: '<grand@ex>',
        inReplyTo: '<h3@ex>',
        references: '<h3@ex>',
        text: 'grand',
        date: 'Sat, 06 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const expected = [
      { mailbox: 'Hop1', count: 1 },
      { mailbox: 'Hop2', count: 1 },
      { mailbox: 'Hop3', count: 1 },
      { mailbox: 'Trash', count: 1 },
    ];
    const byUid = await service.getThread({ mailbox: 'INBOX', uid: parent.uid ?? 0, limit: 1 });
    const byId = await service.getThread({ messageId: '<child@ex>', limit: 1 });
    const uidPage = await service.getThread({
      mailbox: 'INBOX',
      uid: parent.uid ?? 0,
      limit: 1,
      cursor: String(byUid.nextCursor),
    });
    const idPage = await service.getThread({
      messageId: '<child@ex>',
      limit: 1,
      cursor: String(byId.nextCursor),
    });
    expect(byUid.excludedMatches).toEqual(expected);
    expect(uidPage.excludedMatches).toEqual(byUid.excludedMatches);
    expect(idPage.excludedMatches).toEqual(byId.excludedMatches);
    expect(byId.excludedMatches).toEqual(byUid.excludedMatches);
    expect(uidPage.truncated).toBe(false);
    expect(idPage.truncated).toBe(false);
  });
});

describe('search cap and message cap', () => {
  async function chain(hops: number): Promise<{ service: MailService; parentUid: number }> {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    for (let index = 1; index <= hops; index += 1) {
      session.ensure(`Hop${index}`);
    }
    const service = serviceFor(session);
    const parent = await session.append(
      'INBOX',
      simpleMessage({
        messageId: '<parent@ex>',
        text: 'parent',
        date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Trash',
      simpleMessage({
        messageId: '<child@ex>',
        inReplyTo: '<parent@ex>',
        references: '<parent@ex>',
        text: 'child',
        date: 'Tue, 02 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    let previous = '<child@ex>';
    for (let index = 1; index <= hops; index += 1) {
      const id = `<h${index}@ex>`;
      await session.append(
        `Hop${index}`,
        simpleMessage({
          messageId: id,
          inReplyTo: previous,
          references: previous,
          text: `h${index}`,
          date: `Wed, ${String(index).padStart(2, '0')} Jan 2026 00:00:00 +0000`,
        }),
        [],
      );
      previous = id;
    }
    await session.append(
      'INBOX',
      simpleMessage({
        messageId: '<grand@ex>',
        inReplyTo: previous,
        references: previous,
        text: 'grand',
        date: 'Thu, 01 Feb 2026 00:00:00 +0000',
      }),
      [],
    );
    return { service, parentUid: parent.uid ?? 0 };
  }

  async function expectSameClosure(hops: number, truncated: boolean): Promise<void> {
    const { service, parentUid } = await chain(hops);
    const byUid = await service.getThread({ mailbox: 'INBOX', uid: parentUid });
    const byId = await service.getThread({ messageId: '<child@ex>' });
    expect(byUid.truncated).toBe(truncated);
    expect(byId.truncated).toBe(truncated);
    expect(messageIdsOf(byUid)).toEqual(messageIdsOf(byId));
    expect(byUid.excludedMatches).toEqual(byId.excludedMatches);
    expect(byUid.threadKey).toBe(byId.threadKey);
    if (!truncated) {
      expect(messageIdsOf(byUid)).toEqual(['<grand@ex>', '<parent@ex>']);
      const folders = (byUid.excludedMatches as Array<{ mailbox: string }>).map(
        (item) => item.mailbox,
      );
      expect(folders).toContain(`Hop${hops}`);
      expect(folders).toContain('Trash');
    }
  }

  it('returns the same closure for a 6-hop and an 8-hop chain', async () => {
    await expectSameClosure(6, false);
    await expectSameClosure(8, false);
  });

  it('sets truncated on both seeds when the search cap stops the walk', async () => {
    const hops = threadSearchCap(1);
    const { service, parentUid } = await chain(hops);
    const byUid = await service.getThread({ mailbox: 'INBOX', uid: parentUid, maxRounds: 1 });
    const byId = await service.getThread({ messageId: '<child@ex>', maxRounds: 1 });
    expect(byUid.truncated).toBe(true);
    expect(byId.truncated).toBe(true);
  });

  it('still lists Trash when maxMessages keeps one of two replies', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    const service = serviceFor(session);
    await session.append(
      'Trash',
      simpleMessage({
        messageId: '<root@ex>',
        text: 'root',
        date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'INBOX',
      simpleMessage({
        messageId: '<a@ex>',
        inReplyTo: '<root@ex>',
        references: '<root@ex>',
        text: 'first',
        date: 'Tue, 02 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'INBOX',
      simpleMessage({
        messageId: '<b@ex>',
        inReplyTo: '<root@ex>',
        references: '<root@ex>',
        text: 'second',
        date: 'Wed, 03 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const result = await service.getThread({ messageId: '<root@ex>', maxMessages: 1 });
    expect(result.truncated).toBe(true);
    expect(messageIdsOf(result)).toEqual(['<a@ex>']);
    expect(result.excludedMatches).toEqual([{ mailbox: 'Trash', count: 1 }]);
  });

  it('still lists Trash when the 101st reply passes the default cap', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    const service = serviceFor(session);
    await session.append(
      'Trash',
      simpleMessage({
        messageId: '<root@ex>',
        text: 'root',
        date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    for (let index = 1; index <= 101; index += 1) {
      await session.append(
        'INBOX',
        simpleMessage({
          messageId: `<r${index}@ex>`,
          inReplyTo: '<root@ex>',
          references: '<root@ex>',
          text: `reply ${index}`,
          date: `Tue, 02 Jan 2026 00:${String(index).padStart(2, '0')}:00 +0000`,
        }),
        [],
      );
    }
    const result = await service.getThread({ messageId: '<root@ex>' });
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(100);
    expect(result.excludedMatches).toEqual([{ mailbox: 'Trash', count: 1 }]);
  });
});

describe('Gmail fast path closure', () => {
  it('counts a folder that cites only the Trash child, including on page 2', async () => {
    const session = new FakeSession(['IMAP4rev1', 'X-GM-EXT-1']);
    session.ensure('Trash', '\\Trash');
    session.ensure('Side');
    const service = serviceFor(session);
    const parent = await session.append(
      'INBOX',
      withThrid(
        simpleMessage({
          messageId: '<parent@ex>',
          text: 'parent',
          date: 'Mon, 01 Jan 2026 00:00:00 +0000',
        }),
        '99',
      ),
      [],
    );
    await session.append(
      'INBOX',
      withThrid(
        simpleMessage({
          messageId: '<sib@ex>',
          inReplyTo: '<parent@ex>',
          references: '<parent@ex>',
          text: 'sibling',
          date: 'Tue, 02 Jan 2026 00:00:00 +0000',
        }),
        '99',
      ),
      [],
    );
    await session.append(
      'Trash',
      simpleMessage({
        messageId: '<child@ex>',
        inReplyTo: '<parent@ex>',
        references: '<parent@ex>',
        text: 'child',
        date: 'Wed, 03 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Side',
      simpleMessage({
        messageId: '<side@ex>',
        inReplyTo: '<child@ex>',
        references: '<child@ex>',
        text: 'side',
        date: 'Thu, 04 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const expected = [
      { mailbox: 'Side', count: 1 },
      { mailbox: 'Trash', count: 1 },
    ];
    const first = await service.getThread({ mailbox: 'INBOX', uid: parent.uid ?? 0, limit: 1 });
    const linked = (first.items as Array<{ linked: string }>).map((item) => item.linked);
    expect(linked).toContain('gmail-thrid');
    const second = await service.getThread({
      mailbox: 'INBOX',
      uid: parent.uid ?? 0,
      limit: 1,
      cursor: String(first.nextCursor),
    });
    expect(first.excludedMatches).toEqual(expected);
    expect(second.excludedMatches).toEqual(expected);
    expect(second.truncated).toBe(false);
    expect(second.threadKey).toBe(first.threadKey);
  });
});

describe('look-alike digits in X- names', () => {
  const denied = [
    'X-From0',
    'X-To0',
    'X-Cc0',
    'X-Bcc0',
    'X-Sender0',
    'X-Recipient0',
    'X-From0-Not',
    'X-Enve1ope',
    'X-Bounc3',
    'X-3nv3l0p3',
    'X-B0unc3',
  ];
  const allowed = [
    'X-Sender-IP',
    'X-Sender-IP2',
    'X-Notification',
    'X-Notification2',
    'X-Photo',
    'X-Photo2',
    'X-Mailer',
    'X-Priority',
    'X-MSMail-Priority',
    'X-MimeOLE',
    'X-Auto-Response-Suppress',
    'X-Feedback-ID',
    'X-Entity-Ref-ID',
    'X-Originating-IP',
    'X-Forwarded-For',
    'X-Spam-Status',
    'X-Loop',
    'X-BeenThere',
    'X-Request-Id',
    'X-SMTPAPI',
    'X-Mailgun-Tag',
    'X-SES-CONFIGURATION-SET',
    'X-PM-Message-Stream',
    'X-MC-Tags',
    'X-Apple-Mail',
    'X-Mozilla-Status2',
    'X-Authenticated-User',
    'X-Original-Arrival-Time',
    'X-GitHub-Notification',
    'X-Forefront-Antispam-Report',
    'X-Microsoft-Antispam',
    'X-Original-Authentication-Results',
    'X-Google-Original-Message-ID',
  ];

  it('rejects the listed spellings and keeps the allow list', async () => {
    expect(denied.every((name) => routingHeaderDenied(name))).toBe(true);
    expect(allowed.every((name) => routingHeaderDenied(name))).toBe(false);
    const session = new FakeSession(['IMAP4rev1']);
    const sent: Buffer[] = [];
    const service = serviceFor(session, {
      verify: async () => undefined,
      send: async (input) => {
        sent.push(input.raw);
        return { accepted: ['ada@example.com'], rejected: [], pending: [], response: '250' };
      },
      close() {
        return undefined;
      },
    });
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
    await service.send({
      to: ['ada@example.com'],
      subject: 'Hi',
      text: 'body',
      headers: Object.fromEntries(allowed.map((name) => [name, `ok-${name}`])),
    });
    const wire = sent[0]?.toString('utf8') ?? '';
    for (const name of allowed) {
      expect(wire.toLowerCase()).toContain(`${name.toLowerCase()}:`);
    }
  });
});
