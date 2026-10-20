import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import { buildRawMessage } from '../../src/mime/build.js';
import { threadMessages } from '../../src/mime/thread.js';
import { conversationThreadKey } from '../../src/thread/walk.js';
import { MailService } from '../../src/service/mail-service.js';
import { toolsForService } from '../../src/tools/register.js';
import { TOOLS } from '../../src/tools/catalog.js';
import { createLogger } from '../../src/log.js';
import { createRuntime } from '../../src/runtime.js';
import { simpleMessage } from '../fixtures/messages.js';
import { appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';
import { ScriptedImap } from '../support/scripted-imap.js';
import type { BodyNode } from '../../src/imap/session.js';
import type { SmtpSender } from '../../src/smtp/client.js';

function serviceFor(
  session: FakeSession,
  overrides: Parameters<typeof appConfig>[0] = {},
  smtp?: SmtpSender,
): MailService {
  return new MailService({
    config: appConfig(overrides),
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

function attachmentTree(): BodyNode {
  const part = (partId: string, filename: string): BodyNode => ({
    part: partId,
    type: 'application',
    subtype: 'pdf',
    parameters: {},
    disposition: 'attachment',
    dispositionParameters: { filename },
    children: [],
  });
  return {
    type: 'multipart',
    subtype: 'mixed',
    parameters: {},
    dispositionParameters: {},
    children: [part('1', 'a.pdf'), part('2', 'b.pdf'), part('3', 'c.pdf')],
  };
}

describe('GreenMail SORT key', () => {
  it('lists mail when SORT would hang on (UID 1:*)', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'SORT', 'UIDPLUS'],
      dropOnSortIncluding: '(UID 1:*)',
    });
    await server.ready();
    server.addMessage(simpleMessage({ subject: 'Present', text: 'body' }).toString('utf8'), []);
    const runtime = createRuntime({
      config: appConfig({
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
    const listed = await runtime.service.listMessages({
      mailbox: 'INBOX',
      limit: 10,
      includeSnippet: false,
    });
    expect(listed.total).toBe(1);
    expect(server.trace.some((line) => line.includes('(UID 1:*)'))).toBe(false);
    expect(server.trace.some((line) => line.includes('SORT') && line.includes('ALL'))).toBe(true);
    await runtime.close();
    await server.close();
  });

  it('fails clearly when SORT drops the socket instead of returning an empty page', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'SORT', 'UIDPLUS'],
      dropOnSortIncluding: 'SORT',
    });
    await server.ready();
    server.addMessage(simpleMessage({ subject: 'Present' }).toString('utf8'), []);
    const runtime = createRuntime({
      config: appConfig({
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
    await expect(
      runtime.service.listMessages({ mailbox: 'INBOX', limit: 10, includeSnippet: false }),
    ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    await runtime.close();
    await server.close();
  });
});

describe('attachment page identity', () => {
  it('returns a.pdf then b.pdf then c.pdf at limit 1', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.structure = attachmentTree();
    const service = serviceFor(session);
    await session.append(
      'INBOX',
      Buffer.from(
        'Subject: files\r\nContent-Disposition: attachment; filename="a.pdf"\r\n\r\nbody',
      ),
      [],
    );
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const listed = await service.listAttachments({
        mailbox: 'INBOX',
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      const items = listed.items as Array<{ filename: string | null }>;
      if (items.length === 0) {
        expect(listed.nextCursor).toBeNull();
        break;
      }
      names.push(String(items[0]?.filename));
      cursor = listed.nextCursor ? String(listed.nextCursor) : undefined;
      if (!cursor) {
        break;
      }
    }
    expect(names).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });
});

describe('expunged SORT anchor', () => {
  it('continues past a missing UID instead of ending the walk', async () => {
    const session = new FakeSession();
    const box = session.ensure('INBOX');
    for (const uid of [1, 2, 3]) {
      box.messages.push({
        uid,
        raw: Buffer.from(`Subject: m${uid}\r\n\r\nm${uid}`),
        flags: [],
        internalDate: `2026-01-0${uid}T00:00:00.000Z`,
        subject: `m${uid}`,
        size: 10,
      });
    }
    box.uidNext = 4;
    session.ghostUids.add(2);
    const service = serviceFor(session);
    const first = await service.listMessages({ mailbox: 'INBOX', limit: 1, includeSnippet: false });
    expect((first.messages as Array<{ uid: number }>)[0]?.uid).toBe(3);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.listMessages({
      mailbox: 'INBOX',
      limit: 1,
      includeSnippet: false,
      cursor: String(first.nextCursor),
    });
    expect(second.total).toBe(3);
    expect(second.nextCursor).toEqual(expect.any(String));
    const third = await service.listMessages({
      mailbox: 'INBOX',
      limit: 1,
      includeSnippet: false,
      cursor: String(second.nextCursor),
    });
    const seen = [
      (first.messages as Array<{ uid: number }>)[0]?.uid,
      (second.messages as Array<{ uid: number }>)[0]?.uid,
      (third.messages as Array<{ uid: number }>)[0]?.uid,
    ];
    expect(seen).toEqual([3, undefined, 1]);
  });

  it('does not clip the rest of a sorted mailbox to maxPerFolder after the anchor is expunged', async () => {
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
    const first = await service.listMessages({ mailbox: 'INBOX', limit: 2, includeSnippet: false });
    expect((first.messages as Array<{ uid: number }>).map((item) => item.uid)).toEqual([6, 5]);
    box.messages = box.messages.filter((item) => item.uid !== 5);
    const seen = new Set<number>([6]);
    let cursor = first.nextCursor ? String(first.nextCursor) : undefined;
    for (let page = 0; page < 8 && cursor; page += 1) {
      const listed = await service.listMessages({
        mailbox: 'INBOX',
        limit: 2,
        includeSnippet: false,
        cursor,
      });
      for (const item of listed.messages as Array<{ uid: number }>) {
        expect(seen.has(item.uid)).toBe(false);
        seen.add(item.uid);
      }
      cursor = listed.nextCursor ? String(listed.nextCursor) : undefined;
    }
    expect([...seen].sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 6]);
  });
});

describe('threads', () => {
  it('counts a reply in another folder instead of collapsing on UID', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    const service = serviceFor(session);
    await session.append(
      'INBOX',
      simpleMessage({ subject: 'Root', messageId: '<root@ex>', text: 'root' }),
      [],
    );
    session.ensure('Sent', '\\Sent');
    await session.append(
      'Sent',
      simpleMessage({
        subject: 'Re: Root',
        messageId: '<reply@ex>',
        inReplyTo: '<root@ex>',
        references: '<root@ex>',
        text: 'reply',
      }),
      [],
    );
    await session.append(
      'Sent',
      simpleMessage({ subject: 'Other', messageId: '<other@ex>', text: 'other' }),
      [],
    );
    const listed = await service.listThreads({
      folders: ['INBOX', 'Sent'],
      limit: 10,
    });
    const items = listed.items as Array<{ messageCount: number; mailbox: string; uid: number }>;
    const root = items.find((item) => item.messageCount === 2);
    expect(root).toBeDefined();
    expect(JSON.stringify(listed.threads)).toContain('Sent');
    expect(items.reduce((sum, item) => sum + item.messageCount, 0)).toBe(3);
  });

  it('reports source server only when the server tree is used', async () => {
    const client = new FakeSession(['IMAP4rev1']);
    await client.append('INBOX', simpleMessage({ messageId: '<a@ex>', text: 'a' }), []);
    await client.append(
      'INBOX',
      simpleMessage({ messageId: '<b@ex>', inReplyTo: '<a@ex>', references: '<a@ex>', text: 'b' }),
      [],
    );
    const clientList = await serviceFor(client).listThreads({ mailbox: 'INBOX', limit: 10 });
    expect(clientList.source).toBe('client');
    expect(clientList.total).toBe(1);

    const server = new FakeSession(['IMAP4rev1', 'THREAD']);
    await server.append('INBOX', simpleMessage({ messageId: '<a@ex>', text: 'a' }), []);
    await server.append(
      'INBOX',
      simpleMessage({ messageId: '<b@ex>', inReplyTo: '<a@ex>', references: '<a@ex>', text: 'b' }),
      [],
    );
    const serverList = await serviceFor(server).listThreads({ mailbox: 'INBOX', limit: 10 });
    expect(serverList.source).toBe('server');
    expect(serverList.total).toBe(2);
  });

  it('uses one threadKey for the envelope and every item, in either order', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    const service = serviceFor(session);
    await session.append(
      'INBOX',
      simpleMessage({
        subject: 'Root',
        messageId: '<root@ex>',
        date: 'Tue, 01 Jan 2026 00:00:00 +0000',
        text: 'root',
      }),
      [],
    );
    await session.append(
      'INBOX',
      simpleMessage({
        subject: 'Re: Root',
        messageId: '<reply@ex>',
        inReplyTo: '<root@ex>',
        references: '<root@ex>',
        date: 'Wed, 02 Jan 2026 00:00:00 +0000',
        text: 'reply',
      }),
      [],
    );
    const newest = await service.getThread({ mailbox: 'INBOX', uid: 1, order: 'newest-first' });
    const oldest = await service.getThread({ mailbox: 'INBOX', uid: 1, order: 'oldest-first' });
    const newestItems = newest.items as Array<{ threadKey: string }>;
    const oldestItems = oldest.items as Array<{ threadKey: string }>;
    expect(newest.threadKey).toBe(oldest.threadKey);
    expect(newestItems.every((item) => item.threadKey === newest.threadKey)).toBe(true);
    expect(oldestItems.every((item) => item.threadKey === oldest.threadKey)).toBe(true);
    const key = conversationThreadKey([
      {
        mailbox: 'INBOX',
        uid: 1,
        uidValidity: '100',
        messageId: '<root@ex>',
        references: [],
        date: '2026-01-01',
      },
      {
        mailbox: 'INBOX',
        uid: 2,
        uidValidity: '100',
        messageId: '<reply@ex>',
        inReplyTo: '<root@ex>',
        references: ['<root@ex>'],
        date: '2026-01-02',
      },
    ]);
    expect(newest.threadKey).toBe(key);
    const listed = await service.listThreads({ mailbox: 'INBOX', limit: 10 });
    expect((listed.items as Array<{ threadKey: string }>)[0]?.threadKey).toBe(key);
  });

  it('keeps a reply whose Message-ID only shares a substring with the root', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    const service = serviceFor(session);
    await session.append(
      'INBOX',
      simpleMessage({ subject: 'Root', messageId: '<root@ex>', text: 'root' }),
      [],
    );
    await session.append(
      'INBOX',
      simpleMessage({ subject: 'Other', messageId: '<xroot@ex>', text: 'other' }),
      [],
    );
    const thread = await service.getThread({ mailbox: 'INBOX', uid: 1 });
    const subjects = (thread.items as Array<{ subject: string | null }>).map(
      (item) => item.subject,
    );
    expect(subjects).toContain('Root');
    expect(subjects).not.toContain('Other');
  });

  it('includes every folder where the Message-ID matches, not only the first LIST hit', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    const service = serviceFor(session);
    session.ensure('AAA');
    session.ensure('Later');
    await session.append(
      'AAA',
      simpleMessage({ subject: 'Root', messageId: '<root@ex>', text: 'root' }),
      [],
    );
    await session.append(
      'Later',
      simpleMessage({
        subject: 'Re: Root',
        messageId: '<reply@ex>',
        inReplyTo: '<root@ex>',
        references: '<root@ex>',
        text: 'reply',
      }),
      [],
    );
    const thread = await service.getThread({ messageId: '<root@ex>' });
    const folders = (thread.items as Array<{ mailbox: string }>).map((item) => item.mailbox);
    expect(folders).toEqual(expect.arrayContaining(['AAA', 'Later']));
  });

  it('does not let a second copy consume the message cap', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    const service = serviceFor(session);
    session.ensure('Sent', '\\Sent');
    await session.append(
      'INBOX',
      simpleMessage({ messageId: '<root@ex>', subject: 'Root', text: 'root' }),
      [],
    );
    await session.append(
      'Sent',
      simpleMessage({ messageId: '<root@ex>', subject: 'Root', text: 'copy' }),
      [],
    );
    await session.append(
      'Sent',
      simpleMessage({
        messageId: '<reply@ex>',
        inReplyTo: '<root@ex>',
        references: '<root@ex>',
        subject: 'Re: Root',
        text: 'reply',
      }),
      [],
    );
    const thread = await service.getThread({
      mailbox: 'INBOX',
      uid: 1,
      maxMessages: 2,
    });
    const subjects = (thread.items as Array<{ subject: string | null }>).map(
      (item) => item.subject,
    );
    expect(subjects).toContain('Re: Root');
    expect(thread.truncated).toBe(false);
  });

  it('keys client thread nodes by mailbox and uid', () => {
    const tree = threadMessages([
      { uid: 1, mailbox: 'INBOX', messageId: '<a@ex>' },
      { uid: 1, mailbox: 'Sent', messageId: '<b@ex>', inReplyTo: '<a@ex>', references: ['<a@ex>'] },
    ]);
    expect(tree[0]?.mailbox).toBe('INBOX');
    expect(tree[0]?.children[0]?.mailbox).toBe('Sent');
    expect(tree[0]?.children[0]?.uid).toBe(1);
  });
});

