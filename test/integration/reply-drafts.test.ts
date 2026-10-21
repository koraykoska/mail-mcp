import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime } from '../../src/runtime.js';
import { createLogger } from '../../src/log.js';
import { appConfig } from '../support/config.js';
import { ensureGreenMail, type GreenMailEndpoints } from '../support/greenmail.js';
import { simpleMessage } from '../fixtures/messages.js';

let greenmail: GreenMailEndpoints;
const cleanup: string[] = [];

function runtimeFor(attachmentsDir: string) {
  const config = appConfig(
    {
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
      appendSent: true,
    },
    { attachmentsDir },
  );
  return createRuntime({
    config,
    logger: createLogger({ level: 'silent', secrets: config.secrets }),
  });
}

function headerBlock(raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n');
  const split = normalized.indexOf('\n\n');
  return split === -1 ? normalized : normalized.slice(0, split);
}

describe('GreenMail reply drafts', () => {
  beforeAll(async () => {
    greenmail = await ensureGreenMail();
  }, 40_000);

  afterAll(() => {
    for (const dir of cleanup) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps threading headers and the attachment basename through create, update, and send', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mail-mcp-green-'));
    cleanup.push(dir);
    const invoice = path.join(dir, 'invoice.pdf');
    writeFileSync(invoice, '%PDF-1.4 invoice');
    const runtime = runtimeFor(dir);
    const service = runtime.service;
    try {
      const drafts = `Drafts-${Date.now()}`;
      await service.createMailbox(undefined, drafts);
      for (const name of ['Sent', 'Trash']) {
        await service.createMailbox(undefined, name).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : '';
          if (!/exist/i.test(message)) {
            throw error;
          }
        });
      }
      const appended = await service.append({
        mailbox: 'INBOX',
        rawBase64: simpleMessage({
          from: 'Ada Lovelace <ada@example.com>',
          to: greenmail.email,
          subject: 'Hello',
          text: 'original body',
          messageId: '<m1@example.com>',
          inReplyTo: '<older@example.com>',
          references: '<root@example.com> <older@example.com>',
        }).toString('base64'),
      });
      const sourceUid = Number(appended.uid);
      const draft = await service.saveReplyDraft({
        mailbox: 'INBOX',
        uid: sourceUid,
        draftsMailbox: drafts,
        text: 'Thanks',
        attachments: [{ path: invoice }],
      });
      expect(draft.mailbox).toBe(drafts);
      const draftUid = Number(draft.uid);
      const first = await service.getSource({ mailbox: drafts, uid: draftUid });
      const firstRaw = Buffer.from(String(first.contentBase64), 'base64').toString('utf8');
      const firstHeaders = headerBlock(firstRaw);
      expect(firstHeaders).toContain('<m1@example.com>');
      expect(firstHeaders).toContain('<root@example.com>');
      expect(firstHeaders).toContain('<older@example.com>');
      expect(firstHeaders).toMatch(/Subject:.*Re:/);
      expect(firstRaw).toContain('invoice.pdf');
      expect(firstRaw).not.toContain('attachment-1');
      const message = await service.getMessage({ mailbox: drafts, uid: draftUid });
      expect(message.flags).toEqual(expect.arrayContaining(['\\Draft']));

      const updated = await service.saveDraft(
        {
          mailbox: drafts,
          to: ['ada@example.com'],
          subject: 'Re: Hello',
          text: 'updated body',
          allowEmptyRecipients: true,
        },
        draftUid,
      );
      const nextUid = Number(updated.uid);
      const second = await service.getSource({ mailbox: drafts, uid: nextUid });
      const secondRaw = Buffer.from(String(second.contentBase64), 'base64').toString('utf8');
      const secondHeaders = headerBlock(secondRaw);
      expect(secondHeaders).toContain('<m1@example.com>');
      expect(secondHeaders).toContain('<root@example.com>');
      expect(secondHeaders).toContain('<older@example.com>');
      expect(secondRaw).toContain('updated body');

      const sent = await service.sendDraft({
        mailbox: drafts,
        uid: nextUid,
        appendSent: true,
      });
      expect(sent.ok).toBe(true);
      const appendedSent = sent.sentAppend as { mailbox?: string; uid?: number };
      expect(appendedSent.mailbox).toBeTruthy();
      expect(appendedSent.uid).toBeTypeOf('number');
      const copy = await service.getSource({
        mailbox: String(appendedSent.mailbox),
        uid: Number(appendedSent.uid),
      });
      const sentRaw = Buffer.from(String(copy.contentBase64), 'base64').toString('utf8');
      const sentHeaders = headerBlock(sentRaw);
      expect(sentHeaders).toContain('<m1@example.com>');
      expect(sentHeaders).toContain('<root@example.com>');
      expect(sentHeaders).toContain('<older@example.com>');
    } finally {
      await runtime.close();
    }
  });
});
