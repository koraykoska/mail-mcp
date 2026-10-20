import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import { ImapFlowSession } from '../../src/imap/flow-session.js';
import { ImapConnectionPool, idleEvictDelay } from '../../src/imap/pool.js';
import type { ImapSession } from '../../src/imap/session.js';
import {
  anchorOf,
  canonicalSortValue,
  isStrictlyAfter,
  sortMessages,
} from '../../src/imap/sort.js';
import { createLogger } from '../../src/log.js';
import { decodeCursor, encodeCursor, pageAnchored } from '../../src/pagination.js';
import { decodeSnapshotCursor } from '../../src/page/snapshot.js';
import { createRuntime } from '../../src/runtime.js';
import { createMcpServer } from '../../src/server.js';
import { MailService } from '../../src/service/mail-service.js';
import type { SmtpSender } from '../../src/smtp/client.js';
import { simpleMessage } from '../fixtures/messages.js';
import { account, appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';
import { ScriptedImap } from '../support/scripted-imap.js';

const logger = createLogger({ level: 'silent' });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectAlive(work: () => Promise<void>): Promise<void> {
  const crashes: unknown[] = [];
  const onException = (error: unknown): void => {
    crashes.push(error);
  };
  const onRejection = (error: unknown): void => {
    crashes.push(error);
  };
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  try {
    await work();
    expect(crashes).toEqual([]);
  } finally {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
  }
}

function harness(session: FakeSession, overrides: Parameters<typeof appConfig>[0] = {}) {
  const smtp: SmtpSender = {
    async verify() {
      return undefined;
    },
    async send(input) {
      return {
        accepted: input.envelope.to,
        rejected: [],
        pending: [],
        response: '250 ok',
        messageId: '<id@example.com>',
      };
    },
    close() {
      return undefined;
    },
  };
  const config = appConfig(overrides);
  const service = new MailService({
    config,
    pool: new FakePool(session),
    smtpFactory: async () => smtp,
    logger,
  });
  return { service };
}

describe('idle IMAP connections', () => {
  it('keeps the process alive when a scripted socket times out', async () => {
    const server = new ScriptedImap({ capabilities: ['IMAP4rev1', 'UIDPLUS', 'IDLE'] });
    await server.ready();
    const session = new ImapFlowSession(
      account({
        imap: {
          host: '127.0.0.1',
          port: server.port,
          secure: false,
          starttls: 'disabled',
          timeoutMs: 1_000,
          tls: { rejectUnauthorized: false },
        },
      }),
      async () => undefined,
      logger,
    );
    await expectAlive(async () => {
      await session.connect();
      expect((await session.listMailboxes()).length).toBeGreaterThan(0);
      await sleep(2_500);
      expect(session.hasFailed()).toBe(true);
      await session.connect();
      expect(session.hasFailed()).toBe(false);
      expect((await session.listMailboxes()).length).toBeGreaterThan(0);
    });
    await session.close();
    await server.close();
  }, 20_000);

  it('reconnects from the pool after the restored wait timeout', async () => {
    const server = new ScriptedImap({ capabilities: ['IMAP4rev1', 'UIDPLUS', 'IDLE'] });
    await server.ready();
    const runtime = createRuntime({
      config: appConfig({
        imap: {
          host: '127.0.0.1',
          port: server.port,
          secure: false,
          starttls: 'disabled',
          timeoutMs: 1_000,
          tls: { rejectUnauthorized: false },
        },
      }),
      logger,
    });
    await expectAlive(async () => {
      const caps = await runtime.service.capabilities();
      expect(caps.ok).toBe(true);
      await runtime.service.listMailboxes(undefined);
      const waited = await runtime.service.waitForChanges({ timeoutMs: 1_500 });
      expect(waited.ok).toBe(true);
      await sleep(2_500);
      const again = await runtime.service.capabilities();
      expect(again.ok).toBe(true);
      expect(await runtime.service.listMailboxes(undefined)).toBeTruthy();
    });
    await runtime.close();
    await server.close();
  }, 20_000);

  it('drops an idle pooled session before the socket budget', async () => {
    expect(idleEvictDelay(0)).toBe(0);
    expect(idleEvictDelay(3_000)).toBeLessThan(3_000);
    expect(idleEvictDelay(80)).toBeLessThan(80);
    let created = 0;
    const pool = new ImapConnectionPool(
      async () => {
        created += 1;
        const session = {
          async connect() {
            return undefined;
          },
          async logout() {
            return undefined;
          },
          close() {
            return undefined;
          },
          idleBudgetMs() {
            return 300;
          },
          hasFailed() {
            return false;
          },
        };
        return session as unknown as ImapSession;
      },
      1,
      logger,
    );
    expect(await pool.use('a', async () => 'one')).toBe('one');
    expect(created).toBe(1);
    await sleep(400);
    expect(await pool.use('a', async () => 'two')).toBe('two');
    expect(created).toBe(2);
    await pool.close();
  });

  it('evicts a session the command marked failed', async () => {
    let created = 0;
    const pool = new ImapConnectionPool(
      async () => {
        created += 1;
        const generation = created;
        let failed = false;
        const session = {
          async connect() {
            return undefined;
          },
          async logout() {
            return undefined;
          },
          close() {
            return undefined;
          },
          hasFailed() {
            return failed;
          },
          mark() {
            failed = generation === 1;
          },
        };
        return session as unknown as ImapSession & { mark(): void };
      },
      1,
      logger,
    );
    await pool.use('a', async (session) => {
      (session as ImapSession & { mark(): void }).mark();
      return 'ok';
    });
    await pool.use('a', async () => 'next');
    expect(created).toBe(2);
    await pool.close();
  });
});

describe('ignored partial fetch', () => {
  it('returns SIZE_LIMIT and the next tool call still works', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'UIDPLUS'],
      ignorePartial: true,
      reportedSize: 20,
    });
    await server.ready();
    server.addMessage(simpleMessage({ text: 'x'.repeat(400) }).toString('utf8'), []);
    const runtime = createRuntime({
      config: appConfig({
        imap: {
          host: '127.0.0.1',
          port: server.port,
          secure: false,
          starttls: 'disabled',
          timeoutMs: 8_000,
          tls: { rejectUnauthorized: false },
        },
      }),
      logger,
    });
    const mcp = createMcpServer(runtime.service);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverTransport);
    const client = new Client({ name: 'round4', version: '0' });
    await client.connect(clientTransport);
    const raw = await client.callTool({
      name: 'mail_get_raw_message',
      arguments: { mailbox: 'INBOX', uid: 1, maxBytes: 50 },
    });
    expect(raw.isError).toBe(true);
    const text = JSON.stringify(raw.content);
    expect(text).toContain('SIZE_LIMIT');
    expect(text).toContain('sent more than');
    const listed = await client.callTool({ name: 'mail_list_mailboxes', arguments: {} });
    expect(listed.isError).toBeFalsy();
    await client.close();
    await runtime.close();
    await server.close();
  });
});

