import { describe, expect, it } from 'vitest';
import { MailError, mapMailboxOpenError } from '../../src/errors.js';
import { mailboxSelectable, parseFolderRequest, resolveFolderPaths } from '../../src/folders.js';
import { buildRawMessage } from '../../src/mime/build.js';
import { stripBcc } from '../../src/mime/transfer.js';
import { MailService } from '../../src/service/mail-service.js';
import { TOOLS } from '../../src/tools/catalog.js';
import { createLogger } from '../../src/log.js';
import { createRuntime } from '../../src/runtime.js';
import { simpleMessage } from '../fixtures/messages.js';
import { appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';
import { ScriptedImap } from '../support/scripted-imap.js';
import type { SmtpSender } from '../../src/smtp/client.js';

const special = {
  inbox: 'INBOX',
  sent: 'Sent',
  trash: 'Trash',
  junk: 'Junk',
  archive: 'Archive',
  all: 'All',
  sources: {},
};

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

describe('unselectable mailboxes', () => {
  const listed = [
    { path: 'INBOX', specialUse: '\\Inbox', flags: [] },
    { path: 'Nest', flags: ['\\Noselect', '\\NonExistent', '\\HasChildren'] },
    { path: 'Nest/leaf', flags: ['\\HasNoChildren'] },
    { path: 'Sent', specialUse: '\\Sent', flags: ['\\Sent'] },
  ];

  it('skips Noselect and NonExistent paths and rejects an explicit one', () => {
    expect(mailboxSelectable(listed[1] ?? { flags: [] })).toBe(false);
    const all = resolveFolderPaths(listed, special, parseFolderRequest({ all: true }));
    expect(all.paths).not.toContain('Nest');
    expect(all.paths).toContain('Nest/leaf');
    const glob = resolveFolderPaths(listed, special, parseFolderRequest('Nest/*'));
    expect(glob.paths).toEqual(['Nest/leaf']);
    expect(() => resolveFolderPaths(listed, special, parseFolderRequest('Nest'))).toThrow(
      MailError,
    );
    expect(() => resolveFolderPaths(listed, special, parseFolderRequest('Nest'))).toThrow(
      /MAILBOX_NOT_SELECTABLE|cannot be selected/,
    );
  });

  it('does not turn a hierarchy parent into a missing message', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    const parent = session.ensure('Nest');
    parent.flags = ['\\Noselect', '\\NonExistent', '\\HasChildren'];
    session.ensure('Nest/leaf');
    const messageId = '<leaf@ex>';
    await session.append(
      'Nest/leaf',
      simpleMessage({ subject: 'Leaf', messageId, text: 'leaf' }),
      [],
    );
    const service = serviceFor(session);
    const listed = await service.listMessages({
      folders: { all: true },
      limit: 10,
      includeSnippet: false,
    });
    expect(
      (listed.messages as Array<{ mailbox: string; subject: string | null }>).some(
        (item) => item.mailbox === 'Nest/leaf' && item.subject === 'Leaf',
      ),
    ).toBe(true);
    const byId = await service.getThread({ messageId });
    expect(
      (byId.items as Array<{ mailbox: string }>).some((item) => item.mailbox === 'Nest/leaf'),
    ).toBe(true);
    const scoped = await service.getThread({ messageId, folders: ['Nest/leaf'] });
    expect(scoped.ok).toBe(true);
    await expect(service.listMessages({ mailbox: 'Nest', limit: 5 })).rejects.toMatchObject({
      code: 'MAILBOX_NOT_SELECTABLE',
    });
    await expect(service.getThread({ messageId, folders: ['Nest'] })).rejects.toMatchObject({
      code: 'MAILBOX_NOT_SELECTABLE',
    });
    await expect(
      service.searchMessages({ folders: { all: true }, search: { all: true } }),
    ).resolves.toMatchObject({
      ok: true,
    });
  });

  it('maps a SELECT NO on a listed mailbox to MAILBOX_NOT_SELECTABLE', () => {
    const error = Object.assign(new Error('Command failed'), {
      responseStatus: 'NO',
      responseText: "Mailbox doesn't exist.",
      mailboxMissing: false,
    });
    expect(mapMailboxOpenError('Nest', error)).toMatchObject({
      code: 'MAILBOX_NOT_SELECTABLE',
    });
    const missing = Object.assign(new Error('Command failed'), {
      responseStatus: 'NO',
      responseText: "Mailbox doesn't exist.",
      mailboxMissing: true,
    });
    expect(mapMailboxOpenError('Gone', missing).code).toBe('NOT_FOUND');
  });
});

