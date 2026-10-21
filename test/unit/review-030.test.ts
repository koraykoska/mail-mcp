import { describe, expect, it } from 'vitest';
import { accountSchema, boundedCommandTimeout } from '../../src/config/schema.js';
import { MailError, mapTransportError } from '../../src/errors.js';
import { MailService } from '../../src/service/mail-service.js';
import { runInChunks } from '../../src/service/bulk.js';
import { createLogger } from '../../src/log.js';
import { createRuntime } from '../../src/runtime.js';
import { appConfig } from '../support/config.js';
import { FakeSession } from '../support/fake-session.js';
import { ScriptedImap } from '../support/scripted-imap.js';
import { simpleMessage } from '../fixtures/messages.js';

function runtimeFor(port: number, limits?: { bulkBudgetMs?: number; maxBulk?: number }) {
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
      ...(limits ? { limits: { ...appConfig().limits, ...limits } } : {}),
    }),
    logger: createLogger({ level: 'silent' }),
  });
}

function seed(server: ScriptedImap, count: number): void {
  for (let index = 0; index < count; index += 1) {
    server.addMessage(
      simpleMessage({ subject: `n${index}`, messageId: `<n${index}@example.com>` }).toString(
        'utf8',
      ),
      [],
    );
  }
}

function uids(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

function seen(server: ScriptedImap): number[] {
  return server
    .messagesIn('INBOX')
    .filter((message) => message.flags.includes('\\Seen'))
    .map((message) => message.uid);
}

describe('connection loss during a bulk chunk', () => {
  it('maps a socket drop to CONNECTION_FAILED and resumes that chunk', async () => {
    const dropped = Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
    expect(mapTransportError(dropped).code).toBe('CONNECTION_FAILED');
    const progress = await runInChunks({
      uids: [1, 2, 3],
      budgetMs: 5_000,
      chunkSize: 1,
      onChunk: async (chunk) => {
        if (chunk[0] === 2) {
          throw new MailError('CONNECTION_FAILED', 'The connection to the mail server failed.');
        }
        return chunk.map((uid) => ({ uid, ok: true }));
      },
    });
    expect(progress.stopped).toBe('connection');
    expect(progress.remaining).toEqual([2, 3]);
    expect(progress.results).toEqual([{ uid: 1, ok: true }]);
    expect(progress.complete).toBe(false);
    const idle = await runInChunks({
      uids: [4, 5],
      budgetMs: 0,
      onChunk: async () => {
        throw new Error('a chunk must not start');
      },
    });
    expect(idle.stopped).toBe('budget');
    expect(idle.remaining).toEqual([4, 5]);
    expect(idle.results).toEqual([]);
  });

  it('does not report live UIDs as missing when the socket drops before STORE', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'UIDPLUS'],
      dropMatching: { pattern: /STORE/, nth: 1 },
    });
    await server.ready();
    seed(server, 30);
    const runtime = runtimeFor(server.port);
    const result = await runtime.service.bulk({
      mailbox: 'INBOX',
      uids: uids(30),
      action: 'addFlags',
      flags: ['\\Seen'],
    });
    expect(result.stopped).toBe('connection');
    expect(result.complete).toBe(false);
    expect(result.remaining).toEqual(uids(30));
    expect(result.results).toEqual([]);
    expect(seen(server)).toEqual([]);
    await runtime.close();
    await server.close();
  });

  it('keeps finished chunks and returns the rest when the socket drops after STORE', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'UIDPLUS'],
      dropMatching: { pattern: /STORE/, nth: 1, apply: true },
    });
    await server.ready();
    seed(server, 30);
    const runtime = runtimeFor(server.port);
    const result = await runtime.service.bulk({
      mailbox: 'INBOX',
      uids: uids(30),
      action: 'addFlags',
      flags: ['\\Seen'],
    });
    expect(result.stopped).toBe('connection');
    expect(result.complete).toBe(false);
    expect(result.remaining).toEqual([26, 27, 28, 29, 30]);
    const results = result.results as Array<{ uid: number; ok: boolean; code?: string }>;
    expect(results.map((item) => item.uid)).toEqual(uids(25));
    expect(results.every((item) => item.ok)).toBe(true);
    expect(results.some((item) => item.code === 'NOT_FOUND')).toBe(false);
    expect(seen(server)).toEqual(uids(25));
    await runtime.close();
    await server.close();
  });

  it('puts the in-flight chunk back when the socket drops on the second STORE', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'UIDPLUS'],
      dropMatching: { pattern: /STORE/, nth: 2 },
    });
    await server.ready();
    seed(server, 30);
    const runtime = runtimeFor(server.port);
    const result = await runtime.service.setFlags({
      mailbox: 'INBOX',
      uids: uids(30),
      operation: 'add',
      flags: ['\\Seen'],
    });
    expect(result.stopped).toBe('connection');
    expect(result.remaining).toEqual([26, 27, 28, 29, 30]);
    const results = result.results as Array<{ code?: string; ok: boolean }>;
    expect(results).toHaveLength(25);
    expect(results.some((item) => item.code === 'NOT_FOUND')).toBe(false);
    expect(seen(server)).toEqual(uids(25));
    await runtime.close();
    await server.close();
  });

  it('continues after a real STORE refusal and does not call the UIDs missing', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'UIDPLUS'],
      refuseStore: true,
    });
    await server.ready();
    seed(server, 26);
    const runtime = runtimeFor(server.port);
    const result = await runtime.service.bulk({
      mailbox: 'INBOX',
      uids: uids(26),
      action: 'addFlags',
      flags: ['\\Seen'],
    });
    expect(result.stopped).toBeNull();
    expect(result.complete).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.remaining).toEqual([]);
    const results = result.results as Array<{ code?: string }>;
    expect(results).toHaveLength(26);
    expect(results.every((item) => item.code === 'PROTOCOL_ERROR')).toBe(true);
    expect(seen(server)).toEqual([]);
    await runtime.close();
    await server.close();
  });

  it('stops a move when the socket drops during COPY, after COPYUID, and during EXPUNGE', async () => {
    const duringCopy = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'UIDPLUS'],
      dropMatching: { pattern: /COPY/ },
    });
    await duringCopy.ready();
    seed(duringCopy, 2);
    const copying = runtimeFor(duringCopy.port);
    const copied = await copying.service.copyOrMove(
      { mailbox: 'INBOX', uids: [1, 2], destination: 'Archive' },
      true,
    );
    expect(copied.stopped).toBe('connection');
    expect(copied.remaining).toEqual([1, 2]);
    expect(duringCopy.messagesIn('INBOX')).toHaveLength(2);
    expect(duringCopy.messagesIn('Archive')).toHaveLength(0);
    expect(duringCopy.trace.some((line) => /EXPUNGE/.test(line))).toBe(false);
    await copying.close();
    await duringCopy.close();

    const afterCopy = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'UIDPLUS'],
      dropMatching: { pattern: /COPY/, apply: true },
    });
    await afterCopy.ready();
    seed(afterCopy, 2);
    const moving = runtimeFor(afterCopy.port);
    const moved = await moving.service.copyOrMove(
      { mailbox: 'INBOX', uids: [1, 2], destination: 'Archive' },
      true,
    );
    expect(moved.stopped).toBe('connection');
    expect(moved.remaining).toEqual([1, 2]);
    expect(afterCopy.messagesIn('INBOX')).toHaveLength(2);
    expect(
      afterCopy.messagesIn('Archive').length + afterCopy.messagesIn('INBOX/Archive').length,
      `${afterCopy.copiedPaths().join(',')} :: ${afterCopy.trace.join(' | ')}`,
    ).toBe(2);
    expect(afterCopy.trace.some((line) => /EXPUNGE/.test(line))).toBe(false);
    await moving.close();
    await afterCopy.close();

    const duringExpunge = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'UIDPLUS'],
      dropMatching: { pattern: /EXPUNGE/ },
    });
    await duringExpunge.ready();
    seed(duringExpunge, 2);
    const expunging = runtimeFor(duringExpunge.port);
    const expunged = await expunging.service.copyOrMove(
      { mailbox: 'INBOX', uids: [1, 2], destination: 'Archive' },
      true,
    );
    expect(expunged.stopped).toBe('connection');
    expect(expunged.remaining).toEqual([1, 2]);
    expect(duringExpunge.messagesIn('INBOX')).toHaveLength(2);
    expect(
      duringExpunge.messagesIn('Archive').length + duringExpunge.messagesIn('INBOX/Archive').length,
      `${duringExpunge.copiedPaths().join(',')} :: ${duringExpunge.trace.join(' | ')}`,
    ).toBe(2);
    expect(
      duringExpunge.trace.some((line) => line === 'EXPUNGE' || line.startsWith('EXPUNGE ')),
    ).toBe(false);
    await expunging.close();
    await duringExpunge.close();
  });

  it('stops a permanent delete when UID EXPUNGE drops', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'UIDPLUS'],
      dropMatching: { pattern: /EXPUNGE/ },
    });
    await server.ready();
    seed(server, 2);
    const runtime = runtimeFor(server.port);
    const result = await runtime.service.deleteMessages({
      mailbox: 'INBOX',
      uids: [1, 2],
      permanent: true,
    });
    expect(result.stopped).toBe('connection');
    expect(result.remaining).toEqual([1, 2]);
    expect(server.messagesIn('INBOX')).toHaveLength(2);
    expect(server.trace.some((line) => line === 'EXPUNGE' || line.startsWith('EXPUNGE '))).toBe(
      false,
    );
    await runtime.close();
    await server.close();
  });

  it('returns modify-by-search matches when the socket drops during STORE', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'UIDPLUS'],
      dropMatching: { pattern: /STORE/, nth: 2 },
    });
    await server.ready();
    seed(server, 26);
    const runtime = runtimeFor(server.port);
    const result = await runtime.service.modifyBySearch({
      mailbox: 'INBOX',
      search: { all: true },
      action: 'addFlags',
      flags: ['\\Seen'],
      dryRun: false,
    });
    expect(result.stopped).toBe('connection');
    expect(result.complete).toBe(false);
    expect(result.remaining).toEqual([{ mailbox: 'INBOX', uid: 26 }]);
    const results = result.results as Array<{ code?: string }>;
    expect(results.some((item) => item.code === 'NOT_FOUND')).toBe(false);
    expect(seen(server)).toEqual(uids(25));
    await runtime.close();
    await server.close();
  });
});

