import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeAll } from 'vitest';
import { ImapFlow } from 'imapflow';
import { createRuntime } from '../../src/runtime.js';
import { createLogger } from '../../src/log.js';
import { simpleMessage } from '../fixtures/messages.js';
import { ensureDovecot, type DovecotEndpoints } from '../support/dovecot.js';
import { appConfig } from '../support/config.js';

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
    expect(result.idleSupported).toBe(false);
    expect(result.timedOut).toBe(false);
    expect((result.changes as unknown[]).length).toBeGreaterThan(0);
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
});