describe('ESORT return option', () => {
  it('sends RETURN outside the sort criteria and keeps a full-SORT fallback', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'SORT', 'ESORT', 'UIDPLUS'],
    });
    await server.ready();
    server.addMessage(simpleMessage({ subject: 'One' }).toString('utf8'), []);
    server.addMessage(simpleMessage({ subject: 'Two' }).toString('utf8'), []);
    server.addMessage(simpleMessage({ subject: 'Three' }).toString('utf8'), []);
    const session = new ImapFlowSession(
      account({
        imap: {
          host: '127.0.0.1',
          port: server.port,
          secure: false,
          starttls: 'disabled',
          timeoutMs: 8_000,
          tls: { rejectUnauthorized: false },
        },
      }),
      async () => undefined,
      logger,
    );
    await session.connect();
    const sorted = await session.withMailbox('INBOX', 'read', (box) =>
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
    const command = server.trace.find((line) => line.includes('SORT'));
    expect(command).toContain('SORT RETURN (PARTIAL 1:1 COUNT)');
    expect(command).not.toContain('(RETURN');
    await session.close();
    await server.close();

    const refused = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'SORT', 'ESORT', 'UIDPLUS'],
      badSortIncluding: 'RETURN',
    });
    await refused.ready();
    refused.addMessage(simpleMessage({ subject: 'A' }).toString('utf8'), []);
    refused.addMessage(simpleMessage({ subject: 'B' }).toString('utf8'), []);
    const second = new ImapFlowSession(
      account({
        imap: {
          host: '127.0.0.1',
          port: refused.port,
          secure: false,
          starttls: 'disabled',
          timeoutMs: 8_000,
          tls: { rejectUnauthorized: false },
        },
      }),
      async () => undefined,
      logger,
    );
    await second.connect();
    const fallback = await second.withMailbox('INBOX', 'read', (box) =>
      box.serverSort(
        { query: { all: true }, requires: [] },
        [{ field: 'arrival', reverse: true }],
        {
          start: 1,
          count: 1,
        },
      ),
    );
    expect(fallback?.partial).toBe(false);
    expect(fallback?.uids).toHaveLength(2);
    await second.close();
    await refused.close();
  });
});