describe('bulk and counts', () => {
  it('refuses a real bulk run that did not load every match', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    const service = serviceFor(session, {
      limits: { ...appConfig().limits, maxSortCandidates: 2, maxBulk: 10 },
    });
    for (const uid of [1, 2, 3, 4]) {
      await session.append('INBOX', simpleMessage({ subject: `m${uid}`, text: 'x' }), []);
    }
    await expect(
      service.modifyBySearch({
        mailbox: 'INBOX',
        search: { all: true },
        action: 'addFlags',
        flags: ['\\Seen'],
        dryRun: false,
      }),
    ).rejects.toBeInstanceOf(MailError);
    const flags = session.boxes.get('INBOX')?.messages.map((item) => item.flags) ?? [];
    expect(flags.every((item) => !item.includes('\\Seen'))).toBe(true);
  });

  it('hides mail_modify_by_search on a read-only account', () => {
    const service = serviceFor(new FakeSession(), { readOnly: true });
    expect(toolsForService(service).some((tool) => tool.name === 'mail_modify_by_search')).toBe(
      false,
    );
    expect(TOOLS.find((tool) => tool.name === 'mail_modify_by_search')?.kind).toBe('message-write');
  });

  it('counts every sender when the per-folder window is smaller than the match', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    const service = serviceFor(session, {
      limits: { ...appConfig().limits, maxSortCandidates: 2 },
    });
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await session.append(
        'INBOX',
        simpleMessage({ from: `${name}@ex`, subject: name, text: name }),
        [],
      );
    }
    const correspondents = await service.listCorrespondents({ mailbox: 'INBOX', limit: 10 });
    expect(correspondents.truncated).toBe(false);
    expect(correspondents.partial).toBe(false);
    expect(correspondents.total).toBe(5);
    const facets = await service.searchFacets({ mailbox: 'INBOX', top: 10 });
    expect(facets.partial).toBe(false);
    expect(
      (facets.senders as Array<{ count: number }>).reduce((sum, item) => sum + item.count, 0),
    ).toBe(5);
  });
});

