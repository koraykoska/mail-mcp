import { describe, expect, it } from 'vitest';
import { MailError, mapTransportError } from '../../src/errors.js';
import {
  andSearchQuery,
  andSearchUid,
  compileSearch,
  mentionsUidOrSeq,
} from '../../src/imap/search.js';
import { MailService } from '../../src/service/mail-service.js';
import { runInChunks } from '../../src/service/bulk.js';
import { createLogger } from '../../src/log.js';
import { createRuntime } from '../../src/runtime.js';
import { appConfig } from '../support/config.js';
import { FakePool, FakeSession, icloudSearchFault } from '../support/fake-session.js';
import { ScriptedImap } from '../support/scripted-imap.js';
import { simpleMessage } from '../fixtures/messages.js';
import { runWithRequest } from '../../src/request-context.js';

function mailFor(session: FakeSession, limits?: { bulkBudgetMs?: number; maxBulk?: number }) {
  const config = appConfig(limits ? { limits: { ...appConfig().limits, ...limits } } : {});
  const mail = new MailService({
    config,
    pool: new FakePool(session) as never,
    smtpFactory: async () => {
      throw new Error('SMTP is not used in this test');
    },
    logger: createLogger({ level: 'silent' }),
  });
  return mail;
}

function raw(from: string, subject: string): Buffer {
  return Buffer.from(`From: ${from}\r\nSubject: ${subject}\r\n\r\nHello\r\n`);
}

function queriesHaveNotUid(queries: Record<string, unknown>[]): boolean {
  return queries.some((query) => mentionsUidOrSeq(query.not));
}

describe('search compilation', () => {
  it('juxtaposes AND and never negates a UID or sequence set', () => {
    expect(compileSearch({ uid: '8848' }).query).toEqual({ uid: '8848' });
    expect(compileSearch({ from: 'apple.com', uid: '1:*' }).query).toEqual({
      from: 'apple.com',
      uid: '1:*',
    });
    expect(compileSearch({ from: 'apple.com', seen: false }).query).toEqual({
      from: 'apple.com',
      seen: false,
    });
    expect(andSearchUid({ query: { from: 'ada' }, requires: [] }, '1:4').query).toEqual({
      from: 'ada',
      uid: '1:4',
    });
    expect(andSearchQuery({ query: { from: 'ada' }, requires: [] }, { seen: false }).query).toEqual(
      { from: 'ada', seen: false },
    );
    const negated = compileSearch({ not: { uid: '8848' } }).query;
    expect(negated.$complement).toEqual({ uid: '8848' });
    expect(negated.not).toBeUndefined();
    const mixed = compileSearch({ not: { from: 'apple.com', seen: true } }).query;
    expect(mixed.$complement).toBeTruthy();
    expect(JSON.stringify(compileSearch({ from: 'a', uid: '1', seq: '2' }).query)).not.toContain(
      '"not"',
    );
  });

  it('passes the server NO text through', () => {
    const error = new Error('Command failed') as Error & {
      responseStatus: string;
      responseText: string;
    };
    error.responseStatus = 'NO';
    error.responseText = '[UNAVAILABLE] Unexpected exception';
    const mapped = mapTransportError(error);
    expect(mapped.code).toBe('PROTOCOL_ERROR');
    expect(mapped.message).toContain('NO [UNAVAILABLE] Unexpected exception');
    expect(mapped.message).not.toContain('Command failed');
  });
});

describe('iCloud search emulation', () => {
  it('returns the UID that was asked for, including NOT UID and text plus flags', async () => {
    const session = new FakeSession();
    session.emulateIcloud = true;
    await session.append('INBOX', raw('ada@example.com', 'Ada'), []);
    await session.append('INBOX', raw('bea@example.com', 'Bea'), ['\\Seen']);
    const mail = mailFor(session);

    const byUid = await mail.searchMessages({
      mailbox: 'INBOX',
      search: { uid: '2' },
      limit: 10,
      includeSnippet: false,
    });
    expect(byUid.total).toBe(1);
    expect((byUid.messages as Array<{ uid: number }>)[0]?.uid).toBe(2);

    const both = await mail.searchMessages({
      mailbox: 'INBOX',
      search: { from: 'ada', uid: '1' },
      limit: 10,
      includeSnippet: false,
    });
    expect(both.total).toBe(1);

    const unseen = await mail.searchMessages({
      mailbox: 'INBOX',
      search: { from: 'bea', seen: false },
      limit: 10,
      includeSnippet: false,
    });
    expect(unseen.total).toBe(0);

    const complement = await mail.searchMessages({
      mailbox: 'INBOX',
      search: { not: { uid: '1' } },
      limit: 10,
      includeSnippet: false,
    });
    expect(complement.total).toBe(1);
    expect((complement.messages as Array<{ uid: number }>)[0]?.uid).toBe(2);
    expect(queriesHaveNotUid(session.searchLog)).toBe(false);

    const direct = await session.withMailbox('INBOX', 'read', (box) =>
      box.search({ query: { not: { uid: '1' } }, requires: [] }),
    );
    expect(direct).toEqual([]);
    expect(
      icloudSearchFault({ not: { or: [{ not: { from: 'a' } }, { not: { uid: '1' } }] } }),
    ).toBe('unavailable');
  });
});