describe('page cursor after an expunge', () => {
  it('does not skip the following message when the last returned one is deleted', async () => {
    const session = new FakeSession(['IMAP4rev1', 'UIDPLUS']);
    for (const subject of ['Zebra', 'Mango', 'Banana', 'Apple']) {
      await session.append('INBOX', simpleMessage({ subject, messageId: `<${subject}@ex>` }), []);
    }
    const { service } = harness(session, { allowPermanentDelete: true });
    const sort = [{ field: 'subject' as const, reverse: true }];
    const first = await service.listMessages({
      mailbox: 'INBOX',
      sort,
      limit: 1,
      includeSnippet: false,
    });
    const row = (first.messages as Array<{ uid: number; subject: string | null }>)[0];
    expect(row?.subject).toBe('Zebra');
    const cursor = String(first.nextCursor);
    expect(decodeSnapshotCursor(cursor)).toMatchObject({
      v: 4,
      anchor: { uid: row?.uid, field: 'subject', reverse: true, value: 'Zebra' },
    });
    await service.deleteMessages({ mailbox: 'INBOX', uids: [Number(row?.uid)], permanent: true });
    const subjects: string[] = [];
    let nextCursor: string | undefined = cursor;
    for (let page = 0; page < 5 && nextCursor; page += 1) {
      const listed = await service.listMessages({
        mailbox: 'INBOX',
        sort,
        limit: 1,
        includeSnippet: false,
        cursor: nextCursor,
      });
      const message = (listed.messages as Array<{ subject: string | null }>)[0];
      if (!message) {
        break;
      }
      subjects.push(String(message.subject));
      nextCursor = listed.nextCursor ? String(listed.nextCursor) : undefined;
    }
    expect(subjects).toEqual(['Mango', 'Banana', 'Apple']);
    const anchor = anchorOf({ uid: 1, subject: 'Zebra' }, { field: 'subject', reverse: true });
    expect(isStrictlyAfter({ uid: 2, subject: 'Mango' }, anchor)).toBe(true);
    expect(isStrictlyAfter({ uid: 3, subject: 'Zebra' }, anchor)).toBe(false);
  });

  it('continues after a still-present UID when an earlier message was expunged', async () => {
    const session = new FakeSession(['IMAP4rev1', 'UIDPLUS']);
    for (const subject of ['Zebra', 'Mango', 'Banana', 'Apple']) {
      await session.append('INBOX', simpleMessage({ subject, messageId: `<${subject}@ex>` }), []);
    }
    const { service } = harness(session, { allowPermanentDelete: true });
    const sort = [{ field: 'subject' as const, reverse: true }];
    const first = await service.listMessages({
      mailbox: 'INBOX',
      sort,
      limit: 2,
      includeSnippet: false,
    });
    const rows = first.messages as Array<{ uid: number; subject: string | null }>;
    expect(rows.map((item) => item.subject)).toEqual(['Zebra', 'Mango']);
    await service.deleteMessages({
      mailbox: 'INBOX',
      uids: [Number(rows[0]?.uid)],
      permanent: true,
    });
    const second = await service.listMessages({
      mailbox: 'INBOX',
      sort,
      limit: 2,
      includeSnippet: false,
      cursor: String(first.nextCursor),
    });
    expect(
      (second.messages as Array<{ subject: string | null }>).map((item) => item.subject),
    ).toEqual(['Banana', 'Apple']);
    expect(second.nextCursor ?? null).toBeNull();
  });
});

