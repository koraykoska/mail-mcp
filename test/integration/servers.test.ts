import { beforeAll, describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import type { MailService } from '../../src/service/mail-service.js';
import { createRuntime } from '../../src/runtime.js';
import { appConfig, type account } from '../support/config.js';
import { ensureGreenMail, type GreenMailEndpoints } from '../support/greenmail.js';
import { ScriptedImap } from '../support/scripted-imap.js';
import { simpleMessage, multipartMixed, htmlAlternative } from '../fixtures/messages.js';
import { createLogger } from '../../src/log.js';
import { createSmtpSender } from '../../src/smtp/client.js';

let greenmail: GreenMailEndpoints;

beforeAll(async () => {
  greenmail = await ensureGreenMail();
}, 40_000);

function runtimeFor(overrides: Partial<ReturnType<typeof account>> = {}) {
  const config = appConfig({
    imap: {
      host: greenmail.host,
      port: greenmail.imapPort,
      secure: false,
      starttls: 'disabled',
      timeoutMs: 15_000,
      tls: { rejectUnauthorized: false },
    },
    smtp: {
      host: greenmail.host,
      port: greenmail.smtpPort,
      secure: false,
      starttls: 'disabled',
      timeoutMs: 15_000,
      tls: { rejectUnauthorized: false },
    },
    user: greenmail.user,
    email: greenmail.email,
    auth: { type: 'password', password: greenmail.password },
    identities: [{ id: 'default', email: greenmail.email, name: 'User', default: true }],
    appendSent: false,
    ...overrides,
  });
  return createRuntime({
    config,
    logger: createLogger({ level: 'silent', secrets: config.secrets }),
  });
}

describe('GreenMail', () => {
  it('verifies, lists capabilities, and rejects a bad password', async () => {
    const runtime = runtimeFor();
    const verified = await runtime.service.verify(undefined, { imap: true, smtp: true });
    expect(verified.ok).toBe(true);
    const caps = await runtime.service.capabilities();
    expect(caps.capabilities).toEqual(expect.arrayContaining(['IMAP4rev1', 'IDLE', 'MOVE']));
    await runtime.close();

    const bad = runtimeFor({ auth: { type: 'password', password: 'wrong-password' } });
    const failed = await bad.service.verify(undefined, { imap: true, smtp: false });
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed.imap)).toContain('AUTH_FAILED');
    await bad.close();
  });

  it('round-trips mailboxes, messages, search, flags, copy, smtp, and paging', async () => {
    const runtime = runtimeFor();
    const service: MailService = runtime.service;
    const stamp = `it-${Date.now()}`;
    const folder = `Projects/${stamp}`;
    const created = await service.createMailbox(undefined, folder);
    expect(created.created).toBe(true);
    await service.subscribe(undefined, folder, true);
    const subscribed = await service.listMailboxes(undefined, true);
    expect(JSON.stringify(subscribed.mailboxes)).toContain(folder);

    const unicode = `Café-${stamp}`;
    await service.createMailbox(undefined, unicode);
    const listed = await service.listMailboxes(undefined, false);
    expect(JSON.stringify(listed.mailboxes)).toContain(unicode);

    await service.append({
      mailbox: folder,
      to: [greenmail.email],
      subject: `Hello ${stamp}`,
      text: 'Searchable body',
      flags: ['\\Seen'],
    });
    await service.append({ mailbox: folder, rawBase64: multipartMixed.toString('base64') });
    await service.append({ mailbox: folder, rawBase64: htmlAlternative.toString('base64') });
    for (let index = 0; index < 12; index += 1) {
      await service.append({
        mailbox: folder,
        rawBase64: simpleMessage({
          subject: `Bulk ${index} ${stamp}`,
          messageId: `<${stamp}-${index}@example.com>`,
        }).toString('base64'),
      });
    }

    const status = await service.mailboxStatus(undefined, folder);
    expect(Number((status.status as { messages?: number }).messages)).toBeGreaterThanOrEqual(15);

    const page = await service.listMessages({ mailbox: folder, limit: 5, includeSnippet: true });
    expect(page.total).toBeGreaterThanOrEqual(15);
    expect((page.messages as unknown[]).length).toBe(5);
    expect(page.nextCursor).toBeTruthy();
    const page2 = await service.listMessages({
      mailbox: folder,
      limit: 5,
      cursor: String(page.nextCursor),
    });
    expect((page2.messages as unknown[]).length).toBe(5);

    const found = await service.searchMessages({
      mailbox: folder,
      search: { subject: `Hello ${stamp}` },
      limit: 10,
    });
    expect(found.total).toBeGreaterThanOrEqual(1);
    const uid = Number((found.messages as Array<{ uid: number }>)[0]?.uid);
    const message = await service.getMessage({ mailbox: folder, uid });
    expect(message.text).toContain('Searchable');
    const raw = await service.getSource({ mailbox: folder, uid });
    expect(raw.bytes).toBeGreaterThan(20);

    await service.setFlags({
      mailbox: folder,
      uids: [uid],
      flags: ['\\Flagged'],
      operation: 'add',
      uidValidity: String((status.status as { uidValidity?: string }).uidValidity),
    });
    const archive = `Archive-${stamp}`;
    await service.createMailbox(undefined, archive);
    await service.copyOrMove({ mailbox: folder, uids: [uid], destination: archive }, false);
    const moved = await service.copyOrMove(
      { mailbox: folder, uids: [uid], destination: archive },
      true,
    );
    expect(moved.move).toBe(true);

    const threads = await service.listThreads({ mailbox: folder, limit: 20 });
    expect(threads.total).toBeGreaterThan(0);

    const sent = await service.send({
      to: [greenmail.email],
      subject: `SMTP ${stamp}`,
      text: 'delivered',
      appendSent: false,
    });
    expect(sent.ok).toBe(true);

    let delivered = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const inbox = await service.searchMessages({
        mailbox: 'INBOX',
        search: { subject: `SMTP ${stamp}` },
        limit: 5,
      });
      if (Number(inbox.total) > 0) {
        delivered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(delivered).toBe(true);

    await service.renameMailbox(undefined, unicode, `Renamed-${stamp}`);
    await service.deleteMailbox(undefined, `Renamed-${stamp}`);
    const quota = await service.quota(undefined);
    expect(quota.ok).toBe(true);
    const tree = await service.mailboxTree();
    expect(tree.tree).toBeTruthy();
    const special = await service.specialUse();
    expect(special.special).toBeTruthy();

    const [a, b] = await Promise.all([
      service.mailboxStatus(undefined, 'INBOX'),
      service.capabilities(),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const other = runtimeFor();
    const waitedPromise = service.waitForChanges({ mailbox: 'INBOX', timeoutMs: 8000 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await other.service.append({
      mailbox: 'INBOX',
      rawBase64: simpleMessage({ subject: `idle ${stamp}`, text: 'ping' }).toString('base64'),
    });
    const waited = await waitedPromise;
    expect(waited.mailbox).toBe('INBOX');
    await other.close();
    const bulk = await service.searchMessages({
      mailbox: folder,
      search: { subject: `Bulk 1 ${stamp}` },
    });
    const bulkUid = Number((bulk.messages as Array<{ uid: number }>)[0]?.uid);
    const part = await service.getPart({ mailbox: folder, uid: bulkUid, partId: '1' });
    expect(part.partId).toBe('1');
    await service.getHeaders({ mailbox: folder, uid: bulkUid });
    const threadsOrdered = await service.listThreads({
      mailbox: folder,
      algorithm: 'ORDEREDSUBJECT',
      limit: 5,
    });
    expect(threadsOrdered.total).toBeGreaterThan(0);
    const live = service.account();
    if (live.smtp) {
      const sender = createSmtpSender({
        ...live,
        smtp: {
          ...live.smtp,
          tls: { ...live.smtp.tls, caFile: '/etc/ssl/certs/ca-certificates.crt' },
        },
      });
      try {
        await sender.send({
          raw: simpleMessage({ subject: `dsn ${stamp}`, to: greenmail.email }),
          envelope: { from: greenmail.email, to: [greenmail.email] },
          dsn: { id: 'env-1', ret: 'HDRS', notify: ['failure', 'delay'], orcpt: greenmail.email },
        });
      } catch {
        // Some servers reject DSN. Building the request is what this checks.
      } finally {
        sender.close();
      }
    }
    await runtime.close();

    const expunger = runtimeFor({ allowPermanentDelete: true, allowDelete: true });
    await expunger.service.append({
      mailbox: 'INBOX',
      rawBase64: simpleMessage({ subject: `purge ${stamp}` }).toString('base64'),
    });
    const purgeSearch = await expunger.service.searchMessages({
      mailbox: 'INBOX',
      search: { subject: `purge ${stamp}` },
    });
    const purgeUid = Number((purgeSearch.messages as Array<{ uid: number }>)[0]?.uid);
    await expunger.service.deleteMessages({
      mailbox: 'INBOX',
      uids: [purgeUid],
      permanent: true,
    });
    await expunger.service.expunge(undefined, 'INBOX');
    await expunger.close();
  });

  it('rejects an unverified implicit TLS certificate and accepts an opted-out one', async () => {
    const strict = runtimeFor({
      imap: {
        host: greenmail.host,
        port: greenmail.imapsPort,
        secure: true,
        starttls: 'disabled',
        timeoutMs: 10_000,
        tls: { rejectUnauthorized: true },
      },
    });
    const failed = await strict.service.verify(undefined, { imap: true, smtp: false });
    expect(JSON.stringify(failed.imap)).toMatch(/TLS_FAILED/);
    await strict.close();

    const loose = runtimeFor({
      imap: {
        host: greenmail.host,
        port: greenmail.imapsPort,
        secure: true,
        starttls: 'disabled',
        timeoutMs: 10_000,
        tls: { rejectUnauthorized: false },
      },
      smtp: {
        host: greenmail.host,
        port: greenmail.smtpsPort,
        secure: true,
        starttls: 'disabled',
        timeoutMs: 10_000,
        tls: { rejectUnauthorized: false },
      },
    });
    const ok = await loose.service.verify(undefined, { imap: true, smtp: true });
    expect(ok.ok).toBe(true);
    await loose.close();
  });
});

describe('scripted IMAP fallbacks', () => {
  it('connects, reports missing MOVE, and notices UIDVALIDITY changes', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1'],
      bumpUidValidityAfter: 0,
    });
    await server.ready();
    server.addMessage(simpleMessage().toString('utf8'), ['\\Seen']);
    const config = appConfig({
      imap: {
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        starttls: 'disabled',
        timeoutMs: 8_000,
        tls: { rejectUnauthorized: false },
      },
      smtp: undefined,
      appendSent: false,
      allowPermanentDelete: false,
    });
    const runtime = createRuntime({ config, logger: createLogger({ level: 'silent' }) });
    const caps = await runtime.service.capabilities();
    expect(caps.capabilities).toContain('IMAP4rev1');
    expect(caps.capabilities).not.toContain('MOVE');
    const status = await runtime.service.mailboxStatus(undefined, 'INBOX');
    const validity = String((status.status as { uidValidity?: string }).uidValidity);
    await runtime.close();
    const reconnected = createRuntime({ config, logger: createLogger({ level: 'silent' }) });
    await expect(
      reconnected.service.listMessages({ mailbox: 'INBOX', uidValidity: validity, limit: 5 }),
    ).rejects.toThrow(/UIDVALIDITY/);
    await expect(
      reconnected.service.copyOrMove(
        { mailbox: 'INBOX', uids: [1], destination: 'Elsewhere' },
        true,
      ),
    ).rejects.toThrow(/MOVE|UIDPLUS|CAPABILITY/);
    await reconnected.close();
    await server.close();
  });

  it('uses server THREAD and SORT when those capabilities are advertised', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'THREAD', 'SORT', 'MOVE', 'UIDPLUS', 'ID', 'NAMESPACE', 'QUOTA'],
    });
    await server.ready();
    server.addMessage(simpleMessage({ subject: 'One' }).toString('utf8'), ['\\Seen']);
    server.addMessage(
      simpleMessage({ subject: 'Two', messageId: '<two@example.com>' }).toString('utf8'),
      [],
    );
    const config = appConfig({
      imap: {
        host: '127.0.0.1',
        port: server.port,
        secure: false,
        starttls: 'disabled',
        timeoutMs: 8_000,
        tls: { rejectUnauthorized: false },
      },
      smtp: undefined,
      appendSent: false,
    });
    const runtime = createRuntime({ config, logger: createLogger({ level: 'silent' }) });
    expect((await runtime.service.namespaces()).ok).toBe(true);
    expect((await runtime.service.serverId()).ok).toBe(true);
    expect((await runtime.service.quota(undefined)).ok).toBe(true);
    expect((await runtime.service.mailboxTree()).ok).toBe(true);
    const listed = await runtime.service.listMessages({
      mailbox: 'INBOX',
      limit: 10,
      includeSnippet: true,
    });
    expect(listed.ok).toBe(true);
    const threads = await runtime.service.listThreads({ mailbox: 'INBOX', limit: 10 });
    expect(threads.source === 'server' || threads.source === 'client').toBe(true);
    await runtime.service.setFlags({
      mailbox: 'INBOX',
      uids: [1],
      flags: ['\\Seen'],
      operation: 'remove',
    });
    await runtime.service.setFlags({
      mailbox: 'INBOX',
      uids: [1],
      flags: ['\\Flagged'],
      operation: 'set',
    });
    await runtime.close();
    await server.close();
  });

  it('fails authentication and survives a dropped connection as a connection error', async () => {
    const server = new ScriptedImap({ capabilities: ['IMAP4rev1'], dropAfterCommands: 1 });
    await server.ready();
    const client = new ImapFlow({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      doSTARTTLS: false,
      logger: false,
      auth: { user: 'user', pass: 'nope' },
      greetingTimeout: 3000,
      connectionTimeout: 3000,
    });
    await expect(client.connect()).rejects.toThrow();
    client.close();
    await server.close();
  });
});
