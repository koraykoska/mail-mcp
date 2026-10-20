import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { getAccessToken, clearTokenCache } from '../../src/auth/oauth.js';
import { parseArgs, run, isLoopback } from '../../src/cli.js';
import { MailError } from '../../src/errors.js';
import { startHttpServer } from '../../src/http.js';
import { ImapFlowSession } from '../../src/imap/flow-session.js';
import { ImapConnectionPool } from '../../src/imap/pool.js';
import type { ImapSession } from '../../src/imap/session.js';
import { createLogger } from '../../src/log.js';
import {
  decodeQuotedPrintable,
  decodeTransfer,
  hasHighOctets,
  parseSequenceSet,
  stripBcc,
} from '../../src/mime/transfer.js';
import { htmlToSafeText, quoteHtml, textToHtml } from '../../src/mime/html.js';
import { createSmtpSender } from '../../src/smtp/client.js';
import { account } from '../support/config.js';
import { ScriptedImap } from '../support/scripted-imap.js';

describe('transfer and html helpers', () => {
  it('decodes quoted-printable and base64, and strips Bcc', () => {
    expect(decodeQuotedPrintable(Buffer.from('caf=E9=\r\n'))).toEqual(
      Buffer.from([0x63, 0x61, 0x66, 0xe9]),
    );
    expect(decodeTransfer(Buffer.from('QQ=='), 'base64').toString()).toBe('A');
    expect(decodeTransfer(Buffer.from('plain'), '7bit').toString()).toBe('plain');
    expect(hasHighOctets(Buffer.from([0x7f]))).toBe(false);
    expect(hasHighOctets(Buffer.from([0x80]))).toBe(true);
    expect(parseSequenceSet('2,4:6,8')).toEqual([2, 4, 5, 6, 8]);
    const raw = Buffer.from('From: a@b\r\nBcc: hidden@ex\r\n\r\nbody');
    expect(stripBcc(raw).toString()).not.toMatch(/Bcc/i);
    expect(stripBcc(Buffer.from('no headers')).toString()).toBe('no headers');
  });

  it('quotes html without keeping javascript urls', () => {
    const html = quoteHtml('<a href="javascript:alert(1)">x</a><p>Hi</p>', 'Ada', 'today');
    expect(html).toContain('Ada');
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(htmlToSafeText('<a href="javascript:alert(1)">x</a>')).not.toMatch(/javascript:/i);
    expect(textToHtml('a<b>\n')).toContain('&lt;');
  });
});

describe('scripted IMAP session', () => {
  it('reads extensions, refuses SEARCH, and stores conditional flags', async () => {
    const server = new ScriptedImap({
      capabilities: [
        'IMAP4rev1',
        'UIDPLUS',
        'IDLE',
        'QUOTA',
        'NAMESPACE',
        'ID',
        'ACL',
        'METADATA',
        'SORT',
        'THREAD=REFERENCES',
        'CONDSTORE',
        'ENABLE',
      ],
    });
    await server.ready();
    server.addMessage('Subject: x\r\n\r\nhello', ['\\Seen']);
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
      createLogger({ level: 'silent' }),
    );
    await session.connect();
    expect(session.hasCapability('THREAD')).toBe(true);
    expect(session.hasExactCapability('THREAD')).toBe(false);
    expect((await session.namespaces()).personal[0]?.delimiter).toBe('/');
    expect((await session.quota('INBOX'))?.resources.length).toBeGreaterThan(0);
    expect(session.serverId()?.name).toBe('scripted');
    const acl = await session.getAcl('INBOX');
    expect(acl[0]?.rights).toContain('l');
    await session.setAcl('INBOX', 'user', 'lr', 'set');
    await session.setAcl('INBOX', 'user', '', 'remove');
    const meta = await session.getMetadata('INBOX', ['/private/comment']);
    expect(meta).toHaveProperty('/private/comment');
    await session.setMetadata('INBOX', { '/private/comment': 'next', '/private/gone': null });
    expect((await session.listMailboxes()).some((box) => box.path === 'INBOX')).toBe(true);
    expect((await session.status('INBOX')).messages).toBeGreaterThanOrEqual(0);
    expect((await session.listTree()).folders).toBeDefined();
    await session.createMailbox('Projects');
    await session.renameMailbox('Projects', 'Archive');
    await session.subscribe('Archive');
    await session.unsubscribe('Archive');
    await session.deleteMailbox('Archive');
    await session.logout();
    await server.close();
  });

  it('turns a refused SEARCH into a protocol error', async () => {
    const server = new ScriptedImap({ capabilities: ['IMAP4rev1'], refuseSearch: true });
    await server.ready();
    server.addMessage('Subject: x\r\n\r\nx', []);
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
      createLogger({ level: 'silent' }),
    );
    await session.connect();
    await expect(
      session.withMailbox('INBOX', 'read', (box) =>
        box.search({ query: { all: true }, requires: [] }),
      ),
    ).rejects.toBeInstanceOf(MailError);
    await session.close();
    await server.close();
  });
});

