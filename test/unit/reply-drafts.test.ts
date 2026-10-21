import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ATTACHMENTS_DIR_MODE, ensureAttachmentsDir } from '../../src/fs-sandbox.js';
import { MailService } from '../../src/service/mail-service.js';
import { TOOLS } from '../../src/tools/catalog.js';
import { createLogger } from '../../src/log.js';
import type { SmtpSender } from '../../src/smtp/client.js';
import { appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';
import { multipartMixed, simpleMessage } from '../fixtures/messages.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mail-mcp-reply-'));
  cleanup.push(dir);
  return dir;
}

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
        messageId: '<sent@example.com>',
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

function rawOf(session: FakeSession, mailbox: string, uid: number): string {
  const message = session.boxes.get(mailbox)?.messages.find((item) => item.uid === uid);
  return message?.raw.toString('utf8') ?? '';
}

function headerBlock(raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n');
  const split = normalized.indexOf('\n\n');
  return split === -1 ? normalized : normalized.slice(0, split);
}

async function seedOriginal(session: FakeSession): Promise<void> {
  await session.append(
    'INBOX',
    simpleMessage({
      subject: 'Hello',
      text: 'original body',
      messageId: '<m1@example.com>',
      inReplyTo: '<older@example.com>',
      references: '<root@example.com> <older@example.com>',
      from: 'Ada Lovelace <ada@example.com>',
      to: 'User <user@example.com>',
    }),
    [],
  );
}

