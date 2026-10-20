import { readFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import { startHttpServer } from '../../src/http.js';
import { ImapConnectionPool } from '../../src/imap/pool.js';
import type { ImapSession } from '../../src/imap/session.js';
import { createLogger } from '../../src/log.js';
import { htmlToSafeText, sanitizeHtml } from '../../src/mime/html.js';
import { encodeCursor, pageAfterUid } from '../../src/pagination.js';
import { createRuntime } from '../../src/runtime.js';
import { MailService } from '../../src/service/mail-service.js';
import type { SmtpSender } from '../../src/smtp/client.js';
import { createSmtpSender } from '../../src/smtp/client.js';
import { simpleMessage } from '../fixtures/messages.js';
import { account, appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';
import { ScriptedImap } from '../support/scripted-imap.js';

const certDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/certs');

function harness(session = new FakeSession(), overrides: Parameters<typeof appConfig>[0] = {}) {
  const sent: string[] = [];
  const smtp: SmtpSender = {
    async verify() {
      return undefined;
    },
    async send(input) {
      sent.push(input.raw.toString('utf8'));
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
    logger: createLogger({ level: 'silent', secrets: config.secrets }),
  });
  return { service, session, sent };
}

describe('HTML allow-list', () => {
  const bypasses = [
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href="javascript&#58;alert(1)">x</a>',
    '<a href="javascript&colon;alert(1)">x</a>',
    '<a href="&#100;ata:text/html,hi">x</a>',
    '<a href="&#x64;ata:text/html,hi">x</a>',
    '<a href="&#118;bscript:msg">x</a>',
    '<img srcset="javascript:alert(1)">',
    '<svg/onload=alert(1)>',
    '<object data="javascript:alert(1)">',
    '<div style="background:url(javascript:alert(1))">x</div>',
    '<style>body{background:url(javascript:alert(1))}</style>Hi',
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    '<form action="javascript:alert(1)"><button formaction="javascript:alert(1)">x</button></form>',
    '<img/src="javascript:alert(1)">',
    '<a href="java&#9;script:alert(1)">x</a>',
    '<embed src="javascript:alert(1)">',
    '<iframe src="javascript:alert(1)"></iframe>',
  ];

  it('drops every encoded or markup bypass and keeps prose', () => {
    for (const sample of bypasses) {
      const clean = sanitizeHtml(sample);
      expect(clean.toLowerCase()).not.toMatch(/javascript\s*:/);
      expect(clean.toLowerCase()).not.toMatch(/vbscript\s*:/);
      expect(clean.toLowerCase()).not.toMatch(/data\s*:/);
      expect(clean.toLowerCase()).not.toMatch(/\bon[a-z]+=/);
      expect(clean.toLowerCase()).not.toContain('srcset');
      expect(clean.toLowerCase()).not.toContain('http-equiv');
      expect(clean.toLowerCase()).not.toContain('formaction');
      expect(clean.toLowerCase()).not.toContain('<script');
      expect(clean.toLowerCase()).not.toContain('<object');
      expect(clean.toLowerCase()).not.toContain('<svg');
      expect(clean.toLowerCase()).not.toContain('<meta');
      expect(clean.toLowerCase()).not.toContain('<form');
      expect(clean.toLowerCase()).not.toContain('<style');
    }
    expect(sanitizeHtml('<p>See data: files</p>')).toContain('data:');
    expect(htmlToSafeText('<p>See data: files</p>')).toContain('data:');
    const slashed = sanitizeHtml('<img/src=x/onerror=alert(1)>');
    expect(slashed.toLowerCase()).not.toMatch(/\sonerror\s*=/);
    expect(slashed.toLowerCase()).not.toMatch(/javascript\s*:/);
    expect(slashed).toBe('<img src="x/onerror=alert(1)" />');
    expect(sanitizeHtml('<img src="x" onerror="alert(1)">').toLowerCase()).not.toMatch(
      /\sonerror\s*=/,
    );
    expect(sanitizeHtml('<a href="https://example.com">ok</a>')).toContain('https://example.com');
    expect(sanitizeHtml('<a href="mailto:a@b.c">m</a>')).toContain('mailto:a@b.c');
    expect(sanitizeHtml('<a href="cid:part1">c</a>')).toContain('cid:part1');
  });

  it('sanitizes a text/html part', async () => {
    const session = new FakeSession();
    await session.append('INBOX', simpleMessage({ text: 'plain' }), []);
    session.partBodies.set('1', {
      content: Buffer.from('<a href="&#106;avascript:alert(1)">x</a><p>See data: files</p>'),
      contentType: 'text/html',
    });
    const { service } = harness(session);
    const part = await service.getPart({ mailbox: 'INBOX', uid: 1, partId: '1' });
    const text = String(part.text);
    expect(text.toLowerCase()).not.toMatch(/javascript\s*:/);
    expect(text).toContain('data:');
  });
});

describe('per-UID labels, size cap, flags, and cursors', () => {
  it('returns a row per label UID and does not claim a missing one', async () => {
    const session = new FakeSession(['IMAP4rev1', 'X-GM-EXT-1', 'UIDPLUS']);
    await session.append('INBOX', simpleMessage(), []);
    const { service } = harness(session);
    const result = await service.setLabels({
      mailbox: 'INBOX',
      uids: [1, 999999],
      labels: ['Work'],
      operation: 'add',
    });
    expect(result.ok).toBe(false);
    expect(result.uids).toEqual([1]);
    const rows = result.results as Array<{ uid: number; ok: boolean; code?: string }>;
    expect(rows).toEqual([
      { uid: 1, ok: true },
      expect.objectContaining({ uid: 999999, ok: false, code: 'NOT_FOUND' }),
    ]);
  });

  it('rejects an understated SIZE on get, reply, and forward', async () => {
    const session = new FakeSession();
    await session.append('INBOX', Buffer.from(`Subject: big\r\n\r\n${'x'.repeat(80)}`), []);
    const stored = session.boxes.get('INBOX')?.messages[0];
    if (!stored) {
      throw new Error('missing message');
    }
    stored.size = 4;
    const limits = { ...account().limits, maxMessageBytes: 40 };
    const { service, sent } = harness(session, { limits });
    await expect(service.getMessage({ mailbox: 'INBOX', uid: stored.uid })).rejects.toMatchObject({
      code: 'SIZE_LIMIT',
    });
    await expect(
      service.reply({ mailbox: 'INBOX', uid: stored.uid, text: 're' }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    await expect(
      service.forward({ mailbox: 'INBOX', uid: stored.uid, to: ['ada@example.com'] }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    expect(sent).toHaveLength(0);
  });

  it('requires delete permission when set would clear \\Deleted', async () => {
    const session = new FakeSession();
    await session.append('INBOX', simpleMessage(), ['\\Deleted', '\\Seen']);
    const { service } = harness(session, { allowDelete: false });
    await expect(
      service.setFlags({
        mailbox: 'INBOX',
        uids: [1],
        flags: ['\\Seen'],
        operation: 'set',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(session.boxes.get('INBOX')?.messages[0]?.flags).toContain('\\Deleted');
    const clean = new FakeSession();
    await clean.append('INBOX', simpleMessage(), ['\\Seen']);
    const allowed = harness(clean, { allowDelete: false });
    const updated = await allowed.service.setFlags({
      mailbox: 'INBOX',
      uids: [1],
      flags: ['\\Flagged'],
      operation: 'set',
    });
    expect(updated.ok).toBe(true);
    expect(clean.boxes.get('INBOX')?.messages[0]?.flags).toEqual(['\\Flagged']);
  });

  it('fails a cursor whose UID has vanished', () => {
    expect(() => pageAfterUid([4, 3, 2], 2, 9, '1')).toThrow(MailError);
    const cursor = encodeCursor({ v: 2, afterUid: 99, uidValidity: '100' });
    const session = new FakeSession(['IMAP4rev1']);
    return session.append('INBOX', simpleMessage(), []).then(async () => {
      const { service } = harness(session);
      await expect(
        service.listMessages({ mailbox: 'INBOX', limit: 2, cursor }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });
  });

  it('pages a server sort with a window instead of the whole match', async () => {
    const session = new FakeSession(['IMAP4rev1', 'SORT', 'ESORT', 'UIDPLUS']);
    for (let index = 0; index < 5; index += 1) {
      await session.append(
        'INBOX',
        simpleMessage({ subject: `S${index}`, messageId: `<${index}@ex>` }),
        [],
      );
    }
    const { service } = harness(session);
    const page = await service.listMessages({
      mailbox: 'INBOX',
      limit: 2,
      includeSnippet: false,
    });
    expect(page.total).toBe(5);
    expect(page.sortSource).toBe('server');
    const first = (page.messages as Array<{ uid: number }>).map((item) => item.uid);
    expect(first).toHaveLength(2);
    expect(page.nextCursor).toEqual(expect.any(String));
    const page2 = await service.listMessages({
      mailbox: 'INBOX',
      limit: 2,
      includeSnippet: false,
      cursor: String(page.nextCursor),
    });
    const second = (page2.messages as Array<{ uid: number }>).map((item) => item.uid);
    expect(second).toHaveLength(2);
    expect(first.filter((uid) => second.includes(uid))).toEqual([]);
    expect(page2.total).toBe(5);
  });

  it('pages a client-side arrival sort when internal dates and UIDs disagree', async () => {
    const session = new FakeSession(['IMAP4rev1', 'UIDPLUS']);
    await session.append('INBOX', simpleMessage({ subject: 'Newer' }), []);
    await session.append('INBOX', simpleMessage({ subject: 'Older' }), []);
    await session.append('INBOX', simpleMessage({ subject: 'Newest' }), []);
    const stored = session.boxes.get('INBOX')?.messages ?? [];
    const newer = stored[0];
    const older = stored[1];
    const newest = stored[2];
    if (!newer || !older || !newest) {
      throw new Error('missing messages');
    }
    newer.internalDate = '2026-08-01T00:00:00.000Z';
    older.internalDate = '2010-01-01T00:00:00.000Z';
    newest.internalDate = '2026-10-20T00:00:00.000Z';
    const { service } = harness(session);
    const subjects: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const listed = await service.listMessages({
        mailbox: 'INBOX',
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
    expect(new Set(subjects).size).toBe(3);
  });

  it('indexes partIndex on the attachment list, not the text body', async () => {
    const session = new FakeSession();
    await session.append('INBOX', simpleMessage({ text: 'hello' }), []);
    session.structure = {
      type: 'multipart',
      subtype: 'mixed',
      parameters: {},
      dispositionParameters: {},
      children: [
        {
          type: 'text',
          subtype: 'plain',
          parameters: {},
          dispositionParameters: {},
          children: [],
          part: '1',
        },
        {
          type: 'text',
          subtype: 'plain',
          parameters: { name: 'notes.txt' },
          disposition: 'attachment',
          dispositionParameters: { filename: 'notes.txt' },
          children: [],
          part: '2',
        },
      ],
      part: '',
    };
    session.partBodies.set('1', { content: Buffer.from('hello'), contentType: 'text/plain' });
    session.partBodies.set('2', {
      content: Buffer.from('notes!!'),
      contentType: 'text/plain',
      filename: 'notes.txt',
    });
    const { service } = harness(session);
    const downloaded = await service.downloadAttachment({
      mailbox: 'INBOX',
      uid: 1,
      partIndex: 0,
    });
    expect(downloaded.bytes).toBe(7);
    expect(Buffer.from(String(downloaded.contentBase64), 'base64').toString()).toBe('notes!!');
  });

  it('refuses a client-side sort above maxSortCandidates and leaves the mailbox', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    for (let index = 0; index < 3; index += 1) {
      await session.append('INBOX', simpleMessage({ subject: `N${index}` }), []);
    }
    const { service } = harness(session, {
      limits: { ...account().limits, maxSortCandidates: 2 },
    });
    await expect(
      service.listMessages({ mailbox: 'INBOX', limit: 10, includeSnippet: false }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    expect(session.boxes.get('INBOX')?.messages).toHaveLength(3);
  });
});

describe('wait deadline and HTTP bearer', () => {
  it('lets a wait run longer than the account command timeout', async () => {
    let closed = false;
    const session = {
      async connect() {
        return undefined;
      },
      close() {
        closed = true;
      },
      async logout() {
        return undefined;
      },
      async waitForChanges() {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return {
          timedOut: false,
          idleSupported: true,
          changes: [{ kind: 'exists' as const, path: 'INBOX', count: 1, prevCount: 0 }],
          status: { path: 'INBOX', messages: 1 },
        };
      },
    } as unknown as ImapSession;
    const pool = new ImapConnectionPool(async () => session, 1, createLogger({ level: 'silent' }));
    const base = account();
    const service = new MailService({
      config: appConfig({ imap: { ...base.imap, timeoutMs: 40 } }),
      pool,
      smtpFactory: async () => {
        throw new Error('unused');
      },
      logger: createLogger({ level: 'silent' }),
    });
    const waited = await service.waitForChanges({ timeoutMs: 2000 });
    expect(waited.timedOut).toBe(false);
    expect(closed).toBe(false);
    expect((waited.changes as unknown[]).length).toBe(1);
    await service.close();
  });

  it('closes the session when a wait ignores its deadline', async () => {
    let closed = false;
    const session = {
      async connect() {
        return undefined;
      },
      close() {
        closed = true;
      },
      async logout() {
        return undefined;
      },
      waitForChanges() {
        return new Promise(() => undefined);
      },
    } as unknown as ImapSession;
    const pool = new ImapConnectionPool(async () => session, 1, createLogger({ level: 'silent' }));
    const service = new MailService({
      config: appConfig(),
      pool,
      smtpFactory: async () => {
        throw new Error('unused');
      },
      logger: createLogger({ level: 'silent' }),
    });
    await expect(service.waitForChanges({ timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    expect(closed).toBe(true);
    await service.close();
  });

  it('requires the bearer token on an existing HTTP session', async () => {
    const session = new FakeSession();
    const mail = new MailService({
      config: appConfig(),
      pool: new FakePool(session),
      logger: createLogger({ level: 'silent' }),
      smtpFactory: async () => ({
        verify: async () => undefined,
        send: async () => ({ accepted: [], rejected: [], pending: [], response: '' }),
        close() {
          return undefined;
        },
      }),
    });
    const http = await startHttpServer({
      service: mail,
      logger: createLogger({ level: 'silent' }),
      host: '127.0.0.1',
      port: 0,
      token: 'secret-token',
    });
    const init = await fetch(http.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer secret-token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'http-test', version: '0' },
        },
      }),
    });
    expect(init.status).toBeLessThan(300);
    const sessionHeader = init.headers.get('mcp-session-id');
    expect(sessionHeader).toBeTruthy();
    await init.text();
    const bypass = await fetch(http.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionHeader ?? '',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(bypass.status).toBe(401);
    await bypass.text();
    const allowed = await fetch(http.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer secret-token',
        'mcp-session-id': sessionHeader ?? '',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    expect(allowed.status).toBeLessThan(400);
    await allowed.text();
    await http.close();
    await mail.close();
  });
});

describe('scripted IMAP and SMTP state', () => {
  it('moves with COPY and UID EXPUNGE when MOVE is absent and keeps a deleted neighbor', async () => {
    const server = new ScriptedImap({ capabilities: ['IMAP4rev1', 'UIDPLUS'] });
    await server.ready();
    server.addMessage(simpleMessage({ subject: 'keep' }).toString('utf8'), ['\\Deleted']);
    const moving = server.addMessage(simpleMessage({ subject: 'move-me' }).toString('utf8'), []);
    const runtime = runtimeFor(server.port);
    const moved = await runtime.service.copyOrMove(
      { mailbox: 'INBOX', uids: [moving], destination: 'Archive' },
      true,
    );
    expect(moved.ok).toBe(true);
    const inbox = server.messagesIn('INBOX');
    expect(inbox.map((message) => message.uid)).toEqual([1]);
    expect(inbox[0]?.flags).toContain('\\Deleted');
    const archive = server.messagesIn('INBOX/Archive');
    expect(archive).toHaveLength(1);
    expect(archive[0]?.raw).toContain('move-me');
    await runtime.close();
    await server.close();
  });

  it('reports a dropped socket and leaves the mailbox in place', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'UIDPLUS'],
      dropAfterCommands: 3,
    });
    await server.ready();
    server.addMessage(simpleMessage({ subject: 'stays' }).toString('utf8'), []);
    const runtime = runtimeFor(server.port);
    await expect(
      runtime.service.listMessages({ mailbox: 'INBOX', limit: 5, includeSnippet: false }),
    ).rejects.toBeInstanceOf(MailError);
    expect(server.messagesIn('INBOX')).toHaveLength(1);
    expect(server.messagesIn('INBOX')[0]?.raw).toContain('stays');
    await runtime.close();
    await server.close();
  });

  it('fetches a broken message over IMAP without throwing', async () => {
    const server = new ScriptedImap({ capabilities: ['IMAP4rev1', 'UIDPLUS'] });
    await server.ready();
    const uid = server.addMessage(
      'From: ada@example.com\r\nSubject: =?unknown?Q?broken?=\r\nContent-Type: text/plain; charset=x-not-a-charset\r\n\r\ncaf\u00e9 raw\r\n',
      [],
    );
    const runtime = runtimeFor(server.port);
    const message = await runtime.service.getMessage({ mailbox: 'INBOX', uid });
    expect(message.ok).toBe(true);
    expect(String(message.text ?? '')).toContain('caf');
    const source = await runtime.service.getSource({ mailbox: 'INBOX', uid });
    expect(Number(source.bytes)).toBeGreaterThan(10);
    await runtime.close();
    await server.close();
  });

  it('upgrades SMTP with STARTTLS and records the message', async () => {
    const smtp = await listenSmtp({ starttls: true, failAuth: false });
    const sender = createSmtpSender(
      account({
        smtp: {
          host: '127.0.0.1',
          port: smtp.port,
          secure: false,
          starttls: 'required',
          timeoutMs: 5_000,
          tls: {
            rejectUnauthorized: true,
            caFile: path.join(certDir, 'dovecot-cert.pem'),
            servername: 'localhost',
          },
        },
      }),
    );
    const result = await sender.send({
      raw: Buffer.from('Subject: secured\r\n\r\nbody\r\n'),
      envelope: { from: 'user@example.com', to: ['ada@example.com'] },
    });
    expect(result.accepted).toContain('ada@example.com');
    expect(smtp.trace.some((line) => line.toUpperCase().startsWith('STARTTLS'))).toBe(true);
    expect(smtp.accepted.some((body) => body.includes('Subject: secured'))).toBe(true);
    sender.close();
    smtp.close();
  });

  it('fails SMTP authentication before accepting a message', async () => {
    const smtp = await listenSmtp({ starttls: false, failAuth: true });
    const sender = createSmtpSender(
      account({
        smtp: {
          host: '127.0.0.1',
          port: smtp.port,
          secure: false,
          starttls: 'disabled',
          timeoutMs: 5_000,
          tls: { rejectUnauthorized: false },
        },
      }),
    );
    await expect(
      sender.send({
        raw: Buffer.from('Subject: no\r\n\r\nbody\r\n'),
        envelope: { from: 'user@example.com', to: ['ada@example.com'] },
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(smtp.accepted).toHaveLength(0);
    expect(smtp.trace.some((line) => line.toUpperCase().startsWith('DATA'))).toBe(false);
    sender.close();
    smtp.close();
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

function listenSmtp(options: { starttls: boolean; failAuth: boolean }): Promise<{
  port: number;
  trace: string[];
  accepted: string[];
  close: () => void;
}> {
  const trace: string[] = [];
  const accepted: string[] = [];
  const cert = readFileSync(path.join(certDir, 'dovecot-cert.pem'));
  const key = readFileSync(path.join(certDir, 'dovecot-key.pem'));
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      let current: Socket = socket;
      let buffer = '';
      let dataMode = false;
      let body = '';
      let authStep = 0;
      const write = (line: string): void => {
        current.write(line);
      };
      const onLine = (line: string): void => {
        trace.push(line);
        const upper = line.toUpperCase();
        if (dataMode) {
          if (line === '.') {
            dataMode = false;
            accepted.push(body);
            write('250 queued\r\n');
          } else {
            body += `${line}\n`;
          }
          return;
        }
        if (authStep === 1) {
          authStep = 2;
          write('334 UGFzc3dvcmQ6\r\n');
          return;
        }
        if (authStep === 2) {
          authStep = 0;
          write(options.failAuth ? '535 5.7.8 authentication failed\r\n' : '235 2.7.0 ok\r\n');
          return;
        }
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          if (options.starttls && current === socket) {
            write('250-scripted\r\n250-STARTTLS\r\n250 AUTH PLAIN LOGIN\r\n');
          } else {
            write('250-scripted\r\n250 AUTH PLAIN LOGIN\r\n');
          }
          return;
        }
        if (upper.startsWith('STARTTLS')) {
          write('220 ready\r\n');
          const secure = new TLSSocket(socket, { isServer: true, cert, key });
          socket.removeAllListeners('data');
          current = secure;
          buffer = '';
          secure.on('data', onData);
          return;
        }
        if (upper.startsWith('AUTH')) {
          if (options.failAuth && !upper.startsWith('AUTH LOGIN')) {
            write('535 5.7.8 authentication failed\r\n');
            return;
          }
          if (upper === 'AUTH LOGIN') {
            authStep = 1;
            write('334 VXNlcm5hbWU6\r\n');
            return;
          }
          write(options.failAuth ? '535 5.7.8 authentication failed\r\n' : '235 2.7.0 ok\r\n');
          return;
        }
        if (upper.startsWith('DATA')) {
          dataMode = true;
          body = '';
          write('354 go\r\n');
          return;
        }
        if (upper.startsWith('QUIT')) {
          current.end('221 bye\r\n');
          return;
        }
        write('250 ok\r\n');
      };
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.length > 0) {
            onLine(line);
          }
        }
      };
      socket.on('data', onData);
      socket.write('220 scripted\r\n');
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        trace,
        accepted,
        close: () => server.close(),
      });
    });
  });
}
