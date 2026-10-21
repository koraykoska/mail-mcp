import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRuntime } from '../../src/runtime.js';
import { createLogger } from '../../src/log.js';
import { appConfig } from '../support/config.js';

const cert = readFileSync(path.join('test/fixtures/certs/dovecot-cert.pem'));
const key = readFileSync(path.join('test/fixtures/certs/dovecot-key.pem'));

/**
 * SMTP that speaks STARTTLS with the Dovecot fixture certificate (CN=localhost).
 * verify() only needs the handshake and AUTH.
 */
function starttlsServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    const speak = (target: NodeJS.WritableStream, line: string) => {
      target.write(`${line}\r\n`);
    };
    const listen = (target: NodeJS.ReadableStream & NodeJS.WritableStream, secure: boolean) => {
      let buffer = '';
      target.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let split = buffer.indexOf('\r\n');
        while (split >= 0) {
          const line = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const upper = line.toUpperCase();
          if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
            speak(target, '250-localhost');
            if (!secure) {
              speak(target, '250-STARTTLS');
            }
            speak(target, '250 AUTH PLAIN LOGIN');
          } else if (upper === 'STARTTLS' && !secure) {
            speak(target, '220 Ready to start TLS');
            target.removeAllListeners('data');
            const wrapped = new tls.TLSSocket(socket, { isServer: true, cert, key });
            listen(wrapped, true);
          } else if (upper.startsWith('AUTH')) {
            speak(target, '235 Authentication successful');
          } else if (upper === 'QUIT') {
            speak(target, '221 Bye');
            socket.end();
          } else {
            speak(target, '250 OK');
          }
          split = buffer.indexOf('\r\n');
        }
      });
    };
    speak(socket, '220 localhost ESMTP');
    listen(socket, false);
  });
  return new Promise((resolve) => {
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

function runtimeFor(host: string, port: number) {
  return createRuntime({
    config: appConfig({
      imap: {
        host: '127.0.0.1',
        port: 1,
        secure: false,
        starttls: 'disabled',
        timeoutMs: 5_000,
        tls: { rejectUnauthorized: false },
      },
      smtp: {
        host,
        port: 587,
        secure: false,
        starttls: 'required',
        timeoutMs: 5_000,
        connectHost: '127.0.0.1',
        connectPort: port,
        tls: { rejectUnauthorized: true, caFile: 'test/fixtures/certs/dovecot-cert.pem' },
      },
      user: 'user',
      email: 'user@example.com',
      auth: { type: 'password', password: 'secret' },
    }),
    logger: createLogger({ level: 'silent' }),
  });
}

describe('SMTP STARTTLS connect override', () => {
  it('verifies when TCP goes to the override and the certificate matches the logical host', async () => {
    const server = await starttlsServer();
    const runtime = runtimeFor('localhost', server.port);
    const verified = await runtime.service.verify(undefined, { imap: false, smtp: true });
    expect(verified.ok).toBe(true);
    expect((verified.smtp as { connectHost?: string }).connectHost).toBe('127.0.0.1');
    expect((verified.smtp as { host?: string }).host).toBe('localhost');
    await runtime.close();
    await server.close();
  });

  it('rejects the same override when the logical host does not match the certificate', async () => {
    const server = await starttlsServer();
    const runtime = runtimeFor('wrong.example', server.port);
    const verified = await runtime.service.verify(undefined, { imap: false, smtp: true });
    expect(verified.ok).toBe(false);
    expect((verified.smtp as { code?: string }).code).toBe('TLS_FAILED');
    await runtime.close();
    await server.close();
  });
});