describe('IMAP4rev2 move and UIDPLUS', () => {
  it('does not treat a bare IMAP4rev2 token as MOVE', () => {
    const session = new FakeSession(['IMAP4rev1', 'IMAP4rev2']);
    expect(session.moveSupported()).toBe(false);
    expect(session.uidPlusSupported()).toBe(false);
  });

  it('moves with UID MOVE after ENABLE IMAP4REV2', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'IMAP4rev2', 'ENABLE'],
    });
    await server.ready();
    seed(server, 1);
    const runtime = runtimeFor(server.port);
    const moved = await runtime.service.copyOrMove(
      { mailbox: 'INBOX', uids: [1], destination: 'Archive' },
      true,
    );
    expect(moved.ok).toBe(true);
    expect(moved.stopped).toBeNull();
    expect(server.messagesIn('INBOX')).toHaveLength(0);
    expect(
      server.messagesIn('Archive').length + server.messagesIn('INBOX/Archive').length,
      `${server.copiedPaths().join(',')} :: ${server.trace.join(' | ')}`,
    ).toBe(1);
    expect(server.trace.some((line) => /MOVE/.test(line))).toBe(true);
    expect(server.trace.some((line) => /EXPUNGE/.test(line))).toBe(false);
    await runtime.close();
    await server.close();
  });

  it('refuses a move when IMAP4rev2 is advertised beside IMAP4rev1 and ENABLE skips it', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'IMAP4rev2', 'ENABLE'],
      omitEnabled: ['IMAP4rev2'],
    });
    await server.ready();
    seed(server, 1);
    const runtime = runtimeFor(server.port);
    await expect(
      runtime.service.copyOrMove({ mailbox: 'INBOX', uids: [1], destination: 'Archive' }, true),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(server.messagesIn('INBOX')).toHaveLength(1);
    expect(server.trace.some((line) => /\b(COPY|MOVE|EXPUNGE)\b/.test(line))).toBe(false);
    await runtime.close();
    await server.close();
  });

  it('moves on a rev2-only session without a separate MOVE token', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev2', 'ENABLE'],
    });
    await server.ready();
    seed(server, 1);
    const runtime = runtimeFor(server.port);
    const moved = await runtime.service.copyOrMove(
      { mailbox: 'INBOX', uids: [1], destination: 'Archive' },
      true,
    );
    expect(moved.ok).toBe(true);
    expect(server.messagesIn('INBOX')).toHaveLength(0);
    expect(server.messagesIn('Archive').length + server.messagesIn('INBOX/Archive').length).toBe(1);
    expect(server.trace.some((line) => /MOVE/.test(line))).toBe(true);
    expect(server.trace.some((line) => /EXPUNGE/.test(line))).toBe(false);
    await runtime.close();
    await server.close();
  });
});

