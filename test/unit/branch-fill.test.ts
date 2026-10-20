import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../../src/config/load.js';
import { MailError } from '../../src/errors.js';
import { confineToRoot, readBoundedFile } from '../../src/fs-sandbox.js';
import { ImapConnectionPool } from '../../src/imap/pool.js';
import type { ImapSession } from '../../src/imap/session.js';
import { andSearchUid, compileSearch } from '../../src/imap/search.js';
import { startHttpServer } from '../../src/http.js';
import { createLogger } from '../../src/log.js';
import {
  addressToAscii,
  addressToUnicode,
  formatAddress,
  formatAddressList,
  parseAddress,
  parseAddressList,
} from '../../src/mime/address.js';
import { createSmtpSender } from '../../src/smtp/client.js';
import { isLoopback, parseArgs } from '../../src/cli.js';
import { buildRawMessage } from '../../src/mime/build.js';
import { findTextPart } from '../../src/mime/parse.js';
import { decodeQuotedPrintable, decodeTransfer } from '../../src/mime/transfer.js';
import { sortMessages } from '../../src/imap/sort.js';
import { MailService } from '../../src/service/mail-service.js';
import type { SmtpSender } from '../../src/smtp/client.js';
import { simpleMessage } from '../fixtures/messages.js';
import { account, appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';

function harness(session = new FakeSession(), overrides: Parameters<typeof appConfig>[0] = {}) {
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
    logger: createLogger({ level: 'silent' }),
  });
  return { service, session };
}