describe('list_threads References header', () => {
  it('links a reply whose ENVELOPE has no In-Reply-To', async () => {
    const server = new ScriptedImap({ capabilities: ['IMAP4rev1', 'UIDPLUS'] });
    await server.ready();
    server.addMessage(
      simpleMessage({ subject: 'Root', messageId: '<root@ex>', text: 'root' }).toString('utf8'),
      [],
    );
    server.addMessage(
      simpleMessage({
        subject: 'Re: Root',
        messageId: '<reply@ex>',
        inReplyTo: '<root@ex>',
        text: 'reply',
      }).toString('utf8'),
      [],
    );
    server.addMessage(
      simpleMessage({
        subject: 'Re: Root',
        messageId: '<follow@ex>',
        references: '<root@ex> <reply@ex>',
        text: 'follow',
      }).toString('utf8'),
      [],
    );
    const runtime = createRuntime({
      config: appConfig({
        appendSent: false,
        imap: {
          host: '127.0.0.1',
          port: server.port,
          secure: false,
          starttls: 'disabled',
          timeoutMs: 4_000,
          tls: { rejectUnauthorized: false },
        },
      }),
      logger: createLogger({ level: 'silent' }),
    });
    const listed = await runtime.service.listThreads({ mailbox: 'INBOX', limit: 10 });
    const items = listed.items as Array<{ messageCount: number; threadKey: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.messageCount).toBe(3);
    const thread = await runtime.service.getThread({ messageId: '<root@ex>' });
    expect(thread.threadKey).toBe(items[0]?.threadKey);
    expect(thread.items as unknown[]).toHaveLength(3);
    expect(server.trace.some((line) => line.includes('HEADER.FIELDS'))).toBe(true);
    expect(server.trace.some((line) => line.includes('REFERENCES'))).toBe(true);
    await runtime.close();
    await server.close();
  });
});

