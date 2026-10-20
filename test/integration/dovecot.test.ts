import { readFileSync } from 'node:fs';
import net from 'node:net';
import { describe, expect, it, beforeAll } from 'vitest';
import { ImapFlow } from 'imapflow';
import { ImapFlowSession } from '../../src/imap/flow-session.js';
import { createRuntime } from '../../src/runtime.js';
import { createLogger } from '../../src/log.js';
import { simpleMessage } from '../fixtures/messages.js';
import { ensureDovecot, type DovecotEndpoints } from '../support/dovecot.js';
import { account, appConfig } from '../support/config.js';

let dovecot: DovecotEndpoints;

beforeAll(async () => {
  dovecot = await ensureDovecot();
}, 180_000);

function runtimeFor(port: number, overrides: Parameters<typeof appConfig>[0] = {}) {
  return createRuntime({
    config: appConfig({
      imap: {
        host: dovecot.host,
        port,
        secure: false,
        starttls: 'required',
        timeoutMs: 15_000,
        tls: { rejectUnauthorized: true, caFile: dovecot.caFile, servername: 'localhost' },
      },
      user: dovecot.user,
      email: dovecot.email,
      auth: { type: 'password', password: dovecot.password },
      identities: [{ id: 'default', email: dovecot.email, name: 'User', default: true }],
      appendSent: false,
      allowDelete: true,
      allowPermanentDelete: true,
      ...overrides,
    }),
    logger: createLogger({ level: 'silent' }),
  });
}