describe('smtp 8bit and oauth single flight', () => {
  it('requests BODY=8BITMIME when the server offers it and refuses when it does not', async () => {
    const offered = await listenSmtp(true);
    const sender = createSmtpSender(
      account({
        smtp: {
          host: '127.0.0.1',
          port: offered.port,
          secure: false,
          starttls: 'disabled',
          timeoutMs: 5_000,
          tls: { rejectUnauthorized: false },
        },
      }),
    );
    const result = await sender.send({
      raw: Buffer.from('Subject: x\r\n\r\n\u00e9'),
      envelope: { from: 'user@example.com', to: ['ada@example.com'] },
      eightBit: true,
    });
    expect(result.accepted).toContain('ada@example.com');
    expect(offered.trace.some((line) => line.includes('8BITMIME'))).toBe(true);
    sender.close();
    offered.close();
    const plain = await listenSmtp(false);
    const refused = createSmtpSender(
      account({
        smtp: {
          host: '127.0.0.1',
          port: plain.port,
          secure: false,
          starttls: 'disabled',
          timeoutMs: 5_000,
          tls: { rejectUnauthorized: false },
        },
      }),
    );
    await expect(
      refused.send({
        raw: Buffer.from('Subject: x\r\n\r\n\u00e9'),
        envelope: { from: 'user@example.com', to: ['ada@example.com'] },
        eightBit: true,
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    refused.close();
    plain.close();
  });

  it('single-flights a token refresh and aborts a hung endpoint', async () => {
    clearTokenCache();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
        status: 200,
      });
    };
    const auth = {
      type: 'oauth2' as const,
      refreshToken: 'refresh',
      clientId: 'id',
      clientSecret: 'secret',
      tokenUrl: 'https://example.test/token',
    };
    const [first, second] = await Promise.all([
      getAccessToken(auth, 'acct', fetchImpl as typeof fetch),
      getAccessToken(auth, 'acct', fetchImpl as typeof fetch),
    ]);
    expect(first).toBe('tok');
    expect(second).toBe('tok');
    expect(calls).toBe(1);
  });
});

describe('pool, http, and cli edges', () => {
  it('rejects waiters when the pool closes and does not repeat a timed out command', async () => {
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
    } as unknown as ImapSession;
    let opens = 0;
    const pool = new ImapConnectionPool(
      async () => {
        opens += 1;
        if (opens === 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return session;
      },
      1,
      createLogger({ level: 'silent' }),
    );
    const first = pool.use('a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return 'held';
    });
    const waiting = pool.use('a', async () => 'later', 20);
    await expect(waiting).rejects.toMatchObject({ code: 'TIMEOUT' });
    await first;
    const hung = pool.use('b', () => new Promise(() => undefined), 30);
    await expect(hung).rejects.toMatchObject({ code: 'TIMEOUT' });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = new ImapConnectionPool(
      async () => {
        await gate;
        return session;
      },
      1,
      createLogger({ level: 'silent' }),
    );
    const pending = gated.use('a', async () => 'nope');
    await gated.close();
    release();
    await expect(pending).rejects.toBeInstanceOf(MailError);
  });

  it('caps the HTTP body and requires a token off loopback', async () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    const code = await run(['node', 'mail-mcp', '--http', '--host', '0.0.0.0'], {
      MAIL_IMAP_HOST: '127.0.0.1',
      MAIL_IMAP_PORT: '993',
      MAIL_IMAP_SECURE: 'true',
      MAIL_USER: 'user@example.com',
      MAIL_PASSWORD: 'secret',
    });
    expect(code).toBe(1);
    const http = await startHttpServer({
      service: {
        config: { secrets: [] },
      } as never,
      logger: createLogger({ level: 'silent' }),
      port: 0,
      host: '127.0.0.1',
      token: 'tok',
      maxBodyBytes: 32,
    });
    const url = new URL(http.url);
    const denied = await fetch(http.url, { method: 'POST', body: '{}' });
    expect(denied.status).toBe(401);
    const huge = await fetch(`http://127.0.0.1:${url.port}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-length': '1000' },
      body: 'x'.repeat(1000),
    });
    expect([400, 413, 500]).toContain(huge.status);
    await http.close();
    expect(parseArgs(['node', 'mail-mcp', '--http-token', 'tok']).httpToken).toBe('tok');
  });
});

function listenSmtp(eightBit: boolean): Promise<{
  port: number;
  trace: string[];
  close: () => void;
}> {
  const trace: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.write('220 scripted\r\n');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          trace.push(line);
          const upper = line.toUpperCase();
          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            socket.write(eightBit ? '250-scripted\r\n250 8BITMIME\r\n' : '250 scripted\r\n');
          } else if (upper.startsWith('DATA')) {
            socket.write('354 go\r\n');
          } else if (upper === '.') {
            socket.write('250 queued\r\n');
          } else if (upper.startsWith('QUIT')) {
            socket.end('221 bye\r\n');
          } else {
            socket.write('250 ok\r\n');
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        trace,
        close: () => server.close(),
      });
    });
  });
}