describe('remaining service and helper branches', () => {
  it('covers source, part, draft, send, and flag result edges', async () => {
    const session = new FakeSession(['IMAP4rev1', 'CONDSTORE', 'UIDPLUS', 'MOVE', 'SORT']);
    const raw = simpleMessage({ text: 'x'.repeat(80) });
    await session.append('INBOX', raw, []);
    const stored = session.boxes.get('INBOX')?.messages[0];
    if (!stored) {
      throw new Error('missing');
    }
    stored.size = 200_000;
    const { service } = harness(session, {
      limits: {
        ...account().limits,
        maxMessageBytes: 100_000,
        maxBodyChars: 8,
        maxAttachmentBytes: 4,
      },
      allowDelete: true,
      allowPermanentDelete: true,
      sendRateLimit: { max: 1, windowMs: 60_000 },
    });
    await expect(service.getSource({ mailbox: 'INBOX', uid: stored.uid })).rejects.toMatchObject({
      code: 'SIZE_LIMIT',
    });
    stored.size = 10;
    session.sourceMissing = true;
    await expect(service.getSource({ mailbox: 'INBOX', uid: stored.uid })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.getHeaders({ mailbox: 'INBOX', uid: 99 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    session.sourceMissing = false;
    const headers = await service.getHeaders({ mailbox: 'INBOX', uid: stored.uid });
    expect(headers.truncated).toBe(true);
    session.partBodies.set('1', {
      content: Buffer.from('abcdef'),
      contentType: 'application/pdf',
      filename: 'a.pdf',
    });
    const binary = await service.getPart({ mailbox: 'INBOX', uid: stored.uid, partId: '1' });
    expect(binary.contentBase64).toEqual(expect.any(String));
    const flags = await service.setFlags({
      mailbox: 'INBOX',
      uids: [stored.uid, 99],
      flags: ['\\Seen'],
      operation: 'add',
      unchangedSince: '0',
    });
    const rows = flags.results as Array<{ uid: number; ok: boolean; code?: string }>;
    expect(rows.some((row) => row.code === 'PROTOCOL_ERROR')).toBe(true);
    expect(rows.some((row) => row.code === 'NOT_FOUND')).toBe(true);
    const drafted = await service.saveDraft({
      mailbox: 'Drafts',
      subject: 'keep',
      text: 't',
      to: ['ada@example.com'],
      allowEmptyRecipients: false,
    });
    expect(drafted.uid).toEqual(expect.any(Number));
    await expect(
      service.send({ to: ['ada@example.com'], subject: 's', text: 't', dsn: { ret: 'HDRS' } }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      service.send({ to: ['ada@example.com'], subject: 's', text: 't' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const huge = harness(new FakeSession(), {
      limits: { ...account().limits, maxMessageBytes: 20 },
    });
    await expect(
      huge.service.send({ to: ['ada@example.com'], subject: 's', text: 'x'.repeat(80) }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    const noSmtp = harness(new FakeSession(), { smtp: undefined, allowSend: true });
    await noSmtp.session.append(
      'Drafts',
      simpleMessage({ from: 'User <user@example.com>', to: 'ada@example.com' }),
      [],
    );
    await expect(noSmtp.service.sendDraft({ mailbox: 'Drafts', uid: 1 })).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
    });
    const paged = harness(new FakeSession(['IMAP4rev1', 'SORT', 'ESORT', 'UIDPLUS']));
    await paged.session.append('INBOX', simpleMessage({ subject: 'only' }), []);
    const cursor = Buffer.from(
      JSON.stringify({ v: 2, afterUid: 1, uidValidity: '100' }),
      'utf8',
    ).toString('base64url');
    await expect(
      paged.service.listMessages({
        mailbox: 'INBOX',
        limit: 2,
        cursor,
        includeSnippet: false,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects an oversized reported size, a missing source, and trash edges', async () => {
    const session = new FakeSession();
    await session.append('INBOX', simpleMessage({ text: 'short' }), []);
    const stored = session.boxes.get('INBOX')?.messages[0];
    if (!stored) {
      throw new Error('missing');
    }
    stored.size = 50_000;
    const { service } = harness(session, {
      limits: { ...account().limits, maxMessageBytes: 100 },
      allowDelete: true,
      allowPermanentDelete: true,
    });
    await expect(service.getMessage({ mailbox: 'INBOX', uid: stored.uid })).rejects.toMatchObject({
      code: 'SIZE_LIMIT',
    });
    stored.size = 10;
    session.sourceMissing = true;
    await expect(service.getMessage({ mailbox: 'INBOX', uid: stored.uid })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    session.sourceMissing = false;

    const noTrash = new FakeSession();
    await noTrash.append('INBOX', simpleMessage(), []);
    noTrash.boxes.delete('Trash');
    const deleted = harness(noTrash, { allowDelete: true });
    await expect(
      deleted.service.deleteMessages({ mailbox: 'INBOX', uids: [1] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      deleted.service.deleteMessages({ mailbox: 'Trash', uids: [1] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const trashed = harness(new FakeSession(), { allowDelete: true, allowPermanentDelete: true });
    await trashed.session.append('Trash', simpleMessage(), []);
    await expect(
      trashed.service.deleteMessages({ mailbox: 'Trash', uids: [1] }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const expunged = await trashed.service.expunge(undefined, 'Trash');
    expect(expunged.expunged).toBe(true);
  });

  it('resolves draft, label, attachment, and sent-mail edges', async () => {
    const session = new FakeSession();
    session.boxes.delete('Drafts');
    session.boxes.delete('Sent');
    const { service } = harness(session, { allowDelete: true });
    await expect(
      service.saveDraft({ subject: 'd', text: 't', allowEmptyRecipients: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await session.append('INBOX', simpleMessage(), []);
    const bulk = await service.bulk({
      mailbox: 'INBOX',
      uids: [1],
      action: 'addLabels',
      labels: ['Work'],
    });
    expect((bulk.results as Array<{ ok: boolean }>)[0]?.ok).toBe(false);

    session.structure = {
      type: 'text',
      subtype: 'plain',
      parameters: { name: 'notes.txt' },
      disposition: 'attachment',
      dispositionParameters: { filename: 'notes.txt' },
      id: '<part@example.com>',
      children: [],
      part: '1',
    };
    await expect(
      service.downloadAttachment({ mailbox: 'INBOX', uid: 1, filename: 'missing.pdf' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.downloadAttachment({ mailbox: 'INBOX', uid: 1, cid: 'other' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const plain = new FakeSession();
    await plain.append('INBOX', simpleMessage({ text: 'only text' }), []);
    const textOnly = harness(plain);
    await expect(
      textOnly.service.downloadAttachment({ mailbox: 'INBOX', uid: 1, filename: 'nope.txt' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const gmail = harness(new FakeSession(), { provider: 'gmail', appendSent: 'auto' });
    const sent = await gmail.service.send({
      to: ['ada@example.com'],
      subject: 'g',
      text: 'hi',
    });
    expect(sent.ok).toBe(true);

    expect(() => parseAddress('')).toThrow(/empty/);
    expect(() => parseAddress('not an address')).toThrow(/parse/);
    expect(formatAddress({ name: 'Ada "A"', address: 'ada@example.com' })).toContain('Ada');
    const missing = path.join(mkdtempSync(path.join(tmpdir(), 'mail-mcp-missing-')), 'nope');
    await expect(confineToRoot(path.join(missing, 'file'), missing)).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
    });
    expect(() => loadConfig({ configPath: missing, env: {} })).toThrow(
      /Could not read configuration/,
    );
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-mcp-cfg-'));
    const file = path.join(dir, 'mail.json');
    writeFileSync(
      file,
      JSON.stringify({
        logLevel: 'debug',
        poolSize: 3,
        accounts: {
          work: {
            provider: 'generic',
            email: 'a@example.com',
            auth: {
              type: 'oauth2',
              accessToken: 'tok',
              refreshToken: 'r',
              clientId: 'c',
              clientSecret: 's',
              tokenUrl: 'https://example.test/token',
            },
            imap: {
              host: 'imap.example.com',
              tls: { caFile: '/tmp/ca.pem', servername: 'imap.example.com' },
            },
            smtp: { host: 'smtp.example.com', secure: false, starttls: 'optional', port: 587 },
            sendRateLimit: { max: 2, windowMs: 1000 },
            sentMailbox: 'Sent Items',
            trashMailbox: 'Bin',
            draftsMailbox: 'Drafts',
            recipientDomainAllowList: ['@Example.com'],
            identities: [{ email: 'a@example.com', name: 'A', replyTo: 'b@example.com' }],
            allowSend: false,
            allowDelete: false,
          },
        },
      }),
    );
    const loaded = loadConfig({ configPath: file, env: {} });
    expect(loaded.accounts.work?.sentMailbox).toBe('Sent Items');
    expect(loaded.accounts.work?.recipientDomainAllowList).toEqual(['example.com']);
    expect(loaded.accounts.work?.smtp?.starttls).toBe('optional');
    expect(() =>
      loadConfig({
        env: {
          MAIL_IMAP_HOST: 'h',
          MAIL_USER: 'u@example.com',
          MAIL_PASSWORD: 'p',
          MAIL_READONLY: 'maybe',
        },
      }),
    ).toThrow(/boolean/);
    expect(() =>
      loadConfig({
        env: {
          MAIL_IMAP_HOST: 'h',
          MAIL_USER: 'u@example.com',
          MAIL_PASSWORD: 'p',
          MAIL_LOG_LEVEL: 'loud',
        },
      }),
    ).toThrow(/MAIL_LOG_LEVEL/);
    expect(() =>
      loadConfig({
        env: {
          MAIL_IMAP_HOST: 'h',
          MAIL_USER: 'u@example.com',
          MAIL_PASSWORD: 'p',
          MAIL_POOL_SIZE: '0',
        },
      }),
    ).toThrow(/positive integer/);
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddress('"Ada \\"A\\"" <ada@example.com>').name).toContain('Ada');
    expect(formatAddressList([{ address: 'a@b.c' }, { name: 'Bea', address: 'b@c.d' }])).toContain(
      'Bea',
    );
    expect(addressToAscii('ada@example.com')).toBe('ada@example.com');
    expect(() => parseAddress('nodomain')).toThrow(/domain/);
    const bounded = andSearchUid({ query: { from: 'ada' }, requires: [] }, '1:4');
    expect(bounded.query.not).toBeTruthy();
    expect(
      compileSearch({ uid: '1:4', seq: '1', keyword: 'foo', unkeyword: 'bar' }).query,
    ).toMatchObject({ uid: '1:4' });
    expect(compileSearch({ and: [] }).query).toEqual({ all: true });
    expect(addressToAscii('local')).toBe('local');
    expect(addressToUnicode('local')).toBe('local');
    expect(isLoopback('[::1]')).toBe(true);
    expect(parseArgs(['node', 'mail-mcp', '--help', '-v', '--config=mail.json']).help).toBe(true);
    expect(parseArgs(['node', 'mail-mcp', '--port', '0']).port).toBe(0);
    expect(() => parseArgs(['node', 'mail-mcp', '--port'])).toThrow(/requires a value/);
    expect(() => parseArgs(['node', 'mail-mcp', '--port', '70000'])).toThrow(/65535/);
    const root = mkdtempSync(path.join(tmpdir(), 'mail-mcp-root-'));
    mkdirSync(path.join(root, 'sub'));
    await expect(readBoundedFile(root, 10)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const big = path.join(root, 'sub', 'big.bin');
    writeFileSync(big, Buffer.alloc(20));
    await expect(readBoundedFile(big, 5)).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    expect(() => createSmtpSender(account({ smtp: undefined }))).toThrow(MailError);
  });

  it('covers config, compose, and decode edges', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-mcp-cfg2-'));
    const file = path.join(dir, 'mail.json');
    writeFileSync(
      file,
      JSON.stringify({
        attachmentsDir: dir,
        accounts: {
          default: {
            email: 'a@example.com',
            password: 'file-secret',
            imap: { host: 'imap.example.com' },
          },
        },
      }),
    );
    const merged = loadConfig({
      configPath: file,
      env: {
        MAIL_IMAP_HOST: 'override.example.com',
        MAIL_SMTP_HOST: 'smtp.example.com',
        MAIL_PASSWORD: 'env-secret',
      },
    });
    expect(merged.accounts.default?.imap.host).toBe('override.example.com');
    expect(merged.attachmentsDir).toBe(dir);
    const bare = path.join(dir, 'bare.json');
    writeFileSync(
      bare,
      JSON.stringify({ accounts: { a: { email: 'a@example.com', imap: { host: 'h' } } } }),
    );
    expect(() => loadConfig({ configPath: bare, env: {} })).toThrow(/password/);
    const xo = path.join(dir, 'xo.json');
    writeFileSync(
      xo,
      JSON.stringify({
        accounts: {
          a: {
            email: 'a@example.com',
            imap: { host: 'h' },
            auth: { type: 'xoauth2', accessToken: 'tok' },
          },
        },
      }),
    );
    expect(loadConfig({ configPath: xo, env: {} }).accounts.a?.auth.type).toBe('xoauth2');
    writeFileSync(
      xo,
      JSON.stringify({
        accounts: { a: { email: 'a@example.com', imap: { host: 'h' }, auth: { type: 'xoauth2' } } },
      }),
    );
    expect(() => loadConfig({ configPath: xo, env: {} })).toThrow(/XOAUTH2/);
    writeFileSync(
      xo,
      JSON.stringify({
        accounts: {
          a: {
            email: 'a@example.com',
            imap: { host: 'h' },
            auth: { type: 'oauth2', clientId: 'c' },
          },
        },
      }),
    );
    expect(() => loadConfig({ configPath: xo, env: {} })).toThrow(/refreshToken/);
    expect(() =>
      loadConfig({
        env: {
          MAIL_IMAP_HOST: 'h',
          MAIL_USER: 'u@example.com',
          MAIL_PASSWORD: 'p',
          MAIL_PROVIDER: 'nope',
        },
      }),
    ).toThrow(/MAIL_PROVIDER/);
    expect(() =>
      loadConfig({
        env: {
          MAIL_IMAP_HOST: 'h',
          MAIL_USER: 'u@example.com',
          MAIL_PASSWORD: 'p',
          MAIL_ALLOW_SEND: 'false',
          MAIL_ALLOW_DELETE: 'yes',
          MAIL_READONLY: '',
        },
      }),
    ).not.toThrow();
    const built = await buildRawMessage({
      from: { name: 'A', address: 'a@example.com' },
      to: [{ address: 'b@example.com' }],
      subject: 's',
      text: 't',
      priority: 'high',
      messageId: '<m@example.com>',
      attachments: [{ filename: 'a.txt', contentBase64: Buffer.from('hi').toString('base64') }],
    });
    expect(built.toString()).toContain('a.txt');
    await expect(
      buildRawMessage({
        from: { address: 'a@example.com' },
        to: [{ address: 'b@example.com' }],
        subject: 's',
        attachments: [{ filename: 'a.txt' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(findTextPart(null)).toBeUndefined();
    expect(
      findTextPart({
        type: 'multipart',
        subtype: 'mixed',
        parameters: {},
        dispositionParameters: {},
        children: [
          {
            type: 'text',
            subtype: 'html',
            parameters: {},
            dispositionParameters: {},
            children: [],
            part: '1',
          },
          {
            type: 'text',
            subtype: 'plain',
            parameters: {},
            dispositionParameters: {},
            children: [],
            part: '2',
          },
        ],
      })?.kind,
    ).toBe('plain');
    expect(
      findTextPart({
        type: 'multipart',
        subtype: 'mixed',
        parameters: {},
        dispositionParameters: {},
        children: [
          {
            type: 'text',
            subtype: 'html',
            parameters: {},
            dispositionParameters: {},
            children: [],
            part: '1',
          },
        ],
      })?.kind,
    ).toBe('html');
    expect(decodeTransfer(Buffer.from('plain'), '8bit').toString()).toBe('plain');
    expect(decodeQuotedPrintable(Buffer.from('a=\r\nb')).toString()).toBe('ab');
    expect(decodeQuotedPrintable(Buffer.from('a=')).toString()).toContain('a');
    expect(decodeQuotedPrintable(Buffer.from('a=ZZ')).toString()).toContain('a');
    expect(decodeQuotedPrintable(Buffer.from('a=\nb')).toString()).toContain('a');
    expect(
      sortMessages(
        [
          { uid: 1, subject: undefined },
          { uid: 2, subject: undefined },
          { uid: 3, subject: 'C' },
        ],
        [{ field: 'subject' }],
      ).map((item) => item.uid),
    ).toContain(3);
    expect(
      sortMessages(
        [
          { uid: 1, date: 'not-a-date' },
          { uid: 2, date: undefined },
          { uid: 3, from: undefined, size: undefined },
          { uid: 4, from: 'a', size: 1 },
        ],
        [{ field: 'date', reverse: true }, { field: 'from' }, { field: 'size', reverse: true }],
      ).length,
    ).toBe(4);
    const sorted = sortMessages(
      [
        { uid: 1, subject: undefined, date: undefined, from: undefined, size: undefined },
        { uid: 2, subject: 'B', date: '2020-01-01T00:00:00.000Z', from: 'b', size: 2 },
      ],
      [
        { field: 'date' },
        { field: 'subject', reverse: true },
        { field: 'from' },
        { field: 'size' },
      ],
    );
    expect(sorted.map((item) => item.uid)).toContain(2);
    createSmtpSender(
      account({
        auth: {
          type: 'oauth2',
          refreshToken: 'r',
          clientId: 'c',
          clientSecret: 's',
          tokenUrl: 'https://example.test/token',
          accessToken: 'tok',
        },
        smtp: {
          host: '127.0.0.1',
          port: 1,
          secure: false,
          starttls: 'disabled',
          timeoutMs: 1000,
          tls: { rejectUnauthorized: false },
        },
      }),
      'tok',
    ).close();
  });

  it('reuses, retries, and shuts down the IMAP pool', async () => {
    const logger = createLogger({ level: 'silent' });
    let connects = 0;
    const failing = {
      async connect() {
        connects += 1;
        throw new MailError('CONNECTION_FAILED', 'down');
      },
      async logout() {
        throw new Error('logout');
      },
      close() {
        return undefined;
      },
    } as unknown as ImapSession;
    const retry = new ImapConnectionPool(async () => failing, 1, logger);
    await expect(retry.use('a', async () => 'x')).rejects.toBeInstanceOf(MailError);
    expect(connects).toBe(3);
    await retry.close();
    await expect(retry.use('a', async () => 'y')).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    });

    let opens = 0;
    const session = {
      async connect() {
        opens += 1;
        if (opens === 2) {
          throw new MailError('CONNECTION_FAILED', 'stale');
        }
      },
      async logout() {
        return undefined;
      },
      close() {
        return undefined;
      },
    } as unknown as ImapSession;
    const pool = new ImapConnectionPool(async () => session, 2, logger);
    expect(await pool.use('a', async () => 'one')).toBe('one');
    expect(await pool.use('a', async () => 'two')).toBe('two');
    await pool.close();
  });

  it('rejects a malformed HTTP body', async () => {
    const http = await startHttpServer({
      service: { config: { secrets: [] } } as never,
      logger: createLogger({ level: 'silent' }),
      host: '127.0.0.1',
      port: 0,
      token: 'tok',
    });
    const bad = await fetch(http.url, {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: '{',
    });
    expect(bad.status).toBe(500);
    await bad.text();
    const empty = await fetch(http.url, {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
    });
    expect(empty.status).toBe(400);
    await empty.text();
    await http.close();
  });
});