describe('Dovecot', () => {
  it('uses STARTTLS and the extensions GreenMail does not have', async () => {
    const runtime = runtimeFor(dovecot.imapPort);
    const caps = await runtime.service.capabilities();
    const list = caps.capabilities as string[];
    expect(list.some((token) => token.startsWith('THREAD='))).toBe(true);
    expect(list).toContain('SORT');
    expect(list).toContain('ESEARCH');
    expect(list).toContain('NAMESPACE');
    expect(list).toContain('ID');
    expect(list.some((token) => token === 'SPECIAL-USE' || token === 'IMAP4REV2')).toBe(true);
    const namespaces = await runtime.service.namespaces();
    expect((namespaces.namespaces as { personal: unknown[] }).personal.length).toBeGreaterThan(0);
    const server = await runtime.service.serverId();
    expect(server.ok).toBe(true);
    const special = await runtime.service.specialUse();
    expect((special.special as { trash?: string }).trash).toBeTruthy();
    await runtime.close();
  });

  it('sorts and threads on the server', async () => {
    const runtime = runtimeFor(dovecot.imapPort);
    const stamp = `dove-${Date.now()}`;
    await runtime.service.createMailbox(undefined, stamp);
    await runtime.service.append({
      mailbox: stamp,
      rawBase64: simpleMessage({
        subject: 'Beta',
        text: 'b',
        messageId: '<beta@example.com>',
      }).toString('base64'),
    });
    await runtime.service.append({
      mailbox: stamp,
      rawBase64: simpleMessage({
        subject: 'Alpha',
        text: 'a',
        messageId: '<alpha@example.com>',
        inReplyTo: '<beta@example.com>',
        references: '<beta@example.com>',
      }).toString('base64'),
    });
    const listed = await runtime.service.listMessages({
      mailbox: stamp,
      sort: [{ field: 'subject' }],
      limit: 10,
      includeSnippet: false,
    });
    expect(listed.sortSource).toBe('server');
    const subjects = (listed.messages as Array<{ subject: string | null }>).map(
      (item) => item.subject,
    );
    expect(subjects[0]).toBe('Alpha');
    const threads = await runtime.service.listThreads({ mailbox: stamp, limit: 10 });
    expect(threads.source).toBe('server');
    expect(threads.total).toBeGreaterThan(0);
    await runtime.close();
  });

  it('does not expunge a neighbor when UIDPLUS is absent', async () => {
    const runtime = runtimeFor(dovecot.noUidPlusPort);
    const stamp = `nouid-${Date.now()}`;
    await runtime.service.createMailbox(undefined, stamp);
    const first = await runtime.service.append({
      mailbox: stamp,
      rawBase64: simpleMessage({ subject: 'keep', text: 'a' }).toString('base64'),
    });
    const second = await runtime.service.append({
      mailbox: stamp,
      rawBase64: simpleMessage({ subject: 'drop', text: 'b' }).toString('base64'),
    });
    await runtime.service.setFlags({
      mailbox: stamp,
      uids: [Number(first.uid)],
      flags: ['\\Deleted'],
      operation: 'add',
    });
    await expect(
      runtime.service.deleteMessages({
        mailbox: stamp,
        uids: [Number(second.uid)],
        permanent: true,
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    const left = await runtime.service.listMessages({
      mailbox: stamp,
      limit: 10,
      includeSnippet: false,
    });
    expect(left.total).toBe(2);
    const caps = await runtime.service.capabilities();
    const list = caps.capabilities as string[];
    expect(list).toContain('IMAP4rev1');
    expect(list).toContain('SORT');
    expect(list).not.toContain('UIDPLUS');
    expect(list.some((token) => token.startsWith('-'))).toBe(false);
    await runtime.close();
  });

  it('returns a parsed view of malformed MIME instead of failing the fetch', async () => {
    const runtime = runtimeFor(dovecot.imapPort);
    const stamp = `broken-${Date.now()}`;
    await runtime.service.createMailbox(undefined, stamp);
    const appended = await runtime.service.append({
      mailbox: stamp,
      rawBase64: Buffer.from(
        'From: ada@example.com\r\nTo: user@example.com\r\nSubject: =?unknown?Q?broken?=\r\nContent-Type: text/plain; charset=x-not-a-charset\r\nContent-Transfer-Encoding: 8bit\r\n\r\ncaf\u00e9 raw\r\n',
      ).toString('base64'),
    });
    const uid = Number(appended.uid);
    const message = await runtime.service.getMessage({ mailbox: stamp, uid });
    expect(message.ok).toBe(true);
    expect(message.uid).toBe(uid);
    expect(message.text === null || typeof message.text === 'string').toBe(true);
    const source = await runtime.service.getSource({ mailbox: stamp, uid });
    expect(Number(source.bytes)).toBeGreaterThan(20);
    await runtime.close();
  });

  it('sees mail that arrives while waiting on a server without IDLE', async () => {
    const runtime = runtimeFor(dovecot.noIdlePort);
    const stamp = `noidle-${Date.now()}`;
    await runtime.service.createMailbox(undefined, stamp);
    const waiting = runtime.service.waitForChanges({ mailbox: stamp, timeoutMs: 4000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await runtime.service.append({
      mailbox: stamp,
      rawBase64: simpleMessage({ subject: 'arrived', text: 'now' }).toString('base64'),
    });
    const result = await waiting;
    const caps = await runtime.service.capabilities();
    const list = caps.capabilities as string[];
    expect(list).toContain('IMAP4rev1');
    expect(list).toContain('UIDPLUS');
    expect(list).not.toContain('IDLE');
    expect(list.some((token) => token.startsWith('-'))).toBe(false);
    expect(result.idleSupported).toBe(false);
    expect(result.timedOut).toBe(false);
    expect((result.changes as unknown[]).length).toBeGreaterThan(0);
    await runtime.close();
  });

  it('pages newest-first when an older internal date is not the lowest UID', async () => {
    const runtime = runtimeFor(dovecot.imapPort);
    const stamp = `mixed-${Date.now()}`;
    await runtime.service.createMailbox(undefined, stamp);
    await runtime.service.append({
      mailbox: stamp,
      date: '2026-08-01T12:00:00.000Z',
      rawBase64: simpleMessage({ subject: 'Newer' }).toString('base64'),
    });
    await runtime.service.append({
      mailbox: stamp,
      date: '2010-01-01T12:00:00.000Z',
      rawBase64: simpleMessage({ subject: 'Older' }).toString('base64'),
    });
    await runtime.service.append({
      mailbox: stamp,
      date: '2026-10-20T12:00:00.000Z',
      rawBase64: simpleMessage({ subject: 'Newest' }).toString('base64'),
    });
    const subjects: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const listed = await runtime.service.listMessages({
        mailbox: stamp,
        limit: 1,
        includeSnippet: false,
        ...(cursor ? { cursor } : {}),
      });
      const rows = listed.messages as Array<{ subject: string | null }>;
      if (rows.length === 0) {
        break;
      }
      subjects.push(String(rows[0]?.subject));
      cursor = listed.nextCursor ? String(listed.nextCursor) : undefined;
      if (!cursor) {
        break;
      }
    }
    expect(subjects).toEqual(['Newest', 'Newer', 'Older']);
    expect(new Set(subjects).size).toBe(subjects.length);
    await runtime.close();
  });

  it('sees mail that arrives after the account socket timeout', async () => {
    const runtime = runtimeFor(dovecot.imapPort, {
      imap: {
        host: dovecot.host,
        port: dovecot.imapPort,
        secure: false,
        starttls: 'required',
        timeoutMs: 3_000,
        tls: { rejectUnauthorized: true, caFile: dovecot.caFile, servername: 'localhost' },
      },
    });
    const stamp = `longwait-${Date.now()}`;
    await runtime.service.createMailbox(undefined, stamp);
    const waiting = runtime.service.waitForChanges({ mailbox: stamp, timeoutMs: 6_000 });
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await runtime.service.append({
      mailbox: stamp,
      rawBase64: simpleMessage({ subject: 'late', text: 'after the account timeout' }).toString(
        'base64',
      ),
    });
    const result = await waiting;
    expect(result.timedOut).toBe(false);
    expect((result.changes as unknown[]).length).toBeGreaterThan(0);
    await runtime.close();
  });

  it('stays up when a pooled connection sits past the socket timeout', async () => {
    const crashes: unknown[] = [];
    const onException = (error: unknown): void => {
      crashes.push(error);
    };
    const onRejection = (error: unknown): void => {
      crashes.push(error);
    };
    process.on('uncaughtException', onException);
    process.on('unhandledRejection', onRejection);
    const runtime = runtimeFor(dovecot.imapPort, {
      imap: {
        host: dovecot.host,
        port: dovecot.imapPort,
        secure: false,
        starttls: 'required',
        timeoutMs: 3_000,
        tls: { rejectUnauthorized: true, caFile: dovecot.caFile, servername: 'localhost' },
      },
    });
    try {
      expect((await runtime.service.capabilities()).ok).toBe(true);
      await runtime.service.listMailboxes(undefined);
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      expect(crashes).toEqual([]);
      expect((await runtime.service.capabilities()).ok).toBe(true);
      await runtime.service.listMailboxes(undefined);
    } finally {
      process.off('uncaughtException', onException);
      process.off('unhandledRejection', onRejection);
      await runtime.close();
    }
  });

  it('stays up after a wait restores the short socket timeout', async () => {
    const crashes: unknown[] = [];
    const onException = (error: unknown): void => {
      crashes.push(error);
    };
    process.on('uncaughtException', onException);
    const runtime = runtimeFor(dovecot.imapPort, {
      imap: {
        host: dovecot.host,
        port: dovecot.imapPort,
        secure: false,
        starttls: 'required',
        timeoutMs: 3_000,
        tls: { rejectUnauthorized: true, caFile: dovecot.caFile, servername: 'localhost' },
      },
    });
    try {
      const stamp = `restore-${Date.now()}`;
      await runtime.service.createMailbox(undefined, stamp);
      const waited = await runtime.service.waitForChanges({ mailbox: stamp, timeoutMs: 4_000 });
      expect(waited.timedOut).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      expect(crashes).toEqual([]);
      expect((await runtime.service.capabilities()).ok).toBe(true);
    } finally {
      process.off('uncaughtException', onException);
      await runtime.close();
    }
  });

  it('serves an ESORT partial window', async () => {
    const session = new ImapFlowSession(
      account({
        user: dovecot.user,
        email: dovecot.email,
        auth: { type: 'password', password: dovecot.password },
        imap: {
          host: dovecot.host,
          port: dovecot.imapPort,
          secure: false,
          starttls: 'required',
          timeoutMs: 15_000,
          tls: { rejectUnauthorized: true, caFile: dovecot.caFile, servername: 'localhost' },
        },
      }),
      async () => undefined,
      createLogger({ level: 'silent' }),
    );
    await session.connect();
    const stamp = `partial-${Date.now()}`;
    await session.createMailbox(stamp);
    for (const subject of ['One', 'Two', 'Three']) {
      await session.append(stamp, simpleMessage({ subject }));
    }
    const sorted = await session.withMailbox(stamp, 'read', (box) =>
      box.serverSort(
        { query: { all: true }, requires: [] },
        [{ field: 'arrival', reverse: true }],
        {
          start: 1,
          count: 1,
        },
      ),
    );
    expect(sorted?.partial).toBe(true);
    expect(sorted?.uids).toHaveLength(1);
    expect(sorted?.total).toBe(3);
    await session.close();
  });

  it('does not skip a message when an already returned one is expunged', async () => {
    const runtime = runtimeFor(dovecot.imapPort);
    const stamp = `expunge-page-${Date.now()}`;
    await runtime.service.createMailbox(undefined, stamp);
    for (const subject of ['Zebra', 'Mango', 'Banana', 'Apple']) {
      await runtime.service.append({
        mailbox: stamp,
        rawBase64: simpleMessage({ subject }).toString('base64'),
      });
    }
    const sort = [{ field: 'subject' as const, reverse: true }];
    const first = await runtime.service.listMessages({
      mailbox: stamp,
      sort,
      limit: 1,
      includeSnippet: false,
    });
    const row = (first.messages as Array<{ uid: number; subject: string | null }>)[0];
    expect(row?.subject).toBe('Zebra');
    await runtime.service.deleteMessages({
      mailbox: stamp,
      uids: [Number(row?.uid)],
      permanent: true,
    });
    const subjects: string[] = [];
    let cursor = first.nextCursor ? String(first.nextCursor) : undefined;
    for (let page = 0; page < 5 && cursor; page += 1) {
      const listed = await runtime.service.listMessages({
        mailbox: stamp,
        sort,
        limit: 1,
        includeSnippet: false,
        cursor,
      });
      const message = (listed.messages as Array<{ subject: string | null }>)[0];
      if (!message) {
        break;
      }
      subjects.push(String(message.subject));
      cursor = listed.nextCursor ? String(listed.nextCursor) : undefined;
    }
    expect(subjects).toEqual(['Mango', 'Banana', 'Apple']);
    await runtime.close();
  });

  it('negotiates STARTTLS on port 143', async () => {
    const client = new ImapFlow({
      host: dovecot.host,
      port: dovecot.imapPort,
      secure: false,
      doSTARTTLS: true,
      tls: { rejectUnauthorized: true, ca: readFileSync(dovecot.caFile), servername: 'localhost' },
      auth: { user: dovecot.user, pass: dovecot.password },
      logger: false,
    });
    await client.connect();
    expect(client.secureConnection).toBe(true);
    await client.logout();
  });

  it('returns a conversation across Inbox, Sent, and Archive', async () => {
    const runtime = runtimeFor(dovecot.imapPort);
    const stamp = `thr-${Date.now()}`;
    const sent = `Sent-${stamp}`;
    const archive = `Archive-${stamp}`;
    await runtime.service.createMailbox(undefined, sent);
    await runtime.service.createMailbox(undefined, archive);
    await runtime.service.append({
      mailbox: archive,
      rawBase64: simpleMessage({
        subject: `Thread ${stamp}`,
        messageId: `<early-${stamp}@example.com>`,
        date: 'Mon, 01 Jan 2024 00:00:00 +0000',
        text: 'earlier',
      }).toString('base64'),
    });
    await runtime.service.append({
      mailbox: 'INBOX',
      rawBase64: simpleMessage({
        subject: `Re: Thread ${stamp}`,
        messageId: `<mid-${stamp}@example.com>`,
        inReplyTo: `<early-${stamp}@example.com>`,
        references: `<early-${stamp}@example.com>`,
        date: 'Tue, 02 Jan 2024 00:00:00 +0000',
        text: 'inbox',
      }).toString('base64'),
    });
    await runtime.service.append({
      mailbox: sent,
      rawBase64: simpleMessage({
        subject: `Re: Thread ${stamp}`,
        messageId: `<late-${stamp}@example.com>`,
        inReplyTo: `<mid-${stamp}@example.com>`,
        references: `<early-${stamp}@example.com> <mid-${stamp}@example.com>`,
        date: 'Wed, 03 Jan 2024 00:00:00 +0000',
        text: 'sent',
      }).toString('base64'),
    });
    const found = await runtime.service.searchMessages({
      mailbox: 'INBOX',
      search: { header: { name: 'Message-ID', value: `mid-${stamp}@example.com` } },
      limit: 5,
      includeSnippet: false,
    });
    const uid = Number((found.messages as Array<{ uid: number }>)[0]?.uid);
    const thread = await runtime.service.getThread({
      mailbox: 'INBOX',
      uid,
      folders: ['INBOX', sent, archive],
      order: 'oldest-first',
    });
    const ids = (thread.items as Array<{ messageId: string | null }>).map((item) => item.messageId);
    expect(ids).toEqual([
      `<early-${stamp}@example.com>`,
      `<mid-${stamp}@example.com>`,
      `<late-${stamp}@example.com>`,
    ]);
    await runtime.close();
  });

  it('does not skip or duplicate when mail arrives between pages', async () => {
    const runtime = runtimeFor(dovecot.imapPort);
    const stamp = `page-${Date.now()}`;
    await runtime.service.createMailbox(undefined, stamp);
    for (const subject of ['One', 'Two', 'Three']) {
      await runtime.service.append({
        mailbox: stamp,
        rawBase64: simpleMessage({ subject: `${subject} ${stamp}`, messageId: `<${subject}-${stamp}@e>` }).toString(
          'base64',
        ),
      });
    }
    const first = await runtime.service.listMessages({ mailbox: stamp, limit: 1, includeSnippet: false });
    await runtime.service.append({
      mailbox: stamp,
      rawBase64: simpleMessage({ subject: `Later ${stamp}`, messageId: `<later-${stamp}@e>` }).toString('base64'),
    });
    const seen = new Set<number>();
    let cursor = first.nextCursor ? String(first.nextCursor) : undefined;
    const firstUid = Number((first.messages as Array<{ uid: number }>)[0]?.uid);
    seen.add(firstUid);
    while (cursor) {
      const page = await runtime.service.listMessages({
        mailbox: stamp,
        limit: 1,
        includeSnippet: false,
        cursor,
      });
      for (const row of page.messages as Array<{ uid: number }>) {
        expect(seen.has(row.uid)).toBe(false);
        seen.add(row.uid);
      }
      cursor = page.nextCursor ? String(page.nextCursor) : undefined;
    }
    expect(seen.size).toBe(3);
    const fresh = await runtime.service.listMessages({ mailbox: stamp, limit: 10, includeSnippet: false });
    expect(fresh.total).toBe(4);
    await runtime.close();
  });

  it('keeps certificate verification when dialing a forwarded address', async () => {
    const bridge = await listenForward(dovecot.imapsPort);
    const runtime = runtimeFor(0, {
      imap: {
        host: 'localhost',
        port: 993,
        connectHost: '127.0.0.1',
        connectPort: bridge.port,
        secure: true,
        starttls: 'disabled',
        timeoutMs: 15_000,
        tls: { rejectUnauthorized: true, caFile: dovecot.caFile },
      },
    });
    const checked = await runtime.service.verify(undefined, { imap: true, smtp: false });
    expect(checked.ok).toBe(true);
    expect(checked.imap).toMatchObject({
      host: 'localhost',
      connectHost: '127.0.0.1',
      connectPort: bridge.port,
      servername: 'localhost',
    });
    await runtime.close();
    const mismatch = runtimeFor(0, {
      imap: {
        host: 'wrong.example',
        port: 993,
        connectHost: '127.0.0.1',
        connectPort: bridge.port,
        secure: true,
        starttls: 'disabled',
        timeoutMs: 15_000,
        tls: { rejectUnauthorized: true, caFile: dovecot.caFile },
      },
    });
    const failed = await mismatch.service.verify(undefined, { imap: true, smtp: false });
    expect(failed.ok).toBe(false);
    expect(failed.imap).toMatchObject({ code: 'TLS_FAILED' });
    await mismatch.close();
    await bridge.close();
  });
});

function listenForward(targetPort: number): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      const upstream = net.connect(targetPort, '127.0.0.1');
      socket.pipe(upstream);
      upstream.pipe(socket);
      const drop = (): void => {
        socket.destroy();
        upstream.destroy();
      };
      socket.on('error', drop);
      upstream.on('error', drop);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
