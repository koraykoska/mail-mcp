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