describe('bulk chunks', () => {
  it('stops between chunks when the time budget elapses and reports the rest', async () => {
    const session = new FakeSession();
    session.latencyMs = 80;
    for (let index = 0; index < 30; index += 1) {
      await session.append('INBOX', raw('ada@example.com', `n${index}`), []);
    }
    const mail = mailFor(session, { bulkBudgetMs: 40 });
    const result = await mail.bulk({
      mailbox: 'INBOX',
      uids: Array.from({ length: 30 }, (_, index) => index + 1),
      action: 'addFlags',
      flags: ['\\Seen'],
    });
    expect(result.complete).toBe(false);
    expect(result.stopped).toBe('budget');
    expect(result.ok).toBe(false);
    const results = result.results as Array<{ uid: number; ok: boolean }>;
    expect(results).toHaveLength(25);
    expect(results.every((item) => item.ok)).toBe(true);
    expect(result.remaining).toEqual([26, 27, 28, 29, 30]);
    const inbox = session.boxes.get('INBOX')?.messages ?? [];
    expect(
      inbox.filter((message) => message.flags.includes('\\Seen')).map((message) => message.uid),
    ).toEqual(results.map((item) => item.uid));
    expect(inbox.filter((message) => !message.flags.includes('\\Seen'))).toHaveLength(5);
  });

  it('puts a timed-out chunk back into remaining', async () => {
    const session = new FakeSession();
    let commands = 0;
    session.afterCommand = () => {
      commands += 1;
      if (commands >= 2) {
        throw new MailError('TIMEOUT', 'The mail server did not respond in time.');
      }
    };
    for (let index = 0; index < 30; index += 1) {
      await session.append('INBOX', raw('ada@example.com', `n${index}`), []);
    }
    const mail = mailFor(session, { bulkBudgetMs: 20_000 });
    const result = await mail.bulk({
      mailbox: 'INBOX',
      uids: Array.from({ length: 30 }, (_, index) => index + 1),
      action: 'addFlags',
      flags: ['\\Seen'],
    });
    expect(result.stopped).toBe('budget');
    expect(result.complete).toBe(false);
    expect(result.remaining).toEqual([26, 27, 28, 29, 30]);
    const inbox = session.boxes.get('INBOX')?.messages ?? [];
    expect(inbox.filter((message) => message.flags.includes('\\Seen'))).toHaveLength(25);
    expect(inbox.filter((message) => !message.flags.includes('\\Seen'))).toHaveLength(5);
  });

  it('keeps going after a chunk reports per-UID failures', async () => {
    const session = new FakeSession();
    let commands = 0;
    session.afterCommand = () => {
      commands += 1;
      if (commands >= 2) {
        throw new MailError('PROTOCOL_ERROR', 'The server rejected the flag update.');
      }
    };
    for (let index = 0; index < 60; index += 1) {
      await session.append('INBOX', raw('ada@example.com', `n${index}`), []);
    }
    const mail = mailFor(session, { bulkBudgetMs: 20_000, maxBulk: 60 });
    const result = await mail.bulk({
      mailbox: 'INBOX',
      uids: Array.from({ length: 60 }, (_, index) => index + 1),
      action: 'addFlags',
      flags: ['\\Seen'],
    });
    expect(result.stopped).toBeNull();
    expect(result.complete).toBe(true);
    expect(result.ok).toBe(false);
    const results = result.results as Array<{ uid: number; ok: boolean; code?: string }>;
    expect(results.filter((item) => item.ok)).toHaveLength(25);
    expect(results.filter((item) => item.code === 'PROTOCOL_ERROR')).toHaveLength(35);
    expect(result.remaining).toEqual([]);
    const inbox = session.boxes.get('INBOX')?.messages ?? [];
    expect(inbox.filter((message) => message.flags.includes('\\Seen'))).toHaveLength(25);
  });

  it('stops after a thrown chunk once some UIDs have succeeded', async () => {
    const progress = await runInChunks({
      uids: [1, 2, 3],
      budgetMs: 20_000,
      chunkSize: 1,
      onChunk: async (uids) => {
        const uid = uids[0];
        if (uid === 2) {
          throw new MailError('PROTOCOL_ERROR', 'The server rejected the flag update.');
        }
        return uids.map((item) => ({ uid: item, ok: true }));
      },
    });
    expect(progress.results).toEqual([
      { uid: 1, ok: true },
      {
        uid: 2,
        ok: false,
        code: 'PROTOCOL_ERROR',
        message: 'The server rejected the flag update.',
      },
    ]);
    expect(progress.remaining).toEqual([3]);
    expect(progress.complete).toBe(false);
    expect(progress.stopped).toBeNull();
    await expect(
      runInChunks({
        uids: [1],
        budgetMs: 20_000,
        onChunk: async () => {
          throw new MailError('PROTOCOL_ERROR', 'The server rejected the flag update.');
        },
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('stops between chunks when the request is cancelled', async () => {
    const session = new FakeSession();
    session.latencyMs = 20;
    for (let index = 0; index < 30; index += 1) {
      await session.append('INBOX', raw('ada@example.com', `n${index}`), []);
    }
    const mail = mailFor(session, { bulkBudgetMs: 20_000 });
    const controller = new AbortController();
    session.afterCommand = () => controller.abort();
    const result = await runWithRequest(controller.signal, () =>
      mail.bulk({
        mailbox: 'INBOX',
        uids: Array.from({ length: 30 }, (_, index) => index + 1),
        action: 'addFlags',
        flags: ['\\Seen'],
      }),
    );
    expect(result.stopped).toBe('cancelled');
    expect(result.complete).toBe(false);
    expect(result.remaining).toEqual([26, 27, 28, 29, 30]);
  });

  it('leaves the original in place when COPYUID is missing', async () => {
    const session = new FakeSession(['IMAP4rev1', 'UIDPLUS']);
    session.suppressCopyUid = true;
    await session.append('INBOX', raw('ada@example.com', 'One'), []);
    await session.append('INBOX', raw('bea@example.com', 'Two'), []);
    const mail = mailFor(session);
    const moved = await mail.copyOrMove(
      { mailbox: 'INBOX', uids: [1, 2], destination: 'Archive' },
      true,
    );
    expect(moved.complete).toBe(true);
    expect(moved.remaining).toEqual([]);
    expect(moved.ok).toBe(false);
    const results = moved.results as Array<{ uid: number; ok: boolean; message?: string }>;
    expect(results.every((item) => item.ok === false)).toBe(true);
    expect(results[0]?.message).toContain('COPYUID');
    expect(session.boxes.get('INBOX')?.messages.map((message) => message.uid)).toEqual([1, 2]);
    expect(session.boxes.get('Archive')?.messages).toHaveLength(2);
  });
});

describe('scripted iCloud', () => {
  it('does not send NOT UID, and expunges only a confirmed copy', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'UIDPLUS', 'ESEARCH'],
      icloud: true,
    });
    await server.ready();
    server.addMessage(
      simpleMessage({ from: 'ada@example.com', subject: 'Ada' }).toString('utf8'),
      [],
    );
    server.addMessage(
      simpleMessage({ from: 'bea@example.com', subject: 'Bea' }).toString('utf8'),
      [],
    );
    const runtime = runtimeFor(server.port);
    const found = await runtime.service.searchMessages({
      mailbox: 'INBOX',
      search: { from: 'ada@example.com', uid: '1' },
      limit: 10,
      includeSnippet: false,
    });
    expect(found.total).toBe(1);
    const rest = await runtime.service.searchMessages({
      mailbox: 'INBOX',
      search: { not: { uid: '1' } },
      limit: 10,
      includeSnippet: false,
    });
    expect(rest.total).toBe(1);
    expect((rest.messages as Array<{ uid: number }>)[0]?.uid).toBe(2);
    const trace = server.trace.join('\n');
    expect(trace).not.toMatch(/NOT\s+UID/i);
    expect(trace).not.toMatch(/NOT OR NOT/i);
    const moved = await runtime.service.copyOrMove(
      { mailbox: 'INBOX', uids: [1, 2], destination: 'Archive' },
      true,
    );
    expect(moved.ok).toBe(true);
    expect(server.messagesIn('INBOX')).toHaveLength(0);
    expect(server.trace.some((line) => /COPY/.test(line) && /1:2|1,2/.test(line))).toBe(true);
    await runtime.close();
    await server.close();
  });

  it('does not expunge when the server omits COPYUID', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'UIDPLUS'],
      omitCopyUid: true,
    });
    await server.ready();
    server.addMessage(simpleMessage({ subject: 'stay' }).toString('utf8'), []);
    server.addMessage(simpleMessage({ subject: 'also' }).toString('utf8'), []);
    const runtime = runtimeFor(server.port);
    const moved = await runtime.service.copyOrMove(
      { mailbox: 'INBOX', uids: [1, 2], destination: 'Archive' },
      true,
    );
    expect(moved.ok).toBe(false);
    expect(server.messagesIn('INBOX')).toHaveLength(2);
    expect(server.messagesIn('Archive').length + server.messagesIn('INBOX/Archive').length).toBe(2);
    expect(server.trace.some((line) => line.startsWith('EXPUNGE') || /EXPUNGE/.test(line))).toBe(
      false,
    );
    await runtime.close();
    await server.close();
  });
});

function runtimeFor(port: number) {
  return createRuntime({
    config: appConfig({
      imap: {
        host: '127.0.0.1',
        port,
        secure: false,
        starttls: 'disabled',
        timeoutMs: 8_000,
        tls: { rejectUnauthorized: false },
      },
      allowDelete: true,
      allowPermanentDelete: true,
      appendSent: false,
    }),
    logger: createLogger({ level: 'silent' }),
  });
}