describe('outbound header allow-list', () => {
  it('rejects canonicalized and non-token names and does not drop a matching From', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    const sent: Buffer[] = [];
    const service = serviceFor(session, {}, capturingSmtp(sent));
    const blocked = [
      ' Reply-To',
      'Reply-To:',
      'Reply-To\t',
      `Reply-To${'\u00a0'}`,
      'Sender ',
      'Cc ',
      'Bcc ',
      'From',
      'From ',
      'To ',
      'Resent-From',
      'Resent-Sender',
      'Resent-To',
      'Resent-Cc',
      'Resent-Bcc',
      'Resent-Reply-To',
      'Resent-Date',
      'Resent-Message-ID',
      'Disposition-Notification-To',
      'Return-Receipt-To',
      'Mail-Reply-To',
      'Mail-Followup-To',
      'Errors-To',
      'Apparently-From',
      'Return-Path',
      'Message-ID',
      'To',
      'Foo(',
    ];
    for (const name of blocked) {
      await expect(
        service.send({
          to: ['ada@example.com'],
          subject: 'Hi',
          text: 'body',
          headers: { [name]: name === 'From' ? 'user@example.com' : 'Eve <eve@evil.test>' },
        }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    expect(sent).toHaveLength(0);
    const denied = await service
      .send({
        to: ['ada@example.com'],
        subject: 'Hi',
        text: 'body',
        headers: { From: 'user@example.com' },
      })
      .catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(MailError);
    expect(String((denied as MailError).message) + String((denied as MailError).hint)).toMatch(
      /from|replyTo|to|cc|bcc/i,
    );
  });

  it('sends X-* and List-Unsubscribe, and emits Reply-To without an embedded address', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    const sent: Buffer[] = [];
    const service = serviceFor(session, {}, capturingSmtp(sent));
    await service.send({
      to: ['ada@example.com'],
      subject: 'Hi',
      text: 'body',
      headers: {
        'X-Entity': '42',
        'List-Unsubscribe': '<mailto:user@example.com>',
      },
      replyTo: ['"Eve <eve@evil.test>" <user@example.com>'],
    });
    const wire = sent[0]?.toString('utf8') ?? '';
    expect(wire).toMatch(/X-Entity:\s*42/i);
    expect(wire).toMatch(/List-Unsubscribe:/i);
    expect(wire).toMatch(/Reply-To:\s*user@example.com/i);
    expect(wire).not.toMatch(/eve@evil.test/);
    await service.send({
      to: ['ada@example.com'],
      subject: 'Encoded',
      text: 'body',
      replyTo: ['"=?utf-8?Q?Eve_=3Ceve=40evil.test=3E?=" <user@example.com>'],
    });
    expect(sent[1]?.toString('utf8') ?? '').not.toMatch(/eve@evil.test/);
  });

  it('strips Resent-Bcc as well as Bcc', () => {
    const raw = Buffer.from('From: a@b\r\nBcc: hidden@ex\r\nResent-Bcc: also@ex\r\n\r\nbody');
    const text = stripBcc(raw).toString('utf8');
    expect(text).not.toMatch(/bcc/i);
    expect(text).toContain('From: a@b');
    expect(text).toContain('body');
  });
});

describe('mail_send_draft stored headers', () => {
  it('refuses a stored Reply-To, Resent-From, and receipt header that are not identities', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Drafts', '\\Drafts');
    const sent: Buffer[] = [];
    const service = serviceFor(session, {}, capturingSmtp(sent));
    const evil = await session.append(
      'Drafts',
      draft([
        'From: User <user@example.com>',
        'To: Ada <ada@example.com>',
        'Reply-To: Eve <eve@evil.test>',
        'Sender: eve@evil.test',
        'Resent-From: Eve <eve@evil.test>',
        'Resent-Reply-To: eve@evil.test',
        'Disposition-Notification-To: eve@evil.test',
        'Subject: Draft',
        'Date: Tue, 01 Jan 2026 00:00:00 +0000',
        'Message-ID: <draft@ex>',
      ]),
      ['\\Draft'],
    );
    await expect(
      service.sendDraft({ mailbox: 'Drafts', uid: evil.uid ?? 0 }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(sent).toHaveLength(0);
  });

  it('applies the identity replyTo, recipient domains, and the rate limit', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Drafts', '\\Drafts');
    const sent: Buffer[] = [];
    const service = serviceFor(
      session,
      {
        identities: [
          {
            id: 'default',
            email: 'user@example.com',
            name: 'User',
            default: true,
            replyTo: 'user@example.com',
          },
        ],
        recipientDomainAllowList: ['example.com'],
        sendRateLimit: { max: 1, windowMs: 60_000 },
      },
      capturingSmtp(sent),
    );
    const outside = await session.append(
      'Drafts',
      draft([
        'From: User <user@example.com>',
        'To: Ada <ada@evil.test>',
        'Subject: No',
        'Date: Tue, 01 Jan 2026 00:00:00 +0000',
        'Message-ID: <out@ex>',
      ]),
      ['\\Draft'],
    );
    await expect(
      service.sendDraft({ mailbox: 'Drafts', uid: outside.uid ?? 0 }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const clean = await session.append(
      'Drafts',
      draft([
        'From: User <user@example.com>',
        'To: Ada <ada@example.com>',
        'Subject: Yes',
        'Date: Tue, 01 Jan 2026 00:00:00 +0000',
        'Message-ID: <yes@ex>',
      ]),
      ['\\Draft'],
    );
    const resent = await session.append(
      'Drafts',
      draft([
        'From: User <user@example.com>',
        'To: Ada <ada@example.com>',
        'Resent-Bcc: user@example.com',
        'Subject: Bcc',
        'Date: Tue, 01 Jan 2026 00:00:00 +0000',
        'Message-ID: <bcc@ex>',
      ]),
      ['\\Draft'],
    );
    await service.sendDraft({ mailbox: 'Drafts', uid: clean.uid ?? 0 });
    expect(sent[0]?.toString('utf8')).toMatch(/Reply-To:\s*user@example.com/i);
    await expect(
      service.sendDraft({ mailbox: 'Drafts', uid: resent.uid ?? 0 }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(sent).toHaveLength(1);
    const stripped = stripBcc(
      draft(['From: User <user@example.com>', 'Resent-Bcc: hidden@evil.test', 'Subject: x', '']),
    ).toString('utf8');
    expect(stripped).not.toMatch(/Resent-Bcc/i);
  });
});

describe('mail_get_thread cursors', () => {
  it('keeps a child after the linking parent is expunged and rejects a new UIDVALIDITY', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    const box = session.ensure('INBOX');
    const service = serviceFor(session, { allowDelete: true, allowPermanentDelete: true });
    const root = await session.append(
      'INBOX',
      simpleMessage({
        subject: 'A',
        messageId: '<a@ex>',
        text: 'a',
        date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const mid = await session.append(
      'INBOX',
      simpleMessage({
        subject: 'B',
        messageId: '<b@ex>',
        inReplyTo: '<a@ex>',
        references: '<a@ex>',
        text: 'b',
        date: 'Tue, 02 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const child = await session.append(
      'INBOX',
      simpleMessage({
        subject: 'C',
        messageId: '<c@ex>',
        inReplyTo: '<b@ex>',
        references: '<b@ex>',
        text: 'c',
        date: 'Wed, 03 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const first = await service.getThread({
      mailbox: 'INBOX',
      uid: root.uid,
      limit: 1,
      order: 'oldest-first',
    });
    expect((first.items as Array<{ uid: number }>)[0]?.uid).toBe(root.uid);
    box.messages = box.messages.filter((item) => item.uid !== mid.uid);
    const second = await service.getThread({
      mailbox: 'INBOX',
      uid: root.uid,
      limit: 1,
      order: 'oldest-first',
      cursor: String(first.nextCursor),
    });
    const uids = (second.items as Array<{ uid: number; threadKey: string }>).map(
      (item) => item.uid,
    );
    expect(uids).toContain(child.uid);
    expect((second.items as Array<{ threadKey: string }>)[0]?.threadKey).toBe(first.threadKey);
    box.uidValidity = '999';
    await expect(
      service.getThread({
        mailbox: 'INBOX',
        uid: root.uid,
        limit: 1,
        order: 'oldest-first',
        cursor: String(first.nextCursor),
      }),
    ).rejects.toMatchObject({ code: 'CURSOR_INVALIDATED' });
  });
});

describe('uid seed thread scope', () => {
  it('finds the INBOX parent when the seed is the Sent reply', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Sent', '\\Sent');
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
    const reply = await session.append(
      'Sent',
      simpleMessage({
        subject: 'Re: Root',
        messageId: '<reply@ex>',
        inReplyTo: '<root@ex>',
        references: '<root@ex>',
        text: 'reply',
        date: 'Tue, 02 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const byId = await service.getThread({ messageId: '<root@ex>' });
    const byUid = await service.getThread({ mailbox: 'Sent', uid: reply.uid });
    expect(byUid.threadKey).toBe(byId.threadKey);
    const boxes = new Set((byUid.items as Array<{ mailbox: string }>).map((item) => item.mailbox));
    expect(boxes.has('INBOX')).toBe(true);
    expect(boxes.has('Sent')).toBe(true);
  });
});

describe('single-folder SORT cap', () => {
  it('truncates a server SORT at maxSortCandidates and refuses a bulk run', async () => {
    const session = new FakeSession();
    const box = session.ensure('INBOX');
    for (const uid of [1, 2, 3, 4, 5, 6]) {
      box.messages.push({
        uid,
        raw: Buffer.from(`Subject: m${uid}\r\n\r\nm${uid}`),
        flags: [],
        internalDate: `2026-01-0${uid}T00:00:00.000Z`,
        subject: `m${uid}`,
        size: 10,
      });
    }
    box.uidNext = 7;
    const service = serviceFor(session, {
      limits: { ...appConfig().limits, maxSortCandidates: 2 },
    });
    const listed = await service.listMessages({
      mailbox: 'INBOX',
      limit: 10,
      includeSnippet: false,
    });
    expect(listed.truncated).toBe(true);
    expect((listed.messages as Array<{ uid: number }>).map((item) => item.uid)).toEqual([6, 5]);
    const folder = (
      listed.snapshot as {
        folders: Array<{ omitted: number; scanned: number; truncated: boolean }>;
      }
    ).folders[0];
    expect(folder?.truncated).toBe(true);
    expect(folder?.scanned).toBe(2);
    expect(folder?.omitted).toBe(4);
    await expect(
      service.modifyBySearch({
        mailbox: 'INBOX',
        search: { all: true },
        action: 'addFlags',
        flags: ['\\Seen'],
        dryRun: false,
      }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    expect(box.messages.every((item) => !item.flags.includes('\\Seen'))).toBe(true);
  });
});

describe('tool descriptions', () => {
  it('matches replyTo, draft, and header allow-list behavior', () => {
    const text = (name: string): string =>
      TOOLS.find((tool) => tool.name === name)?.description ?? '';
    expect(text('mail_reply_message')).toMatch(/identity replyTo/);
    expect(text('mail_reply_message')).not.toMatch(/leave it unset/);
    expect(text('mail_send_draft')).toMatch(/parsed on every send/);
    expect(text('mail_send_draft')).toMatch(/identity replyTo/);
    expect(text('mail_send_message')).toMatch(/allow-list/);
    expect(text('mail_send_message')).toMatch(/replyTo/);
    expect(text('mail_get_thread')).toMatch(/INBOX/);
    expect(text('mail_get_thread')).toMatch(/CURSOR_INVALIDATED/);
    expect(text('mail_list_threads')).toMatch(/References/);
  });
});

describe('build still accepts a structured replyTo', () => {
  it('formats the parsed reply address', async () => {
    const raw = await buildRawMessage({
      from: { address: 'user@example.com' },
      to: [{ address: 'ada@example.com' }],
      replyTo: [{ address: 'user@example.com' }],
      subject: 'Hi',
      text: 'body',
    });
    expect(raw.toString('utf8')).toMatch(/Reply-To:\s*user@example.com/i);
  });
});