describe('reply and forward drafts', () => {
  it('saves a reply draft with threading headers and does not send', async () => {
    const session = new FakeSession();
    await seedOriginal(session);
    const ctx = service(session, appConfig({ allowSend: false }));
    const tool = TOOLS.find((item) => item.name === 'mail_create_reply_draft');
    expect(tool?.kind).toBe('message-write');
    const saved = await ctx.mail.saveReplyDraft({
      mailbox: 'INBOX',
      uid: 1,
      text: 'Thanks',
    });
    expect(saved).toMatchObject({
      ok: true,
      mailbox: 'Drafts',
      uid: 1,
      identityReason: 'single-match',
    });
    expect(tool?.output.safeParse(saved).success).toBe(true);
    expect(ctx.sent).toHaveLength(0);
    const draft = session.boxes.get('Drafts')?.messages[0];
    expect(draft?.flags).toContain('\\Draft');
    const raw = rawOf(session, 'Drafts', 1);
    const headers = headerBlock(raw);
    expect(headers).toMatch(/In-Reply-To:/);
    expect(headers).toContain('<m1@example.com>');
    expect(headers).toContain('<root@example.com>');
    expect(headers).toContain('<older@example.com>');
    expect(headers).toMatch(/Subject:.*Re:/);
    expect(raw).toContain('Thanks');
    expect(raw).toContain('original body');
    expect(session.boxes.get('INBOX')?.messages[0]?.flags).not.toContain('\\Answered');

    await expect(ctx.mail.reply({ mailbox: 'INBOX', uid: 1, text: 'nope' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });

    const updated = await ctx.mail.saveDraft(
      {
        to: ['ada@example.com'],
        subject: 'Re: Hello',
        text: 'updated body',
        allowEmptyRecipients: true,
      },
      Number(saved.uid),
    );
    const nextUid = Number(updated.uid);
    const updatedRaw = rawOf(session, 'Drafts', nextUid);
    const updatedHeaders = headerBlock(updatedRaw);
    expect(updatedHeaders).toContain('<m1@example.com>');
    expect(updatedHeaders).toContain('<root@example.com>');
    expect(updatedHeaders).toContain('<older@example.com>');
    expect(updatedRaw).toContain('updated body');
    expect(
      session.boxes.get('Drafts')?.messages.find((item) => item.uid === nextUid)?.flags,
    ).toContain('\\Draft');

    const before = session.boxes.get('Drafts')?.messages.length ?? 0;
    await expect(
      ctx.mail.saveDraft({ subject: 'gone', text: 'no', allowEmptyRecipients: true }, 999),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(session.boxes.get('Drafts')?.messages).toHaveLength(before);

    const writable = service(session, appConfig({ allowSend: true }));
    const submitted = await writable.mail.sendDraft({ mailbox: 'Drafts', uid: nextUid });
    expect(submitted.ok).toBe(true);
    const sentRaw = writable.sent.at(-1)?.raw.toString('utf8') ?? '';
    const sentHeaders = headerBlock(sentRaw);
    expect(sentHeaders).toContain('<m1@example.com>');
    expect(sentHeaders).toContain('<root@example.com>');
    expect(sentHeaders).toContain('<older@example.com>');
  });

  it('refuses In-Reply-To as a custom header', async () => {
    const ctx = service();
    await expect(
      ctx.mail.saveDraft({
        to: ['ada@example.com'],
        subject: 'x',
        text: 'y',
        headers: { 'In-Reply-To': '<m1@example.com>' },
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      ctx.mail.send({
        to: ['ada@example.com'],
        subject: 'x',
        text: 'y',
        headers: { References: '<m1@example.com>' },
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('saves a forward draft with the original attachment name and does not send', async () => {
    const session = new FakeSession();
    await session.append('INBOX', multipartMixed, []);
    const ctx = service(session, appConfig({ allowSend: false }));
    const saved = await ctx.mail.saveForwardDraft({
      mailbox: 'INBOX',
      uid: 1,
      to: ['bea@example.com'],
      text: 'FYI',
    });
    expect(saved.mailbox).toBe('Drafts');
    expect(ctx.sent).toHaveLength(0);
    const raw = rawOf(session, 'Drafts', Number(saved.uid));
    expect(headerBlock(raw)).not.toMatch(/^In-Reply-To:/m);
    expect(raw).toContain('notes.pdf');
    expect(raw).toContain('forwarded.eml');
    expect(raw).toContain('Fwd:');
    expect(session.boxes.get('INBOX')?.messages[0]?.flags ?? []).not.toContain('$Forwarded');
    const tool = TOOLS.find((item) => item.name === 'mail_create_forward_draft');
    expect(tool?.output.safeParse(saved).success).toBe(true);
  });
});

describe('attachment filenames', () => {
  it('uses the path basename when filename is omitted', async () => {
    const dir = tempDir();
    const invoice = path.join(dir, 'invoice.pdf');
    const receipt = path.join(dir, 'receipt.pdf');
    writeFileSync(invoice, '%PDF-1.4 invoice');
    writeFileSync(receipt, '%PDF-1.4 receipt');
    const real = path.join(dir, 'blob');
    writeFileSync(real, '%PDF-1.4 via-link');
    const link = path.join(dir, 'linked.pdf');
    symlinkSync(real, link);
    const ctx = service(new FakeSession(), appConfig({}, { attachmentsDir: dir }));

    const draft = await ctx.mail.saveDraft({
      to: ['ada@example.com'],
      subject: 'files',
      text: 'see attached',
      attachments: [{ path: invoice }, { path: receipt }, { path: link }],
    });
    const raw = rawOf(ctx.session, 'Drafts', Number(draft.uid));
    expect(raw).toContain('invoice.pdf');
    expect(raw).toContain('receipt.pdf');
    expect(raw).toContain('linked.pdf');
    expect(raw).not.toContain('attachment-1');
    expect(raw).not.toContain('blob');

    const named = path.join(dir, 'explicit-source.pdf');
    writeFileSync(named, '%PDF-1.4 named');
    const updated = await ctx.mail.saveDraft(
      {
        to: ['ada@example.com'],
        subject: 'files',
        text: 'renamed',
        attachments: [{ path: named, filename: 'custom.pdf' }],
        allowEmptyRecipients: true,
      },
      Number(draft.uid),
    );
    const updatedRaw = rawOf(ctx.session, 'Drafts', Number(updated.uid));
    expect(updatedRaw).toContain('custom.pdf');
    expect(updatedRaw).not.toContain('explicit-source.pdf');
    expect(updatedRaw).not.toContain('attachment-1');

    await ctx.mail.send({
      to: ['ada@example.com'],
      subject: 'out',
      text: 'go',
      attachments: [{ path: invoice }],
    });
    expect(ctx.sent.at(-1)?.raw.toString('utf8')).toContain('invoice.pdf');
    expect(ctx.sent.at(-1)?.raw.toString('utf8')).not.toContain('attachment-1');

    await ctx.session.append(
      'INBOX',
      simpleMessage({ subject: 'Hello', text: 'original', from: 'Ada <ada@example.com>' }),
      [],
    );
    await ctx.mail.reply({
      mailbox: 'INBOX',
      uid: 1,
      text: 'Thanks',
      attachments: [{ path: receipt }],
    });
    expect(ctx.sent.at(-1)?.raw.toString('utf8')).toContain('receipt.pdf');

    await ctx.session.append('INBOX', multipartMixed, []);
    const mixedUid = ctx.session.boxes.get('INBOX')?.messages.at(-1)?.uid ?? 0;
    await ctx.mail.forward({
      mailbox: 'INBOX',
      uid: mixedUid,
      to: ['bea@example.com'],
      text: 'FYI',
      attachments: [{ path: invoice }],
    });
    const forwarded = ctx.sent.at(-1)?.raw.toString('utf8') ?? '';
    expect(forwarded).toContain('invoice.pdf');
    expect(forwarded).toContain('notes.pdf');
    expect(forwarded).toContain('forwarded.eml');

    const bare = await ctx.mail.saveDraft({
      to: ['ada@example.com'],
      subject: 'bare',
      text: 'bytes',
      attachments: [
        { contentBase64: Buffer.from('abc').toString('base64'), contentType: 'application/pdf' },
      ],
    });
    expect(rawOf(ctx.session, 'Drafts', Number(bare.uid))).toContain('attachment-1.pdf');
  });
});

describe('attachmentsDir', () => {
  it('creates only the configured directory and reports a missing file or subdirectory', async () => {
    const parent = tempDir();
    const root = path.join(parent, 'nested', 'attachments');
    const created = await ensureAttachmentsDir(root);
    expect(created).toBe(realpathSync(root));
    expect(statSync(root).mode & 0o777).toBe(ATTACHMENTS_DIR_MODE);
    chmodSync(root, 0o755);
    await ensureAttachmentsDir(root);
    expect(statSync(root).mode & 0o777).toBe(0o755);
    rmSync(root, { recursive: true });
    await ensureAttachmentsDir(root);
    expect(statSync(root).mode & 0o777).toBe(ATTACHMENTS_DIR_MODE);

    const file = path.join(root, 'invoice.pdf');
    await writeFile(file, 'pdf');
    const ctx = service(new FakeSession(), appConfig({}, { attachmentsDir: root }));
    const saved = await ctx.mail.saveDraft({
      to: ['ada@example.com'],
      subject: 'one',
      text: 'body',
      attachments: [{ path: file }],
    });
    expect(rawOf(ctx.session, 'Drafts', Number(saved.uid))).toContain('invoice.pdf');

    const missingFile = path.join(root, 'missing.pdf');
    await expect(
      ctx.mail.saveDraft({
        to: ['ada@example.com'],
        subject: 'missing',
        text: 'body',
        attachments: [{ path: missingFile }],
      }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining(missingFile),
    });

    const missingDir = path.join(root, 'private-icloud');
    const nested = path.join(missingDir, 'secret.pdf');
    await expect(
      ctx.mail.saveDraft({
        to: ['ada@example.com'],
        subject: 'nested',
        text: 'body',
        attachments: [{ path: nested }],
      }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining(missingDir),
    });
    expect(statSync(root).isDirectory()).toBe(true);
    await expect(stat(missingDir)).rejects.toMatchObject({ code: 'ENOENT' });

    const outside = path.join(parent, 'outside.pdf');
    await writeFile(outside, 'no');
    await expect(
      ctx.mail.saveDraft({
        to: ['ada@example.com'],
        subject: 'out',
        text: 'body',
        attachments: [{ path: outside }],
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    await expect(ensureAttachmentsDir('/dev/null/mail-attachments')).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
      message: expect.stringContaining('attachmentsDir'),
      hint: expect.stringContaining('attachmentsDir'),
    });
  });

  it('creates a missing attachmentsDir before savePath and refuses a caller subdirectory', async () => {
    const parent = tempDir();
    const root = path.join(parent, 'uploads');
    const session = new FakeSession();
    await session.append('INBOX', multipartMixed, []);
    const ctx = service(session, appConfig({}, { attachmentsDir: root }));
    const saved = await ctx.mail.downloadAttachment({
      mailbox: 'INBOX',
      uid: 1,
      filename: 'notes.pdf',
      savePath: path.join(root, 'notes.pdf'),
    });
    expect(String(saved.savedPath)).toContain('notes.pdf');
    expect(statSync(root).mode & 0o777).toBe(ATTACHMENTS_DIR_MODE);

    const nested = path.join(root, 'private-icloud', 'notes.pdf');
    await expect(
      ctx.mail.downloadAttachment({
        mailbox: 'INBOX',
        uid: 1,
        filename: 'notes.pdf',
        savePath: nested,
      }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('private-icloud'),
    });
    await expect(stat(path.join(root, 'private-icloud'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('names attachmentsDir when the directory cannot be created', async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const parent = await mkdtemp(path.join(tmpdir(), 'mail-mcp-ro-'));
    cleanup.push(parent);
    chmodSync(parent, 0o555);
    const root = path.join(parent, 'attachments');
    await expect(ensureAttachmentsDir(root)).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
      message: expect.stringContaining(root),
      hint: expect.stringContaining('attachmentsDir'),
    });
  });
});
