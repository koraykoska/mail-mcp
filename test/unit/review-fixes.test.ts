import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDirectInvocation } from '../../src/cli.js';
import { MailError } from '../../src/errors.js';
import { confineToRoot } from '../../src/fs-sandbox.js';
import { normalizeFlag } from '../../src/imap/flags.js';
import { ImapConnectionPool } from '../../src/imap/pool.js';
import type { ImapSession } from '../../src/imap/session.js';
import { pageAfterUid } from '../../src/pagination.js';
import { createLogger } from '../../src/log.js';
import { domainAllowed } from '../../src/mime/reply.js';
import { sanitizeHtml } from '../../src/mime/html.js';
import { buildRawMessage } from '../../src/mime/build.js';
import { threadMessages } from '../../src/mime/thread.js';
import { redactText } from '../../src/redact.js';
import { resolveSavePath, MailService } from '../../src/service/mail-service.js';
import { strictOutput } from '../../src/tools/schema.js';
import { TOOLS } from '../../src/tools/catalog.js';
import { z } from 'zod';
import { account, appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';
import type { SmtpSender } from '../../src/smtp/client.js';

function harness(
  session = new FakeSession(),
  overrides: Parameters<typeof appConfig>[0] = {},
  extra: Parameters<typeof appConfig>[1] = {},
) {
  const sent: Array<{ raw: Buffer; to: string[]; from: string; eightBit?: boolean }> = [];
  const smtp: SmtpSender = {
    async verify() {
      return undefined;
    },
    async send(input) {
      sent.push({
        raw: input.raw,
        to: input.envelope.to,
        from: input.envelope.from,
        eightBit: input.eightBit,
      });
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
  const config = appConfig(overrides, extra);
  const service = new MailService({
    config,
    pool: new FakePool(session),
    smtpFactory: async () => smtp,
    logger: createLogger({ level: 'silent', secrets: config.secrets }),
  });
  return { service, session, sent, config };
}

describe('review fixes', () => {
  it('resolves the bin through a symlink', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-mcp-bin-'));
    const real = path.join(dir, 'cli.js');
    const link = path.join(dir, 'mail-mcp');
    writeFileSync(real, '#!/usr/bin/env node\n');
    symlinkSync(real, link);
    expect(isDirectInvocation(link, pathToFileURL(real).href)).toBe(true);
  });

  it('rejects an envelope recipient outside the allow list', async () => {
    const { service, sent } = harness(new FakeSession(), {
      recipientDomainAllowList: ['example.com'],
    });
    await expect(
      service.send({
        to: ['ada@example.com'],
        envelopeTo: ['spy@evil.test'],
        subject: 'x',
        text: 'y',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(sent).toHaveLength(0);
  });

  it('rejects an envelope From that is not an identity', async () => {
    const { service } = harness();
    await expect(
      service.send({
        to: ['ada@example.com'],
        envelopeFrom: 'other@example.com',
        subject: 'x',
        text: 'y',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('stores Bcc on a draft and strips it from the submitted bytes', async () => {
    const session = new FakeSession();
    const { service, sent } = harness(session);
    const saved = await service.saveDraft({
      to: ['ada@example.com'],
      bcc: ['hidden@example.com'],
      subject: 'd',
      text: 'body',
    });
    const uid = Number(saved.uid);
    const raw = session.boxes.get('Drafts')?.messages.find((message) => message.uid === uid)?.raw;
    expect(raw?.toString('utf8')).toMatch(/Bcc:/i);
    expect(session.boxes.get('Drafts')?.messages[0]?.flags).toEqual(['\\Draft']);
    await service.sendDraft({ mailbox: 'Drafts', uid });
    expect(sent[0]?.to).toContain('hidden@example.com');
    expect(sent[0]?.raw.toString('utf8')).not.toMatch(/^Bcc:/im);
  });

  it('rejects bulk lists above maxBulk before changing mail', async () => {
    const session = new FakeSession();
    await session.append('INBOX', Buffer.from('Subject: a\r\n\r\n'), []);
    await session.append('INBOX', Buffer.from('Subject: b\r\n\r\n'), []);
    await session.append('INBOX', Buffer.from('Subject: c\r\n\r\n'), []);
    const { service } = harness(session, { limits: { ...account().limits, maxBulk: 2 } });
    await expect(
      service.bulk({ mailbox: 'INBOX', uids: [1, 2, 3], action: 'addFlags', flags: ['\\Seen'] }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    expect(
      session.boxes.get('INBOX')?.messages.every((message) => message.flags.length === 0),
    ).toBe(true);
  });

  it('honors allowEmptyRecipients false', async () => {
    const { service } = harness();
    await expect(
      service.append({ mailbox: 'INBOX', subject: 'x', text: 'y', allowEmptyRecipients: false }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('treats adding \\Deleted as a delete', async () => {
    const { service } = harness(new FakeSession(), { allowDelete: false });
    await expect(
      service.setFlags({
        mailbox: 'INBOX',
        uids: [1],
        flags: ['\\Deleted'],
        operation: 'add',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('refuses \\Recent', () => {
    expect(() => normalizeFlag('\\Recent')).toThrow(MailError);
    expect(() => normalizeFlag('recent')).toThrow(/Recent/);
  });

  it('does not report a missing UID as updated', async () => {
    const session = new FakeSession();
    await session.append('INBOX', Buffer.from('Subject: a\r\n\r\n'), []);
    const { service } = harness(session);
    const result = await service.setFlags({
      mailbox: 'INBOX',
      uids: [1, 999999],
      flags: ['\\Seen'],
      operation: 'add',
    });
    expect(result.ok).toBe(false);
    const rows = result.results as Array<{ uid: number; ok: boolean }>;
    expect(rows.find((row) => row.uid === 999999)?.ok).toBe(false);
    expect(rows.find((row) => row.uid === 1)?.ok).toBe(true);
  });

  it('refuses UID expunge without UIDPLUS', async () => {
    const session = new FakeSession(['IMAP4rev1', 'MOVE']);
    await session.append('INBOX', Buffer.from('Subject: a\r\n\r\n'), ['\\Deleted']);
    await session.append('INBOX', Buffer.from('Subject: b\r\n\r\n'), []);
    const { service } = harness(session, { allowPermanentDelete: true, allowDelete: true });
    await expect(
      service.deleteMessages({ mailbox: 'INBOX', uids: [2], permanent: true }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(session.boxes.get('INBOX')?.messages).toHaveLength(2);
  });

  it('walks References past a missing parent', () => {
    const tree = threadMessages([
      { uid: 1, messageId: '<g@ex>', subject: 'root' },
      {
        uid: 2,
        messageId: '<c@ex>',
        inReplyTo: '<missing@ex>',
        references: ['<g@ex>', '<missing@ex>'],
        subject: 'child',
      },
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children[0]?.uid).toBe(2);
  });

  it('matches an IDN allow-list entry', () => {
    expect(domainAllowed('user@例子.中国', ['例子.中国'])).toBe(true);
  });

  it('pages after the last UID when a newer message arrives', () => {
    const first = pageAfterUid([4, 3, 2, 1], 2, undefined, '9');
    expect(first.uids).toEqual([4, 3]);
    const second = pageAfterUid([5, 4, 3, 2, 1], 2, 3, '9');
    expect(second.uids).toEqual([2, 1]);
  });

  it('strips scripts and javascript URLs from HTML', () => {
    const clean = sanitizeHtml(
      '<p>Hi</p><script>alert(1)</script><a href="javascript:alert(3)">x</a>',
    );
    expect(clean).not.toContain('<script');
    expect(clean.toLowerCase()).not.toContain('javascript:');
    expect(clean).toContain('Hi');
  });

  it('keeps Bcc when composing a stored draft', async () => {
    const raw = await buildRawMessage(
      {
        from: { address: 'user@example.com' },
        to: [{ address: 'ada@example.com' }],
        bcc: [{ address: 'hidden@example.com' }],
        subject: 's',
        text: 't',
      },
      { keepBcc: true },
    );
    expect(raw.toString('utf8')).toMatch(/hidden@example.com/);
  });

  it('redacts short secrets', () => {
    expect(redactText('password is ab', ['ab'])).not.toContain('ab');
  });

  it('does not treat ..secret as a path escape', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-mcp-save-'));
    expect(resolveSavePath(path.join(dir, '..secret'), dir)).toContain('..secret');
  });

  it('rejects a symlink that leaves attachmentsDir', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mail-mcp-root-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'mail-mcp-out-'));
    mkdirSync(path.join(root, 'link'), { recursive: true });
    symlinkSync(outside, path.join(root, 'link', 'escape'));
    await expect(
      confineToRoot(path.join(root, 'link', 'escape', 'file.txt'), root),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await writeFile(path.join(root, '..secret'), 'ok');
    const kept = await confineToRoot(path.join(root, '..secret'), root);
    expect(await readFile(kept, 'utf8')).toBe('ok');
  });

  it('opens only one connection when the pool size is 1', async () => {
    let active = 0;
    let peak = 0;
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
    const pool = new ImapConnectionPool(
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return session;
      },
      1,
      createLogger({ level: 'silent' }),
    );
    await Promise.all([pool.use('a', async () => 'one'), pool.use('a', async () => 'two')]);
    expect(peak).toBe(1);
    await pool.close();
  });

  it('declares a strict output schema for every tool', () => {
    const sample = strictOutput({ ok: z.boolean(), account: z.string() });
    expect(sample.safeParse({ ok: true, account: 'a', extra: 1 }).success).toBe(false);
    expect(TOOLS.length).toBeGreaterThan(30);
    for (const tool of TOOLS) {
      expect(tool.output.safeParse({ ok: true }).success).toBe(false);
    }
  });
});