describe('ESEARCH star and the bulk budget', () => {
  it('resolves an ESEARCH ALL set that contains *', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'ESEARCH', 'UIDPLUS'],
      esearchAllStar: true,
    });
    await server.ready();
    seed(server, 3);
    const runtime = runtimeFor(server.port);
    const found = await runtime.service.searchMessages({
      mailbox: 'INBOX',
      search: { not: { uid: '2' } },
      limit: 10,
      includeSnippet: false,
    });
    const messages = found.messages as Array<{ uid: number }>;
    expect(messages.map((item) => item.uid).sort((left, right) => left - right)).toEqual([1, 3]);
    const searches = server.trace.filter((line) => /SEARCH/.test(line));
    expect(searches.some((line) => /RETURN/i.test(line))).toBe(true);
    expect(searches.some((line) => !/RETURN/i.test(line))).toBe(true);
    await runtime.close();
    await server.close();
  });

  it('keeps a bare ESEARCH star from naming an expunged UID', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'ESEARCH', 'UIDPLUS'],
      esearchAll: (_args, uids) => {
        if (uids.length === 1 && uids[0] === 2) {
          return '*';
        }
        if (uids.length === 2) {
          return '1,*';
        }
        return undefined;
      },
    });
    await server.ready();
    seed(server, 3);
    server.dropUid(3);
    const runtime = runtimeFor(server.port);
    const positive = await runtime.service.searchMessages({
      mailbox: 'INBOX',
      search: { uid: '2' },
      limit: 10,
      includeSnippet: false,
    });
    expect((positive.messages as Array<{ uid: number }>).map((item) => item.uid)).toEqual([2]);
    const excluded = await runtime.service.searchMessages({
      mailbox: 'INBOX',
      search: { not: { uid: '2' } },
      limit: 10,
      includeSnippet: false,
    });
    expect(
      (excluded.messages as Array<{ uid: number }>)
        .map((item) => item.uid)
        .sort((left, right) => left - right),
    ).toEqual([1]);
    const moved = await runtime.service.modifyBySearch({
      mailbox: 'INBOX',
      search: { not: { uid: '2' } },
      action: 'move',
      destination: 'Archive',
      dryRun: false,
    });
    expect(moved.ok).toBe(true);
    expect(server.messagesIn('INBOX').map((item) => item.uid)).toEqual([2]);
    const acted = server.trace.filter((line) => /FETCH|COPY|MOVE|EXPUNGE/.test(line));
    expect(acted.some((line) => /(^|[^0-9])3([^0-9]|$)/.test(line))).toBe(false);
    await runtime.close();
    await server.close();
  });

  it('does not widen an inverted ESEARCH star from a stale UIDNEXT', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'ESEARCH', 'UIDPLUS'],
      selectUidNext: 5,
      esearchAll: (_args, uids) => (uids.join(',') === '8,9,10' ? '8:*' : undefined),
    });
    await server.ready();
    seed(server, 10);
    const runtime = runtimeFor(server.port);
    const found = await runtime.service.searchMessages({
      mailbox: 'INBOX',
      search: { uid: '8:10' },
      limit: 10,
      includeSnippet: false,
    });
    expect(
      (found.messages as Array<{ uid: number }>)
        .map((item) => item.uid)
        .sort((left, right) => left - right),
    ).toEqual([8, 9, 10]);
    const moved = await runtime.service.modifyBySearch({
      mailbox: 'INBOX',
      search: { uid: '8:10' },
      action: 'move',
      destination: 'Archive',
      dryRun: false,
    });
    expect(moved.stopped).toBeNull();
    expect(server.messagesIn('INBOX').map((item) => item.uid)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(server.trace.some((line) => /8:4/.test(line))).toBe(false);
    await runtime.close();
    await server.close();
  });

  it('does not use a search result when a message arrives while * is resolved', async () => {
    let late = 0;
    let arrive = (): string => '';
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'ESEARCH', 'UIDPLUS'],
      esearchAllStar: true,
      beforePlainSearch: () => arrive(),
    });
    arrive = () => {
      late += 1;
      server.addMessage(
        simpleMessage({
          subject: `late ${late}`,
          messageId: `<late-${late}@example.com>`,
        }).toString('utf8'),
        [],
      );
      return `* ${server.messagesIn('INBOX').length} EXISTS\r\n`;
    };
    await server.ready();
    seed(server, 3);
    const runtime = runtimeFor(server.port);
    await expect(
      runtime.service.searchMessages({
        mailbox: 'INBOX',
        search: { all: true },
        limit: 10,
        includeSnippet: false,
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    await expect(
      runtime.service.modifyBySearch({
        mailbox: 'INBOX',
        search: { all: true },
        action: 'move',
        destination: 'Archive',
        dryRun: false,
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    expect(server.messagesIn('INBOX').length).toBeGreaterThan(3);
    expect(server.trace.some((line) => /\b(COPY|MOVE|EXPUNGE)\b/.test(line))).toBe(false);
    await runtime.close();
    await server.close();
  });

  it('fails closed when a plain search still answers with *', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'ESEARCH', 'UIDPLUS'],
      esearchAll: () => '*',
      plainSearchStar: true,
    });
    await server.ready();
    seed(server, 2);
    const runtime = runtimeFor(server.port);
    await expect(
      runtime.service.modifyBySearch({
        mailbox: 'INBOX',
        search: { all: true },
        action: 'move',
        destination: 'Archive',
        dryRun: false,
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    expect(server.messagesIn('INBOX')).toHaveLength(2);
    expect(server.trace.some((line) => /\b(COPY|MOVE|EXPUNGE|FETCH)\b/.test(line))).toBe(false);
    await runtime.close();
    await server.close();
  });

  it('returns every UID when the budget elapses before a chunk starts', async () => {
    const session = new FakeSession();
    await session.append('INBOX', simpleMessage({ subject: 'One' }), []);
    await session.append('INBOX', simpleMessage({ subject: 'Two', messageId: '<two@ex>' }), []);
    const config = appConfig({ limits: { ...appConfig().limits, bulkBudgetMs: 30 } });
    const slow = new MailService({
      config,
      pool: {
        async use<T>(_id: string, fn: (value: FakeSession) => Promise<T>): Promise<T> {
          await new Promise((resolve) => setTimeout(resolve, 80));
          await session.connect();
          return fn(session);
        },
        async close(): Promise<void> {
          await session.logout();
        },
      },
      smtpFactory: async () => {
        throw new Error('SMTP is not used in this test');
      },
      logger: createLogger({ level: 'silent' }),
    });
    const waited = await slow.setFlags({
      mailbox: 'INBOX',
      uids: [1, 2],
      operation: 'add',
      flags: ['\\Seen'],
    });
    expect(waited.stopped).toBe('budget');
    expect(waited.complete).toBe(false);
    expect(waited.remaining).toEqual([1, 2]);
    expect(waited.results).toEqual([]);
    expect(
      session.boxes.get('INBOX')?.messages.every((message) => message.flags.length === 0),
    ).toBe(true);

    const stalled = new MailService({
      config,
      pool: {
        async use(): Promise<never> {
          throw new MailError('TIMEOUT', 'Timed out waiting for a free IMAP connection.');
        },
        async close(): Promise<void> {
          return undefined;
        },
      },
      smtpFactory: async () => {
        throw new Error('SMTP is not used in this test');
      },
      logger: createLogger({ level: 'silent' }),
    });
    const acquired = await stalled.bulk({
      mailbox: 'INBOX',
      uids: [1, 2],
      action: 'addFlags',
      flags: ['\\Seen'],
    });
    expect(acquired.stopped).toBe('budget');
    expect(acquired.remaining).toEqual([1, 2]);
    expect(acquired.complete).toBe(false);
  });

  it('counts the modify-by-search scan against the budget', async () => {
    const session = new FakeSession(['IMAP4rev1', 'UIDPLUS']);
    session.latencyMs = 80;
    await session.append('INBOX', simpleMessage({ subject: 'One' }), []);
    await session.append('Sent', simpleMessage({ subject: 'Two', messageId: '<two@ex>' }), []);
    const config = appConfig({ limits: { ...appConfig().limits, bulkBudgetMs: 40 } });
    const mail = new MailService({
      config,
      pool: {
        async use<T>(_id: string, fn: (value: FakeSession) => Promise<T>): Promise<T> {
          await session.connect();
          return fn(session);
        },
        async close(): Promise<void> {
          await session.logout();
        },
      },
      smtpFactory: async () => {
        throw new Error('SMTP is not used in this test');
      },
      logger: createLogger({ level: 'silent' }),
    });
    const result = await mail.modifyBySearch({
      folders: ['INBOX', 'Sent'],
      search: { all: true },
      action: 'addFlags',
      flags: ['\\Seen'],
      dryRun: false,
    });
    expect(result.stopped).toBe('budget');
    expect(result.complete).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.remaining).toEqual([]);
    const flagged = (path: string): number =>
      session.boxes.get(path)?.messages.filter((message) => message.flags.includes('\\Seen'))
        .length ?? 0;
    expect(flagged('INBOX') + flagged('Sent')).toBe(0);
  });
});