describe('sort anchor edges', () => {
  it('rejects a cursor whose anchor is not an object', () => {
    expect(() =>
      decodeCursor(
        Buffer.from(JSON.stringify({ v: 3, position: 0, anchor: 'zebra' }), 'utf8').toString(
          'base64url',
        ),
      ),
    ).toThrow(MailError);
    expect(anchorOf({ uid: 1, size: 12 }, { field: 'size' })).toMatchObject({
      field: 'size',
      value: '12',
    });
    expect(anchorOf({ uid: 1 }, { field: 'arrival', reverse: true }).value).toBe('');
    expect(canonicalSortValue({ uid: 1 }, 'size')).toBe('');
    expect(canonicalSortValue({ uid: 1, from: 'Ada' }, 'from')).toBe('Ada');
    expect(canonicalSortValue({ uid: 1 }, 'subject')).toBe('');
    expect(canonicalSortValue({ uid: 1, date: '2020-01-01T00:00:00.000Z' }, 'date')).toContain(
      '2020',
    );
    expect(
      isStrictlyAfter({ uid: 2, size: 4 }, anchorOf({ uid: 1, size: 9 }, { field: 'size' })),
    ).toBe(false);
    expect(
      isStrictlyAfter(
        { uid: 2, subject: 'Mango' },
        { field: 'subject', reverse: false, value: '' },
      ),
    ).toBe(false);
    expect(
      isStrictlyAfter({ uid: 2, size: 3 }, { field: 'size', reverse: false, value: 'nope' }),
    ).toBe(false);
    expect(
      sortMessages([{ uid: 1 }, { uid: 2, size: 4 }], [{ field: 'size' }]).map((item) => item.uid),
    ).toEqual([2, 1]);
    expect(
      decodeCursor(encodeCursor({ v: 3, position: 1, afterUid: 4 })).uidValidity,
    ).toBeUndefined();
    expect(pageAnchored([1, 2, 3], 1, { position: 0 }).nextCursor).toEqual(expect.any(String));
    expect(pageAnchored([], 1, { position: 0 }).nextCursor).toBeNull();
  });
});

describe('session failure bookkeeping', () => {
  it('kills a live connection once and opens another', async () => {
    const server = new ScriptedImap({ capabilities: ['IMAP4rev1', 'UIDPLUS'] });
    await server.ready();
    const session = new ImapFlowSession(
      account({
        imap: {
          host: '127.0.0.1',
          port: server.port,
          secure: false,
          starttls: 'disabled',
          timeoutMs: 8_000,
          tls: { rejectUnauthorized: false },
        },
      }),
      async () => undefined,
      logger,
    );
    const first = session.connect();
    const second = session.connect();
    await Promise.all([first, second]);
    expect(session.idleBudgetMs()).toBe(8_000);
    expect(session.hasFailed()).toBe(false);
    expect(session.takeLiteralOverflow()).toBe(false);
    let dropped = 0;
    session.bindDisconnect(() => {
      dropped += 1;
    });
    session.kill();
    session.kill();
    expect(dropped).toBe(1);
    expect(session.hasFailed()).toBe(true);
    await session.connect();
    expect(session.hasFailed()).toBe(false);
    expect((await session.listMailboxes()).length).toBeGreaterThan(0);
    await session.logout();
    session.close();
    await server.close();
  });
});

describe('pool idle timer', () => {
  it('cancels eviction when the session is reused and closes a logout that throws', async () => {
    let created = 0;
    const pool = new ImapConnectionPool(
      async () => {
        created += 1;
        return {
          async connect() {
            return undefined;
          },
          async logout() {
            return undefined;
          },
          close() {
            return undefined;
          },
          idleBudgetMs() {
            return 5_000;
          },
        } as unknown as ImapSession;
      },
      1,
      logger,
    );
    expect(await pool.use('a', async () => 'one')).toBe('one');
    expect(await pool.use('a', async () => 'two')).toBe('two');
    expect(created).toBe(1);
    await pool.close();

    let closed = false;
    let handler: (() => void) | undefined;
    let logouts = 0;
    const failing = new ImapConnectionPool(
      async () =>
        ({
          async connect() {
            return undefined;
          },
          async logout() {
            logouts += 1;
            throw new Error('logout failed');
          },
          close() {
            closed = true;
          },
          bindDisconnect(next: () => void) {
            handler = next;
          },
          idleBudgetMs() {
            return 0;
          },
        }) as unknown as ImapSession,
      1,
      logger,
    );
    await failing.use('a', async () => 'held');
    handler?.();
    handler?.();
    await sleep(20);
    expect(logouts).toBe(1);
    expect(closed).toBe(true);
    await failing.close();
  });
});
