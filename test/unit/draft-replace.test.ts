import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import { MailService } from '../../src/service/mail-service.js';
import { TOOLS } from '../../src/tools/catalog.js';
import { createLogger } from '../../src/log.js';
import type { SmtpSender } from '../../src/smtp/client.js';
import { account, appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';
import { simpleMessage } from '../fixtures/messages.js';
import { parseRawMessage } from '../../src/mime/parse.js';

function service(session = new FakeSession(), config = appConfig()) {
  const smtp: SmtpSender = {
    async verify() {
      return undefined;
    },
    async send() {
      return {
        accepted: [],
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
  return new MailService({
    config,
    pool: new FakePool(session),
    smtpFactory: async () => smtp,
    logger: createLogger({ level: 'silent' }),
  });
}

function draftUids(session: FakeSession): number[] {
  return (session.boxes.get('Drafts')?.messages ?? []).map((message) => message.uid);
}

function draftText(session: FakeSession, uid: number): string {
  return (
    session.boxes
      .get('Drafts')
      ?.messages.find((message) => message.uid === uid)
      ?.raw.toString('utf8') ?? ''
  );
}

async function seedDraft(mail: MailService): Promise<number> {
  const saved = await mail.saveDraft({
    to: ['ada@example.com'],
    subject: 'Draft',
    text: 'old body',
    allowEmptyRecipients: true,
  });
  return Number(saved.uid);
}

const replacement = {
  to: ['ada@example.com'],
  subject: 'Draft',
  text: 'new body',
  allowEmptyRecipients: true as const,
};

describe('draft replace', () => {
  it('keeps both drafts when MOVE throws before any change', async () => {
    const session = new FakeSession();
    const mail = service(session);
    const uid = await seedDraft(mail);
    session.moveFault = new MailError('NOT_FOUND', 'move failed before the message changed');
    const updated = await mail.saveDraft(replacement, uid);
    const tool = TOOLS.find((item) => item.name === 'mail_update_draft');
    expect(tool?.output.safeParse(updated).success).toBe(true);
    expect(updated.ok).toBe(false);
    expect(updated.replacedUid).toBeNull();
    expect(updated.warning).toBe(
      `Draft UID ${uid} is still in Drafts. The new draft was kept as UID ${updated.uid}.`,
    );
    expect(draftUids(session)).toEqual([uid, Number(updated.uid)]);
    expect(draftText(session, uid)).toContain('old body');
    expect(draftText(session, Number(updated.uid))).toContain('new body');
    expect(session.boxes.get('Trash')?.messages ?? []).toHaveLength(0);
  });

  it('keeps both drafts when the connection drops during MOVE', async () => {
    const session = new FakeSession();
    const mail = service(session);
    const uid = await seedDraft(mail);
    session.moveFault = new MailError('CONNECTION_FAILED', 'connection lost');
    const updated = await mail.saveDraft(replacement, uid);
    expect(updated.ok).toBe(false);
    expect(updated.replacedUid).toBeNull();
    expect(updated.warning).toBe(
      `Draft UID ${uid} is still in Drafts. The new draft was kept as UID ${updated.uid}.`,
    );
    expect(draftUids(session)).toEqual([uid, Number(updated.uid)]);
    expect(draftText(session, Number(updated.uid))).toContain('new body');
  });

  it('keeps both drafts when MOVE returns PROTOCOL_ERROR', async () => {
    const session = new FakeSession();
    const mail = service(session);
    const uid = await seedDraft(mail);
    session.moveFault = new MailError('PROTOCOL_ERROR', 'server rejected the move');
    const updated = await mail.saveDraft(replacement, uid);
    expect(updated.ok).toBe(false);
    expect(updated.replacedUid).toBeNull();
    expect(String(updated.warning)).toContain(`Draft UID ${uid} is still in Drafts`);
    expect(draftUids(session)).toEqual([uid, Number(updated.uid)]);
  });

  it('does not claim the old draft is still there when the move fails after removal and the probe fails', async () => {
    const session = new FakeSession();
    const mail = service(session);
    const uid = await seedDraft(mail);
    session.moveFaultAfterRemove = new MailError(
      'PROTOCOL_ERROR',
      'response lost after the move removed the draft',
    );
    session.summaryFault = new MailError('CONNECTION_FAILED', 'probe failed');
    session.summaryFaultSkips = 1;
    const updated = await mail.saveDraft(replacement, uid);
    expect(updated.ok).toBe(false);
    expect(updated.replacedUid).toBeNull();
    expect(updated.warning).toBe(
      `Could not confirm that draft UID ${uid} was removed from Drafts. The new draft was kept as UID ${updated.uid}. The old draft was left in place if it is still there.`,
    );
    expect(String(updated.warning)).not.toContain('is still in Drafts');
    expect(draftUids(session)).toEqual([Number(updated.uid)]);
    expect(draftText(session, Number(updated.uid))).toContain('new body');
    const trash = session.boxes.get('Trash')?.messages ?? [];
    expect(trash.some((message) => message.raw.toString('utf8').includes('old body'))).toBe(true);
    expect(trash.some((message) => message.raw.toString('utf8').includes('new body'))).toBe(false);
  });

  it('does not claim the old draft is gone when removal cannot be confirmed', async () => {
    const session = new FakeSession();
    const mail = service(session);
    const uid = await seedDraft(mail);
    session.moveFault = new MailError('CONNECTION_FAILED', 'connection lost');
    session.summaryFault = new MailError('CONNECTION_FAILED', 'probe failed');
    session.summaryFaultSkips = 1;
    const updated = await mail.saveDraft(replacement, uid);
    expect(updated.ok).toBe(false);
    expect(updated.replacedUid).toBeNull();
    expect(updated.warning).toBe(
      `Could not confirm that draft UID ${uid} was removed from Drafts. The new draft was kept as UID ${updated.uid}. The old draft was left in place if it is still there.`,
    );
    expect(draftUids(session)).toEqual([uid, Number(updated.uid)]);
  });

  it('keeps the new draft when the old one is already in Trash and the delete then throws', async () => {
    const session = new FakeSession();
    const mail = service(session);
    const uid = await seedDraft(mail);
    session.moveFaultAfterRemove = new MailError(
      'NOT_FOUND',
      'move completed then the response was lost',
    );
    const updated = await mail.saveDraft(replacement, uid);
    expect(updated).toMatchObject({ ok: true, replacedUid: uid });
    expect(updated.warning).toBeUndefined();
    expect(draftUids(session)).toEqual([Number(updated.uid)]);
    expect(draftText(session, Number(updated.uid))).toContain('new body');
    const trash = session.boxes.get('Trash')?.messages ?? [];
    expect(trash).toHaveLength(1);
    expect(trash[0]?.raw.toString('utf8')).toContain('old body');
    expect(trash.some((message) => message.raw.toString('utf8').includes('new body'))).toBe(false);
  });

  it('keeps the new draft when expunge removes the old UID and then throws', async () => {
    const session = new FakeSession();
    const mail = service(session, appConfig({ allowPermanentDelete: true }));
    const uid = await seedDraft(mail);
    session.expungeFaultAfterRemove = new MailError('NOT_FOUND', 'expunge lost the response');
    const updated = await mail.saveDraft(replacement, uid);
    const tool = TOOLS.find((item) => item.name === 'mail_update_draft');
    expect(tool?.output.safeParse(updated).success).toBe(true);
    expect(updated).toMatchObject({ ok: true, replacedUid: uid });
    expect(updated.warning).toBeUndefined();
    expect(draftUids(session)).toEqual([Number(updated.uid)]);
    expect(draftText(session, Number(updated.uid))).toContain('new body');
    expect(session.boxes.get('Trash')?.messages ?? []).toHaveLength(0);
  });

  it('checks uidValidity before appending a replacement', async () => {
    const session = new FakeSession();
    const mail = service(session);
    const uid = await seedDraft(mail);
    const tool = TOOLS.find((item) => item.name === 'mail_update_draft');
    expect(tool?.input.shape.uidValidity).toBeDefined();
    const updated = await tool?.run(
      { uid, uidValidity: '100', subject: 'Draft', text: 'replaced', to: ['ada@example.com'] },
      mail,
    );
    expect(updated).toMatchObject({ ok: true, replacedUid: uid });
    expect(tool?.output.safeParse(updated).success).toBe(true);
    expect(draftUids(session)).toEqual([Number(updated?.uid)]);
    const before = draftUids(session);
    await expect(
      mail.saveDraft({ ...replacement, uidValidity: '999' }, Number(updated?.uid)),
    ).rejects.toMatchObject({ code: 'UIDVALIDITY_CHANGED' });
    expect(draftUids(session)).toEqual(before);
  });

  it('does not delete the new draft when UIDVALIDITY changes and the appended UID reuses the old number', async () => {
    const session = new FakeSession();
    const mail = service(session);
    const uid = await seedDraft(mail);
    expect(uid).toBe(1);
    session.beforeNextAppend = (box) => {
      box.messages = [];
      box.uidValidity = '200';
      box.uidNext = 1;
    };
    const updated = await mail.saveDraft(replacement, uid);
    const tool = TOOLS.find((item) => item.name === 'mail_update_draft');
    expect(tool?.output.safeParse(updated).success).toBe(true);
    expect(updated.ok).toBe(false);
    expect(updated.replacedUid).toBeNull();
    expect(updated.uid).toBe(1);
    expect(updated.warning).toBe(
      'Draft UID 1 is the message just appended, so it was not deleted. The new draft was kept as UID 1.',
    );
    expect(draftUids(session)).toEqual([1]);
    expect(draftText(session, 1)).toContain('new body');
    expect(session.boxes.get('Trash')?.messages ?? []).toHaveLength(0);
  });

  it('does not delete when the appended UID matches even if UIDVALIDITY stays the same', async () => {
    const session = new FakeSession();
    const mail = service(session);
    const uid = await seedDraft(mail);
    session.beforeNextAppend = (box) => {
      box.messages = [];
      box.uidNext = 1;
    };
    const updated = await mail.saveDraft(replacement, uid);
    expect(updated.ok).toBe(false);
    expect(updated.replacedUid).toBeNull();
    expect(draftUids(session)).toEqual([1]);
    expect(draftText(session, 1)).toContain('new body');
  });

  it('keeps the new draft when UIDVALIDITY changes before the delete and the new UID is different', async () => {
    const session = new FakeSession();
    const mail = service(session);
    const uid = await seedDraft(mail);
    session.beforeNextAppend = (box) => {
      box.messages = [];
      box.uidValidity = '200';
      box.uidNext = 5;
    };
    const updated = await mail.saveDraft(replacement, uid);
    expect(updated.ok).toBe(false);
    expect(updated.replacedUid).toBeNull();
    expect(updated.uid).toBe(5);
    expect(String(updated.warning)).toContain('Could not confirm that draft UID 1 was removed');
    expect(draftUids(session)).toEqual([5]);
    expect(draftText(session, 5)).toContain('new body');
  });

  it('leaves the original in place when UIDVALIDITY changes after a copy and before expunge', async () => {
    const session = new FakeSession(['IMAP4rev1', 'UIDPLUS']);
    await session.append(
      'INBOX',
      simpleMessage({
        subject: 'Keep',
        text: 'original',
        from: 'Ada <ada@example.com>',
        to: 'User <user@example.com>',
      }),
      [],
    );
    const mail = service(session);
    session.afterNextCopy = (box) => {
      box.uidValidity = '200';
    };
    await expect(
      mail.deleteMessages({ mailbox: 'INBOX', uids: [1], permanent: false }),
    ).rejects.toMatchObject({ code: 'UIDVALIDITY_CHANGED' });
    expect(session.boxes.get('INBOX')?.messages).toHaveLength(1);
    expect(session.boxes.get('INBOX')?.messages[0]?.raw.toString('utf8')).toContain('original');
    expect(session.boxes.get('Trash')?.messages).toHaveLength(1);
  });

  it('refuses a draft over maxMessageBytes before append', async () => {
    const created = new FakeSession();
    const create = service(
      created,
      appConfig({ limits: { ...account().limits, maxMessageBytes: 80 } }),
    );
    await expect(
      create.saveDraft({
        to: ['ada@example.com'],
        subject: 'Big',
        text: 'x'.repeat(200),
        allowEmptyRecipients: true,
      }),
    ).rejects.toMatchObject({
      code: 'SIZE_LIMIT',
      message: expect.stringMatching(/over maxMessageBytes/),
    });
    expect(draftUids(created)).toEqual([]);

    const session = new FakeSession();
    await session.append(
      'INBOX',
      simpleMessage({
        subject: 'Hello',
        text: 'original',
        from: 'Ada Lovelace <ada@example.com>',
        to: 'User <user@example.com>',
      }),
      [],
    );
    const reply = service(
      session,
      appConfig({ limits: { ...account().limits, maxMessageBytes: 80 } }),
    );
    await expect(
      reply.saveReplyDraft({ mailbox: 'INBOX', uid: 1, text: 'x'.repeat(200) }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    await expect(
      reply.saveForwardDraft({
        mailbox: 'INBOX',
        uid: 1,
        to: ['bea@example.com'],
        text: 'x'.repeat(200),
      }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    expect(draftUids(session)).toEqual([]);

    const existing = new FakeSession();
    const mail = service(existing);
    const uid = await seedDraft(mail);
    const tight = service(
      existing,
      appConfig({ limits: { ...account().limits, maxMessageBytes: 2000 } }),
    );
    await expect(
      tight.saveDraft(
        {
          to: ['ada@example.com'],
          subject: 'Draft',
          text: 'y'.repeat(5000),
          allowEmptyRecipients: true,
        },
        uid,
      ),
    ).rejects.toMatchObject({
      code: 'SIZE_LIMIT',
      message: expect.stringMatching(/over maxMessageBytes/),
    });
    expect(draftUids(existing)).toEqual([uid]);
    expect(draftText(existing, uid)).toContain('old body');
  });

  it('saves and sends a 998-character subject and a 5000-character subject', async () => {
    const session = new FakeSession();
    const mail = service(session);
    for (const length of [998, 5000]) {
      const subject = 'a'.repeat(length);
      const draft = await mail.saveDraft({
        to: ['ada@example.com'],
        subject,
        text: 'body',
        allowEmptyRecipients: true,
      });
      const stored = session.boxes
        .get('Drafts')
        ?.messages.find((message) => message.uid === draft.uid);
      expect(stored).toBeTruthy();
      expectHeaderLines(stored?.raw ?? Buffer.alloc(0));
      expect((await parseRawMessage(stored?.raw ?? Buffer.alloc(0))).subject).toBe(subject);

      const sent = await mail.send({ to: ['ada@example.com'], subject, text: 'body' });
      expect(sent.ok).toBe(true);
      const submitted = session.boxes.get('Sent')?.messages.at(-1)?.raw ?? Buffer.alloc(0);
      expectHeaderLines(submitted);
      expect((await parseRawMessage(submitted)).subject).toBe(subject);
    }
  });
});

function expectHeaderLines(raw: Buffer): void {
  const text = raw.toString('binary');
  const headerEnd = text.indexOf('\r\n\r\n');
  const block = headerEnd === -1 ? text : text.slice(0, headerEnd);
  for (const line of block.split('\r\n')) {
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(998);
  }
}
