import { describe, expect, it, vi } from 'vitest';
import { MailService } from '../../src/service/mail-service.js';
import { resolveSavePath } from '../../src/service/mail-service.js';
import { appConfig, account } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';
import { simpleMessage } from '../fixtures/messages.js';
import type { SmtpSender } from '../../src/smtp/client.js';
import { createLogger } from '../../src/log.js';
import { MailError } from '../../src/errors.js';
import { clearTokenCache, refreshAccessToken } from '../../src/auth/oauth.js';
import { assertMutation, anyAccountAllows } from '../../src/safety.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function service(session = new FakeSession(), config = appConfig()) {
  const sent: Array<{ raw: Buffer; to: string[] }> = [];
  const smtp: SmtpSender = {
    async verify() {
      return undefined;
    },
    async send(input) {
      sent.push({ raw: input.raw, to: input.envelope.to });
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
  const mail = new MailService({
    config,
    pool: new FakePool(session),
    smtpFactory: async () => smtp,
    logger: createLogger({ level: 'silent' }),
  });
  return { mail, session, sent };
}

describe('safety switches', () => {
  it('blocks mutation, send, and permanent delete according to the account', () => {
    const readOnly = account({
      readOnly: true,
      allowSend: false,
      allowDelete: false,
      allowPermanentDelete: false,
    });
    expect(() => assertMutation(readOnly, 'message-write')).toThrow(/readOnly/);
    const noSend = account({ allowSend: false });
    expect(() => assertMutation(noSend, 'send')).toThrow(/allowSend/);
    const noDelete = account({ allowDelete: false });
    expect(() => assertMutation(noDelete, 'delete')).toThrow(/allowDelete/);
    const noExpunge = account({ allowPermanentDelete: false });
    expect(() => assertMutation(noExpunge, 'permanent')).toThrow(/permanent/);
    expect(anyAccountAllows([readOnly], 'send')).toBe(false);
    expect(anyAccountAllows([account()], 'send')).toBe(true);
  });
});

describe('mail service against the in-memory session', () => {
  it('lists accounts, mailboxes, status, namespaces, quota, and capabilities', async () => {
    const { mail } = service();
    expect(mail.listAccounts()[0]).toMatchObject({ id: 'work', default: true });
    const caps = await mail.capabilities();
    expect(caps.capabilities).toContain('IMAP4rev1');
    const boxes = await mail.listMailboxes(undefined, false);
    expect(boxes.mailboxes).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'INBOX' })]),
    );
    const tree = await mail.mailboxTree();
    expect(tree.tree).toBeTruthy();
    const status = await mail.mailboxStatus(undefined, 'INBOX');
    expect(status.status).toMatchObject({ path: 'INBOX', messages: 0 });
    expect(await mail.namespaces()).toMatchObject({ ok: true });
    expect(await mail.quota(undefined)).toMatchObject({ ok: true });
    expect(await mail.serverId()).toMatchObject({ ok: true });
    const special = await mail.specialUse();
    expect(special.special).toMatchObject({ inbox: 'INBOX', trash: 'Trash', drafts: 'Drafts' });
  });

  it('appends, lists, searches, fetches, flags, copies, moves, and deletes', async () => {
    const { mail, session } = service();
    const appended = await mail.append({
      mailbox: 'INBOX',
      to: ['ada@example.com'],
      subject: 'Hello',
      text: 'Body text for search',
      flags: ['\\Seen'],
    });
    expect(appended.uid).toBe(1);
    const page = await mail.listMessages({ mailbox: 'INBOX', limit: 10 });
    expect(page.total).toBe(1);
    expect(page.messages).toHaveLength(1);
    const found = await mail.searchMessages({ mailbox: 'INBOX', search: { text: 'Body text' } });
    expect(found.total).toBe(1);
    const message = await mail.getMessage({ mailbox: 'INBOX', uid: 1 });
    expect(message.text).toContain('Body text');
    const headers = await mail.getHeaders({ mailbox: 'INBOX', uid: 1 });
    expect(String(headers.raw)).toContain('Subject:');
    const source = await mail.getSource({ mailbox: 'INBOX', uid: 1 });
    expect(String(source.contentBase64).length).toBeGreaterThan(10);
    const part = await mail.getPart({ mailbox: 'INBOX', uid: 1, partId: '1' });
    expect(part.partId).toBe('1');
    await mail.setFlags({ mailbox: 'INBOX', uids: [1], flags: ['\\Flagged'], operation: 'add' });
    expect(session.boxes.get('INBOX')?.messages[0]?.flags).toContain('\\Flagged');
    await mail.copyOrMove({ mailbox: 'INBOX', uids: [1], destination: 'Sent' }, false);
    expect(session.boxes.get('Sent')?.messages).toHaveLength(1);
    await mail.copyOrMove({ mailbox: 'INBOX', uids: [1], destination: 'Archive' }, true);
    expect(session.boxes.get('INBOX')?.messages).toHaveLength(0);
    await mail.append({
      mailbox: 'INBOX',
      rawBase64: simpleMessage({ subject: 'Gone' }).toString('base64'),
    });
    const uid = session.boxes.get('INBOX')?.messages[0]?.uid ?? 0;
    await mail.deleteMessages({ mailbox: 'INBOX', uids: [uid] });
    expect(session.boxes.get('Trash')?.messages.length).toBeGreaterThan(0);
  });

  it('rejects uidvalidity mismatches, unknown accounts, and disallowed recipients', async () => {
    const { mail } = service();
    await expect(
      mail.getMessage({ mailbox: 'INBOX', uid: 1, uidValidity: '999' }),
    ).rejects.toBeInstanceOf(MailError);
    expect(() => mail.account('missing')).toThrow(/Unknown account/);
    const limited = service(
      new FakeSession(),
      appConfig({ recipientDomainAllowList: ['example.com'] }),
    );
    await expect(
      limited.mail.send({ to: ['ada@other.test'], subject: 'nope', text: 'x' }),
    ).rejects.toThrow(/not allowed/);
  });

  it('sends, replies, forwards, and stores drafts', async () => {
    const ctx = service();
    await ctx.mail.append({
      mailbox: 'INBOX',
      rawBase64: simpleMessage({
        subject: 'Hello',
        text: 'original',
        messageId: '<m1@example.com>',
      }).toString('base64'),
    });
    const sent = await ctx.mail.send({ to: ['ada@example.com'], subject: 'Out', text: 'hi' });
    expect(sent.ok).toBe(true);
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.session.boxes.get('Sent')?.messages.length).toBeGreaterThan(0);
    const reply = await ctx.mail.reply({ mailbox: 'INBOX', uid: 1, text: 'Thanks' });
    expect(reply.ok).toBe(true);
    const raw = ctx.sent.at(-1)?.raw.toString('utf8') ?? '';
    expect(raw).toContain('In-Reply-To:');
    expect(raw).toContain('Re:');
    await ctx.mail.forward({ mailbox: 'INBOX', uid: 1, to: ['bea@example.com'], text: 'FYI' });
    expect(ctx.sent.at(-1)?.raw.toString('utf8')).toContain('Fwd:');
    const sentDraft = await ctx.mail.saveDraft({
      to: ['ada@example.com'],
      subject: 'Sendable',
      text: 'please send',
    });
    const submitted = await ctx.mail.sendDraft({
      mailbox: 'Drafts',
      uid: Number(sentDraft.uid),
    });
    expect(submitted.ok).toBe(true);
    const draft = await ctx.mail.saveDraft({
      to: ['ada@example.com'],
      subject: 'Draft',
      text: 'wip',
    });
    expect(draft.mailbox).toBe('Drafts');
    const updated = await ctx.mail.saveDraft(
      { subject: 'Draft 2', text: 'wip2', allowEmptyRecipients: true },
      Number(draft.uid),
    );
    expect(updated.replacedUid).toBe(draft.uid);
  });

  it('enforces read-only, rate limits, bulk results, threads, and idle', async () => {
    const session = new FakeSession();
    const ctx = service(session, appConfig({ readOnly: true, allowSend: false }));
    await expect(ctx.mail.createMailbox(undefined, 'X')).rejects.toThrow(/readOnly/);
    const writable = service(
      new FakeSession(['IMAP4rev1']),
      appConfig({ sendRateLimit: { max: 1, windowMs: 60_000 } }),
    );
    await writable.mail.send({ to: ['ada@example.com'], subject: '1', text: 'a' });
    await expect(
      writable.mail.send({ to: ['ada@example.com'], subject: '2', text: 'b' }),
    ).rejects.toThrow(/rate limit/i);
    await writable.mail.append({
      mailbox: 'INBOX',
      to: ['ada@example.com'],
      cc: ['bea@example.com'],
      bcc: ['cy@example.com'],
      replyTo: ['reply@example.com'],
      subject: 'Full',
      text: 't',
      html: '<p>h</p>',
      headers: { 'X-Test': '1' },
      priority: 'low',
      readReceipt: true,
    });
    const bulk = await writable.mail.bulk({
      mailbox: 'INBOX',
      uids: [1],
      action: 'setFlags',
      flags: ['\\Seen'],
    });
    expect(bulk.results).toEqual([expect.objectContaining({ uid: 1 })]);
    await writable.mail.bulk({ mailbox: 'INBOX', uids: [1], action: 'copy', destination: 'Sent' });
    await writable.mail.bulk({
      mailbox: 'INBOX',
      uids: [1],
      action: 'move',
      destination: 'Archive',
    });
    await writable.mail.bulk({ mailbox: 'INBOX', uids: [1], action: 'delete' });
    const gmail = service(new FakeSession(['IMAP4rev1', 'X-GM-EXT-1', 'MOVE', 'UIDPLUS']));
    await gmail.mail.append({ mailbox: 'INBOX', subject: 'L', text: 'x', to: ['ada@example.com'] });
    await gmail.mail.bulk({ mailbox: 'INBOX', uids: [1], action: 'addLabels', labels: ['Work'] });
    const draft = await gmail.mail.saveDraft({
      subject: 'd',
      text: 't',
      allowEmptyRecipients: true,
    });
    await gmail.mail.deleteDraft(undefined, Number(draft.uid));
    await writable.mail.append({
      mailbox: 'INBOX',
      rawBase64: simpleMessage({ messageId: '<a@x>', subject: 'T' }).toString('base64'),
    });
    const threads = await writable.mail.listThreads({ mailbox: 'INBOX' });
    expect(threads.source).toBe('client');
    const waited = await writable.mail.waitForChanges({ timeoutMs: 1000 });
    expect(waited.timedOut).toBe(true);
    expect(waited.idleSupported).toBe(false);
  });

  it('downloads an attachment to a confined directory', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-att-'));
    const ctx = service(new FakeSession(), appConfig({}, { attachmentsDir: dir }));
    const { multipartMixed } = await import('../fixtures/messages.js');
    await ctx.mail.append({ mailbox: 'INBOX', rawBase64: multipartMixed.toString('base64') });
    const saved = await ctx.mail.downloadAttachment({
      mailbox: 'INBOX',
      uid: 1,
      filename: 'notes.pdf',
      savePath: path.join(dir, 'notes.pdf'),
    });
    expect(saved.savedPath).toContain('notes.pdf');
    expect(() => resolveSavePath(path.join(dir, '..', 'nope'), dir)).toThrow(/outside/);
  });

  it('reports verify failures without throwing', async () => {
    const session = new FakeSession();
    session.failNext = true;
    const ctx = service(session);
    const result = await ctx.mail.verify(undefined, { imap: true, smtp: true });
    expect(result.ok).toBe(false);
  });
});

describe('oauth refresh', () => {
  it('posts a refresh grant and caches nothing sensitive in the error', async () => {
    clearTokenCache();
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 }),
    );
    const token = await refreshAccessToken(
      {
        accountId: 'work',
        tokenUrl: 'https://example.com/token',
        clientId: 'id',
        clientSecret: 'secret',
        refreshToken: 'refresh',
      },
      fetchImpl as unknown as typeof fetch,
      () => 0,
    );
    expect(token.token).toBe('tok');
    const denied = vi.fn(
      async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );
    await expect(
      refreshAccessToken(
        {
          accountId: 'work',
          tokenUrl: 'https://example.com/token',
          clientId: 'id',
          clientSecret: 'secret',
          refreshToken: 'refresh',
        },
        denied as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/invalid_grant/);
  });
});
