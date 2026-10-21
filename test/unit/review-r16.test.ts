import { describe, expect, it } from 'vitest';
import { MailService } from '../../src/service/mail-service.js';
import { createLogger } from '../../src/log.js';
import { simpleMessage } from '../fixtures/messages.js';
import { appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';

function serviceFor(session: FakeSession): MailService {
  return new MailService({
    config: appConfig({ appendSent: false }),
    pool: new FakePool(session) as never,
    smtpFactory: async () => ({
      verify: async () => undefined,
      send: async () => ({ accepted: [], rejected: [], pending: [], response: '250' }),
      close() {
        return undefined;
      },
    }),
    logger: createLogger({ level: 'silent' }),
  });
}

function messageIdsOf(result: Record<string, unknown>): string[] {
  return (result.items as Array<{ messageId: string | null }>).map((item) => item.messageId ?? '');
}

function withThrid(message: Buffer, threadId: string): Buffer {
  return Buffer.from(
    message.toString('utf8').replace('\r\n\r\n', `\r\nX-GM-THRID: ${threadId}\r\n\r\n`),
  );
}

/**
 * Parent is appended first, so it is the earliest. Late lives in AAA, which
 * is scanned before INBOX. A cap that follows folder order would keep late.
 */
function stamp(session: FakeSession, mailbox: string, uid: number, iso: string): void {
  const message = session.boxes.get(mailbox)?.messages.find((item) => item.uid === uid);
  if (!message) {
    throw new Error(`missing ${mailbox} uid ${uid}`);
  }
  message.internalDate = iso;
}

async function openThread(capabilities: string[]): Promise<{
  service: MailService;
  parentUid: number;
}> {
  const session = new FakeSession(capabilities);
  session.ensure('AAA');
  session.ensure('Trash', '\\Trash');
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
  stamp(session, 'INBOX', parent.uid ?? 0, '2026-01-01T00:00:00.000Z');
  const mid = await session.append(
    'INBOX',
    withThrid(
      simpleMessage({
        messageId: '<mid@ex>',
        inReplyTo: '<parent@ex>',
        references: '<parent@ex>',
        text: 'mid',
        date: 'Tue, 02 Jan 2026 00:00:00 +0000',
      }),
      '99',
    ),
    [],
  );
  stamp(session, 'INBOX', mid.uid ?? 0, '2026-01-02T00:00:00.000Z');
  const late = await session.append(
    'AAA',
    withThrid(
      simpleMessage({
        messageId: '<late@ex>',
        inReplyTo: '<parent@ex>',
        references: '<parent@ex>',
        text: 'late',
        date: 'Wed, 03 Jan 2026 00:00:00 +0000',
      }),
      '99',
    ),
    [],
  );
  stamp(session, 'AAA', late.uid ?? 0, '2026-01-03T00:00:00.000Z');
  await session.append(
    'Trash',
    simpleMessage({
      messageId: '<child@ex>',
      inReplyTo: '<late@ex>',
      references: '<late@ex>',
      text: 'child',
      date: 'Thu, 04 Jan 2026 00:00:00 +0000',
    }),
    [],
  );
  return { service, parentUid: parent.uid ?? 0 };
}

async function threadAt(
  capabilities: string[],
  maxMessages: number,
): Promise<Record<string, unknown>> {
  const { service, parentUid } = await openThread(capabilities);
  return service.getThread({
    mailbox: 'INBOX',
    uid: parentUid,
    folders: ['AAA', 'INBOX'],
    maxMessages,
  });
}

describe('fast path keeps the earliest messages', () => {
  const paths: Array<{ capabilities: string[]; linked: string }> = [
    { capabilities: ['IMAP4rev1', 'X-GM-EXT-1'], linked: 'gmail-thrid' },
    { capabilities: ['IMAP4rev1', 'OBJECTID'], linked: 'objectid' },
  ];

  for (const { capabilities, linked } of paths) {
    it(`matches the header walk at cap 1 and cap 2 for ${linked}`, async () => {
      for (const maxMessages of [1, 2]) {
        const fast = await threadAt(capabilities, maxMessages);
        const header = await threadAt(['IMAP4rev1'], maxMessages);
        expect(fast.truncated).toBe(true);
        expect(header.truncated).toBe(true);
        expect(messageIdsOf(fast)).toEqual(messageIdsOf(header));
        expect(fast.excludedMatches).toEqual([{ mailbox: 'Trash', count: 1 }]);
        expect(header.excludedMatches).toEqual(fast.excludedMatches);
        expect(fast.threadKey).toBe(header.threadKey);
        const kinds = (fast.items as Array<{ linked: string }>).map((item) => item.linked);
        expect(kinds.every((kind) => kind === linked)).toBe(true);
        if (maxMessages === 1) {
          expect(messageIdsOf(fast)).toEqual(['<parent@ex>']);
        } else {
          expect(messageIdsOf(fast).sort()).toEqual(['<mid@ex>', '<parent@ex>']);
        }
      }
    });

    it(`reuses the capped set on page 2 for ${linked}`, async () => {
      const fastOpen = await openThread(capabilities);
      const headerOpen = await openThread(['IMAP4rev1']);
      const input = {
        mailbox: 'INBOX' as const,
        folders: ['AAA', 'INBOX'],
        maxMessages: 2,
        limit: 1,
      };
      const fastFirst = await fastOpen.service.getThread({ ...input, uid: fastOpen.parentUid });
      const headerFirst = await headerOpen.service.getThread({
        ...input,
        uid: headerOpen.parentUid,
      });
      const fastSecond = await fastOpen.service.getThread({
        ...input,
        uid: fastOpen.parentUid,
        cursor: String(fastFirst.nextCursor),
      });
      const headerSecond = await headerOpen.service.getThread({
        ...input,
        uid: headerOpen.parentUid,
        cursor: String(headerFirst.nextCursor),
      });
      expect(messageIdsOf(fastFirst)).toEqual(messageIdsOf(headerFirst));
      expect(messageIdsOf(fastSecond)).toEqual(messageIdsOf(headerSecond));
      expect([...messageIdsOf(fastFirst), ...messageIdsOf(fastSecond)].sort()).toEqual([
        '<mid@ex>',
        '<parent@ex>',
      ]);
      expect(fastSecond.truncated).toBe(true);
      expect(fastSecond.truncated).toBe(fastFirst.truncated);
      expect(fastSecond.rounds).toBe(fastFirst.rounds);
      expect(fastSecond.excludedMatches).toEqual(fastFirst.excludedMatches);
      expect(fastSecond.excludedMatches).toEqual(headerSecond.excludedMatches);
      expect(fastSecond.threadKey).toBe(fastFirst.threadKey);
    });
  }
});
