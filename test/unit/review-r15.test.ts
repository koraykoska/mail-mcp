import { describe, expect, it } from 'vitest';
import { decodeSnapshotCursor, MAX_EXCLUDED_FOLDERS } from '../../src/page/snapshot.js';
import { MailService } from '../../src/service/mail-service.js';
import { threadSearchCap } from '../../src/thread/walk.js';
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
  return (result.items as Array<{ messageId: string | null }>)
    .map((item) => item.messageId ?? '')
    .sort();
}

function withThrid(message: Buffer, threadId: string): Buffer {
  return Buffer.from(
    message.toString('utf8').replace('\r\n\r\n', `\r\nX-GM-THRID: ${threadId}\r\n\r\n`),
  );
}

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

describe('search cap is the same for both seeds', () => {
  it('gives maxRounds a higher ceiling than the default 32 searches', () => {
    expect(threadSearchCap(4)).toBe(32);
    expect(threadSearchCap(5)).toBe(40);
    expect(threadSearchCap(8)).toBe(64);
  });

  it('agrees at 30 hops, where the old head start split truncated', async () => {
    const { service, parentUid } = await chain(30);
    const byUid = await service.getThread({ mailbox: 'INBOX', uid: parentUid });
    const byId = await service.getThread({ messageId: '<child@ex>' });
    expect(byUid.truncated).toBe(true);
    expect(byId.truncated).toBe(byUid.truncated);
    expect(byId.rounds).toBe(byUid.rounds);
    expect(messageIdsOf(byUid)).toEqual(['<grand@ex>', '<parent@ex>']);
    expect(messageIdsOf(byId)).toEqual(messageIdsOf(byUid));
    expect(byUid.excludedMatches).toEqual(byId.excludedMatches);
    const folders = (byUid.excludedMatches as Array<{ mailbox: string }>).map(
      (item) => item.mailbox,
    );
    expect(folders).toContain('Hop30');
    expect(folders).toContain('Trash');
  });

  it('agrees at 31 hops, including the omitted grandchild', async () => {
    const { service, parentUid } = await chain(31);
    const byUid = await service.getThread({ mailbox: 'INBOX', uid: parentUid });
    const byId = await service.getThread({ messageId: '<child@ex>' });
    expect(byUid.truncated).toBe(true);
    expect(byId.truncated).toBe(true);
    expect(byId.rounds).toBe(byUid.rounds);
    expect(messageIdsOf(byUid)).toEqual(['<parent@ex>']);
    expect(messageIdsOf(byId)).toEqual(messageIdsOf(byUid));
    expect(byUid.excludedMatches).toEqual(byId.excludedMatches);
    const folders = (byUid.excludedMatches as Array<{ mailbox: string }>).map(
      (item) => item.mailbox,
    );
    expect(folders).toContain('Hop31');
    expect(folders).toContain('Trash');
    expect(folders).not.toContain('INBOX');
  });

  it('finishes a 30-hop chain when maxRounds raises the ceiling', async () => {
    const { service, parentUid } = await chain(30);
    const byUid = await service.getThread({ mailbox: 'INBOX', uid: parentUid, maxRounds: 5 });
    const byId = await service.getThread({ messageId: '<child@ex>', maxRounds: 5 });
    expect(byUid.truncated).toBe(false);
    expect(byId.truncated).toBe(false);
    expect(messageIdsOf(byUid)).toEqual(['<grand@ex>', '<parent@ex>']);
    expect(messageIdsOf(byId)).toEqual(messageIdsOf(byUid));
    expect(byUid.excludedMatches).toEqual(byId.excludedMatches);
    expect(byUid.rounds).toBe(byId.rounds);
  });
});

describe('fast path keeps ids maxMessages dropped', () => {
  async function capped(capabilities: string[], linked: string): Promise<void> {
    const session = new FakeSession(capabilities);
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
        inReplyTo: '<sib@ex>',
        references: '<sib@ex>',
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
    const result = await service.getThread({
      mailbox: 'INBOX',
      uid: parent.uid ?? 0,
      maxMessages: 1,
    });
    expect(result.truncated).toBe(true);
    expect(messageIdsOf(result)).toEqual(['<parent@ex>']);
    expect((result.items as Array<{ linked: string }>).map((item) => item.linked)).toContain(
      linked,
    );
    expect(result.excludedMatches).toEqual([
      { mailbox: 'Side', count: 1 },
      { mailbox: 'Trash', count: 1 },
    ]);
  }

  it('counts Side and Trash when X-GM-EXT-1 keeps one message', async () => {
    await capped(['IMAP4rev1', 'X-GM-EXT-1'], 'gmail-thrid');
  });

  it('counts Side and Trash when OBJECTID keeps one message', async () => {
    await capped(['IMAP4rev1', 'OBJECTID'], 'objectid');
  });
});

describe('excluded folder cursor cap', () => {
  it('pages a 501-folder closure without rejecting the cursor', async () => {
    const session = new FakeSession(['IMAP4rev1']);
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
      'INBOX',
      simpleMessage({
        messageId: '<reply@ex>',
        inReplyTo: '<parent@ex>',
        references: '<parent@ex>',
        text: 'reply',
        date: 'Wed, 03 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const folders = MAX_EXCLUDED_FOLDERS + 1;
    for (let index = 0; index < folders; index += 1) {
      const name = `F${String(index).padStart(4, '0')}`;
      session.ensure(name);
      await session.append(
        name,
        simpleMessage({
          messageId: `<f${index}@ex>`,
          inReplyTo: '<parent@ex>',
          references: '<parent@ex>',
          text: name,
          date: 'Tue, 02 Jan 2026 00:00:00 +0000',
        }),
        [],
      );
    }
    const first = await service.getThread({ mailbox: 'INBOX', uid: parent.uid ?? 0, limit: 1 });
    expect(first.excludedMatchesTruncated).toBe(true);
    expect(first.excludedMatches).toHaveLength(MAX_EXCLUDED_FOLDERS);
    const names = (first.excludedMatches as Array<{ mailbox: string }>).map((item) => item.mailbox);
    expect(names[0]).toBe('F0000');
    expect(names[names.length - 1]).toBe('F0499');
    expect(names).not.toContain('F0500');
    expect(typeof first.nextCursor).toBe('string');
    const second = await service.getThread({
      mailbox: 'INBOX',
      uid: parent.uid ?? 0,
      limit: 1,
      cursor: String(first.nextCursor),
    });
    expect(second.excludedMatches).toEqual(first.excludedMatches);
    expect(second.excludedMatchesTruncated).toBe(true);
    expect(second.truncated).toBe(first.truncated);
    expect(second.rounds).toBe(first.rounds);
    const stored = decodeSnapshotCursor(String(first.nextCursor));
    expect(stored.excluded).toHaveLength(MAX_EXCLUDED_FOLDERS);
    expect(stored.excludedTruncated).toBe(true);
  });
});