describe('Reply-To and draft bytes', () => {
  it('rejects a Reply-To that is not an identity, including one hidden in headers', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    const sent: Buffer[] = [];
    const service = serviceFor(
      session,
      {},
      {
        verify: async () => undefined,
        send: async (input) => {
          sent.push(input.raw);
          return { accepted: ['ada@example.com'], rejected: [], pending: [], response: '250' };
        },
        close() {
          return undefined;
        },
      },
    );
    await expect(
      service.send({
        to: ['ada@example.com'],
        subject: 'Hi',
        text: 'body',
        replyTo: ['Eve <eve@evil.test>'],
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      service.send({
        to: ['ada@example.com'],
        subject: 'Hi',
        text: 'body',
        headers: { 'Reply-To': 'eve@evil.test' },
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      service.send({
        to: ['ada@example.com'],
        subject: 'Hi',
        text: 'body',
        headers: { From: 'eve@evil.test', 'Message-ID': '<forged@evil.test>' },
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(sent).toHaveLength(0);
  });

  it('returns identity replyTo and applies it when the caller omits one', async () => {
    const session = new FakeSession(['IMAP4rev1']);
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
      },
      {
        verify: async () => undefined,
        send: async (input) => {
          sent.push(input.raw);
          return { accepted: ['ada@example.com'], rejected: [], pending: [], response: '250' };
        },
        close() {
          return undefined;
        },
      },
    );
    const accounts = service.listAccounts();
    expect(accounts[0]?.identities).toEqual([
      expect.objectContaining({ email: 'user@example.com', replyTo: 'user@example.com' }),
    ]);
    await service.send({ to: ['ada@example.com'], subject: 'Hi', text: 'body' });
    expect(sent[0]?.toString('utf8')).toMatch(/Reply-To:.*user@example.com/i);
  });

  it('appends the exact sent draft, including inline parts and attachments, without Bcc', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    const sent: Buffer[] = [];
    const service = serviceFor(
      session,
      {},
      {
        verify: async () => undefined,
        send: async (input) => {
          sent.push(input.raw);
          return { accepted: ['ada@example.com'], rejected: [], pending: [], response: '250' };
        },
        close() {
          return undefined;
        },
      },
    );
    session.ensure('Drafts', '\\Drafts');
    const draft = await buildRawMessage(
      {
        from: { name: 'User', address: 'user@example.com' },
        to: [{ address: 'ada@example.com' }],
        bcc: [{ address: 'bcc@example.com' }],
        subject: 'Draft',
        text: 'hello',
        html: '<p>hello <img src="cid:logo"></p>',
        attachments: [
          {
            filename: 'logo.png',
            contentType: 'image/png',
            contentBase64: Buffer.from('png').toString('base64'),
            cid: 'logo',
            inline: true,
          },
          {
            filename: 'notes.pdf',
            contentType: 'application/pdf',
            contentBase64: Buffer.from('pdf').toString('base64'),
          },
        ],
      },
      { keepBcc: true },
    );
    const appended = await session.append('Drafts', draft, ['\\Draft']);
    if (appended.uid === undefined) {
      throw new Error('append did not return a uid');
    }
    await service.sendDraft({ mailbox: 'Drafts', uid: appended.uid, from: 'user@example.com' });
    const wire = sent[0]?.toString('utf8') ?? '';
    const stored = session.boxes.get('Sent')?.messages[0]?.raw.toString('utf8') ?? '';
    expect(stored).toBe(wire);
    expect(wire).not.toMatch(/bcc@example.com/i);
    expect(wire).toContain('notes.pdf');
    expect(wire).toMatch(/Content-ID:.*logo/i);
    expect(wire).toContain('logo.png');
  });
});