describe('connect closes and the command budget', () => {
  it('maps a close during the greeting or login to CONNECTION_FAILED', () => {
    const closed = Object.assign(new Error('Unexpected close'), { code: 'ClosedAfterConnectText' });
    expect(mapTransportError(closed).code).toBe('CONNECTION_FAILED');
    expect(mapTransportError(new Error('Socket closed')).code).toBe('CONNECTION_FAILED');
    expect(
      mapTransportError({
        message: 'Unexpected close',
        code: 'ClosedAfterConnectText',
        responseStatus: 'NO',
        responseText: 'System error',
      }).code,
    ).toBe('PROTOCOL_ERROR');
    expect(
      mapTransportError({
        message: 'Command failed',
        responseStatus: 'BAD',
        responseText: 'Invalid command',
      }).code,
    ).toBe('PROTOCOL_ERROR');
  });

  it('reports a greeting close as CONNECTION_FAILED', async () => {
    const server = new ScriptedImap({ closeAfterGreeting: true });
    await server.ready();
    const runtime = runtimeFor(server.port);
    await expect(runtime.service.capabilities()).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    });
    await runtime.close();
    await server.close();
  });

  it('rejects a command timeout that can outlast a 60 second client', () => {
    expect(boundedCommandTimeout(30_000)).toBe(30_000);
    expect(boundedCommandTimeout(120_000)).toBe(50_000);
    expect(() =>
      accountSchema.parse({
        email: 'user@example.com',
        imap: { host: '127.0.0.1', timeoutMs: 60_000 },
      }),
    ).toThrow(/50000/);
    const parsed = accountSchema.parse({
      email: 'user@example.com',
      imap: { host: '127.0.0.1', timeoutMs: 30_000 },
    });
    expect(parsed.imap?.timeoutMs).toBe(30_000);
  });
});
