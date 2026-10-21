import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import { MailService } from '../../src/service/mail-service.js';
import { TOOLS } from '../../src/tools/catalog.js';
import { createLogger } from '../../src/log.js';
import type { SmtpSender } from '../../src/smtp/client.js';
import { account, appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';
import { simpleMessage } from '../fixtures/messages.js';

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
});
