import { describe, expect, it } from 'vitest';
import { routingHeaderDenied } from '../../src/mime/outbound-headers.js';
import { MailService } from '../../src/service/mail-service.js';
import { TOOLS } from '../../src/tools/catalog.js';
import { createLogger } from '../../src/log.js';
import { simpleMessage } from '../fixtures/messages.js';
import { appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';
import type { SmtpSender } from '../../src/smtp/client.js';

function serviceFor(
  session: FakeSession,
  overrides: Parameters<typeof appConfig>[0] = {},
  smtp?: SmtpSender,
): MailService {
  return new MailService({
    config: appConfig({ appendSent: false, ...overrides }),
    pool: new FakePool(session) as never,
    smtpFactory: async () =>
      smtp ?? {
        verify: async () => undefined,
        send: async () => ({ accepted: [], rejected: [], pending: [], response: '250' }),
        close() {
          return undefined;
        },
      },
    logger: createLogger({ level: 'silent' }),
  });
}

function capturingSmtp(sent: Buffer[], envelopes: string[][] = []): SmtpSender {
  return {
    verify: async () => undefined,
    send: async (input) => {
      sent.push(input.raw);
      envelopes.push(input.envelope.to);
      return { accepted: ['ada@example.com'], rejected: [], pending: [], response: '250' };
    },
    close() {
      return undefined;
    },
  };
}

function draft(headers: string[], body = 'hello'): Buffer {
  return Buffer.from(
    [...headers, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body].join(
      '\r\n',
    ),
    'utf8',
  );
}

function headerFields(raw: string): Array<{ name: string; value: string }> {
  const block = raw.split(/\r?\n\r?\n/)[0] ?? '';
  const unfolded: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length > 0) {
      const previous = unfolded[unfolded.length - 1] ?? '';
      unfolded[unfolded.length - 1] = `${previous} ${line.trim()}`;
      continue;
    }
    unfolded.push(line);
  }
  return unfolded.flatMap((line) => {
    const colon = line.indexOf(':');
    if (colon <= 0) {
      return [];
    }
    return [{ name: line.slice(0, colon), value: line.slice(colon + 1).trim() }];
  });
}

const base = [
  'From: User <user@example.com>',
  'Subject: Draft',
  'Date: Tue, 01 Jan 2026 00:00:00 +0000',
  'Message-ID: <draft@ex>',
];

const commentForm = 'bob@example.com (Eve <eve@evil.test>)';

describe('excludedMatches after the thread is closed', () => {
  it('counts a child-only reference the same way for both seeds', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    session.ensure('Side');
    const service = serviceFor(session);
    const root = await session.append(
      'INBOX',
      simpleMessage({
        subject: 'A',
        messageId: '<a@ex>',
        text: 'a',
        date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'INBOX',
      simpleMessage({
        subject: 'B',
        messageId: '<b@ex>',
        inReplyTo: '<a@ex>',
        references: '<a@ex>',
        text: 'b',
        date: 'Tue, 02 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Side',
      simpleMessage({
        subject: 'Side',
        messageId: '<side@ex>',
        inReplyTo: '<b@ex>',
        references: '<b@ex>',
        text: 'side',
        date: 'Wed, 03 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Trash',
      simpleMessage({
        subject: 'Trash B',
        messageId: '<trash-b@ex>',
        inReplyTo: '<b@ex>',
        references: '<b@ex>',
        text: 'trash-b',
        date: 'Thu, 04 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Trash',
      simpleMessage({
        subject: 'Trash A',
        messageId: '<trash-a@ex>',
        inReplyTo: '<a@ex>',
        references: '<a@ex>',
        text: 'trash-a',
        date: 'Fri, 05 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const byId = await service.getThread({ messageId: '<a@ex>' });
    const byUid = await service.getThread({ mailbox: 'INBOX', uid: root.uid });
    const expected = [
      { mailbox: 'Side', count: 1 },
      { mailbox: 'Trash', count: 2 },
    ];
    expect(byId.excludedMatches).toEqual(expected);
    expect(byUid.excludedMatches).toEqual(expected);
    expect(byId.threadKey).toBe(byUid.threadKey);
    for (const result of [byId, byUid]) {
      const boxes = (result.items as Array<{ mailbox: string }>).map((item) => item.mailbox);
      expect(boxes).toEqual(['INBOX', 'INBOX']);
      expect(boxes).not.toEqual(expect.arrayContaining(['Side', 'Trash']));
    }
  });

  it('counts a reply to the child the same way for both seeds', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    session.ensure('Projects');
    const service = serviceFor(session);
    const root = await session.append(
      'INBOX',
      simpleMessage({
        subject: 'Root',
        messageId: '<root@ex>',
        text: 'root',
        date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Sent',
      simpleMessage({
        subject: 'Re: Root',
        messageId: '<sent@ex>',
        inReplyTo: '<root@ex>',
        references: '<root@ex>',
        text: 'sent',
        date: 'Tue, 02 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Trash',
      simpleMessage({
        subject: 'Re: Root',
        messageId: '<trash@ex>',
        inReplyTo: '<root@ex>',
        references: '<root@ex>',
        text: 'trash',
        date: 'Wed, 03 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'Projects',
      simpleMessage({
        subject: 'Re: Sent',
        messageId: '<projects@ex>',
        inReplyTo: '<sent@ex>',
        references: '<sent@ex>',
        text: 'projects',
        date: 'Thu, 04 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const byId = await service.getThread({ messageId: '<root@ex>' });
    const byUid = await service.getThread({ mailbox: 'INBOX', uid: root.uid });
    const expected = [
      { mailbox: 'Projects', count: 1 },
      { mailbox: 'Trash', count: 1 },
    ];
    expect(byId.excludedMatches).toEqual(expected);
    expect(byUid.excludedMatches).toEqual(expected);
    expect(byId.threadKey).toBe(byUid.threadKey);
    const boxes = (byId.items as Array<{ mailbox: string; messageId: string | null }>)
      .map((item) => item.mailbox)
      .sort();
    expect(boxes).toEqual(['INBOX', 'Sent']);
  });

  it('walks an in-scope reply when the only exact copy is in Trash', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Trash', '\\Trash');
    const service = serviceFor(session);
    await session.append(
      'Trash',
      simpleMessage({
        subject: 'Only',
        messageId: '<only@ex>',
        text: 'only',
        date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'INBOX',
      simpleMessage({
        subject: 'Re: Only',
        messageId: '<reply@ex>',
        inReplyTo: '<only@ex>',
        references: '<only@ex>',
        text: 'reply',
        date: 'Tue, 02 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    const result = await service.getThread({ messageId: '<only@ex>' });
    const items = result.items as Array<{ mailbox: string; messageId: string | null }>;
    expect(items.map((item) => item.mailbox)).toEqual(['INBOX']);
    expect(items[0]?.messageId).toMatch(/reply@ex/);
    expect(result.excludedMatches).toEqual([{ mailbox: 'Trash', count: 1 }]);
    expect(result.excludedMatches).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ mailbox: 'INBOX' })]),
    );
  });

  it('does not count a neighbor that has no threading ids', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Notes');
    const service = serviceFor(session);
    await session.append(
      'INBOX',
      simpleMessage({
        subject: 'A',
        messageId: '<a@ex>',
        text: 'a',
        date: 'Mon, 01 Jan 2026 00:00:00 +0000',
      }),
      [],
    );
    await session.append('Notes', Buffer.from('Subject: note\r\n\r\nno ids\r\n'), []);
    const result = await service.getThread({ messageId: '<a@ex>' });
    expect(result.excludedMatches).toEqual([]);
    const boxes = (result.items as Array<{ mailbox: string }>).map((item) => item.mailbox);
    expect(boxes).toEqual(['INBOX']);
  });
});

describe('X- header tokens', () => {
  const denied = [
    'X-Reply-To',
    'X-Sender',
    'X-Envelope-From',
    'X-Confirm-Reading-To',
    'X-Mail-Reply-To',
    'X-Read-Receipt-To',
    'X-Disposition-Notification-To',
    'X-Errors-To',
    'X-Original-From',
    'X-Reply_To',
    'X-MDN-To',
    'X-OriginalFrom',
    'X-ApparentlyFrom',
    'X-ConfirmReadingTo',
    'X-Original_From',
    'X-Google-Original-From',
    'X-Bounce-To',
    'X-Rcpt-To',
    'X-Resent-From',
  ];
  const allowed = [
    'X-Entity',
    'X-Mailer',
    'X-Priority',
    'X-Campaign',
    'X-Auto-Response-Suppress',
    'X-Feedback-ID',
    'X-Originating-IP',
    'X-Loop',
    'X-BeenThere',
    'X-Request-Id',
    'X-Sender-IP',
    'X-Notification',
    'X-GitHub-Notification',
  ];

  it('denies address-bearing tokens and allows the rest', async () => {
    expect(denied.every((name) => routingHeaderDenied(name))).toBe(true);
    expect(allowed.every((name) => routingHeaderDenied(name))).toBe(false);
    expect(routingHeaderDenied('X-')).toBe(true);
    expect(routingHeaderDenied('X-X-From')).toBe(true);
    expect(routingHeaderDenied('X-X-Sender-IP')).toBe(false);
    expect(routingHeaderDenied('X-Reply__To')).toBe(true);
    expect(routingHeaderDenied('X--')).toBe(true);
    expect(routingHeaderDenied('x-originalfrom')).toBe(true);
    expect(routingHeaderDenied('x-mdnto')).toBe(true);
    expect(routingHeaderDenied('From')).toBe(true);
    expect(routingHeaderDenied('List-Unsubscribe')).toBe(false);

    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Drafts', '\\Drafts');
    const sent: Buffer[] = [];
    const service = serviceFor(session, {}, capturingSmtp(sent));
    for (const name of denied) {
      await expect(
        service.send({
          to: ['ada@example.com'],
          subject: 'Hi',
          text: 'body',
          headers: { [name]: 'eve@evil.test' },
        }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    const drafted = [
      'X-MDN-To',
      'X-OriginalFrom',
      'X-ApparentlyFrom',
      'X-ConfirmReadingTo',
      'X-Original_From',
      'X-Google-Original-From',
    ];
    for (const name of drafted) {
      const saved = await session.append(
        'Drafts',
        draft(['To: Ada <ada@example.com>', ...base, `${name}: eve@evil.test`]),
        ['\\Draft'],
      );
      await expect(
        service.sendDraft({ mailbox: 'Drafts', uid: saved.uid ?? 0 }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    expect(sent).toHaveLength(0);

    const headers = Object.fromEntries(allowed.map((name) => [name, `ok-${name}`]));
    await service.send({
      to: ['ada@example.com'],
      subject: 'Hi',
      text: 'body',
      headers,
    });
    const wire = sent[0]?.toString('utf8') ?? '';
    expect(wire).not.toMatch(/eve@evil.test/);
    for (const name of allowed) {
      expect(wire.toLowerCase()).toContain(`${name.toLowerCase()}:`);
      expect(wire).toContain(`ok-${name}`);
    }
    const saved = await session.append(
      'Drafts',
      draft([
        'To: Ada <ada@example.com>',
        ...base,
        'X-Sender-IP: 203.0.113.5',
        'X-Notification: digest',
        'X-GitHub-Notification: reason',
      ]),
      ['\\Draft'],
    );
    await service.sendDraft({ mailbox: 'Drafts', uid: saved.uid ?? 0 });
    const draftWire = sent[1]?.toString('utf8') ?? '';
    expect(draftWire).toMatch(/X-Sender-IP:\s*203\.0\.113\.5/);
    expect(draftWire).toMatch(/X-Notification:\s*digest/);
    expect(draftWire).toMatch(/X-GitHub-Notification:\s*reason/);
    expect(draftWire).not.toMatch(/eve@evil.test/);
    const text = TOOLS.find((tool) => tool.name === 'mail_send_message')?.description ?? '';
    expect(text).toMatch(/followup/);
    expect(text).toMatch(/Other X-\* headers stay allowed/);
    expect(text).not.toMatch(/contains reply, receipt, notification/);
  });
});

describe('comment form on every send path', () => {
  it('keeps the addr-spec and drops the comment', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Drafts', '\\Drafts');
    const sent: Buffer[] = [];
    const envelopes: string[][] = [];
    const service = serviceFor(
      session,
      { allowFromDomains: ['example.com'] },
      capturingSmtp(sent, envelopes),
    );
    await service.send({
      to: [commentForm],
      cc: [commentForm],
      bcc: ['bob@example.com (Eve, <eve@evil.test>), ada@example.com'],
      subject: 'Hi',
      text: 'body',
    });
    const sentHeaders = headerFields(sent[0]?.toString('utf8') ?? '');
    const to = sentHeaders.find((field) => field.name.toLowerCase() === 'to');
    const cc = sentHeaders.find((field) => field.name.toLowerCase() === 'cc');
    expect(to?.value).toMatch(/bob@example.com/);
    expect(cc?.value).toMatch(/bob@example.com/);
    expect(sent[0]?.toString('utf8')).not.toMatch(/eve@evil.test/);
    expect(envelopes[0]).toEqual(expect.arrayContaining(['bob@example.com', 'ada@example.com']));
    expect(envelopes[0]?.join(' ')).not.toMatch(/eve@evil.test/);

    const original = await session.append(
      'INBOX',
      simpleMessage({
        from: 'Ada <ada@example.com>',
        to: 'User <user@example.com>',
        messageId: '<orig@ex>',
        text: 'original',
      }),
      [],
    );
    await service.reply({
      mailbox: 'INBOX',
      uid: original.uid ?? 0,
      replyTo: [commentForm],
      text: 'reply',
    });
    const replyHeaders = headerFields(sent[1]?.toString('utf8') ?? '');
    const replyTo = replyHeaders.find((field) => field.name.toLowerCase() === 'reply-to');
    expect(replyTo?.value).toBe('bob@example.com');
    expect(sent[1]?.toString('utf8')).not.toMatch(/eve@evil.test/);

    await service.forward({
      mailbox: 'INBOX',
      uid: original.uid ?? 0,
      to: [commentForm],
      text: 'forward',
    });
    const forwardHeaders = headerFields(sent[2]?.toString('utf8') ?? '');
    const forwardTo = forwardHeaders.find((field) => field.name.toLowerCase() === 'to');
    expect(forwardTo?.value).toMatch(/bob@example.com/);
    expect(sent[2]?.toString('utf8')).not.toMatch(/eve@evil.test/);

    const saved = await session.append(
      'Drafts',
      draft(['To: ' + commentForm, 'Cc: "Eve <eve@evil.test>" <ada@example.com>', ...base]),
      ['\\Draft'],
    );
    await service.sendDraft({ mailbox: 'Drafts', uid: saved.uid ?? 0 });
    const draftHeaders = headerFields(sent[3]?.toString('utf8') ?? '');
    const draftTo = draftHeaders.find((field) => field.name.toLowerCase() === 'to');
    const draftCc = draftHeaders.find((field) => field.name.toLowerCase() === 'cc');
    expect(draftTo?.value).toMatch(/bob@example.com/);
    expect(draftCc?.value).toMatch(/ada@example.com/);
    expect(sent[3]?.toString('utf8')).not.toMatch(/eve@evil.test/);
  });
});

describe('duplicate allow-listed draft headers', () => {
  it('keeps separate fields and the original field name', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    session.ensure('Drafts', '\\Drafts');
    const sent: Buffer[] = [];
    const service = serviceFor(session, {}, capturingSmtp(sent));
    const saved = await session.append(
      'Drafts',
      draft([
        'To: Ada <ada@example.com>',
        ...base,
        'comments: one',
        'comments: two',
        'importance: high',
        'list-unsubscribe-post: List-Unsubscribe=One-Click',
        'Comments: caf\u00e9',
        'Comments: second',
        'List-Unsubscribe: <mailto:a@example.com>,',
        ' <mailto:b@example.com>,',
        ' <mailto:c@example.com>',
      ]),
      ['\\Draft'],
    );
    await service.sendDraft({ mailbox: 'Drafts', uid: saved.uid ?? 0 });
    const fields = headerFields(sent[0]?.toString('utf8') ?? '');
    const comments = fields.filter(
      (field) => field.name === 'comments' || field.name === 'Comments',
    );
    expect(comments.map((field) => field.name)).toEqual([
      'comments',
      'comments',
      'Comments',
      'Comments',
    ]);
    expect(comments.map((field) => field.value)).toEqual(
      expect.arrayContaining(['one', 'two', 'second']),
    );
    expect(
      comments.some((field) => field.value.includes(',') && field.value.includes('second')),
    ).toBe(false);
    expect(fields.some((field) => field.name === 'importance' && field.value === 'high')).toBe(
      true,
    );
    expect(fields.some((field) => field.name === 'Importance')).toBe(false);
    expect(
      fields.some(
        (field) =>
          field.name === 'list-unsubscribe-post' && field.value === 'List-Unsubscribe=One-Click',
      ),
    ).toBe(true);
    const unsub = fields.find((field) => field.name.toLowerCase() === 'list-unsubscribe');
    expect(unsub?.value).toContain('<mailto:a@example.com>');
    expect(unsub?.value).toContain('<mailto:b@example.com>');
    expect(unsub?.value).toContain('<mailto:c@example.com>');
    const text = TOOLS.find((tool) => tool.name === 'mail_send_draft')?.description ?? '';
    expect(text).toMatch(/separate fields/);
  });
});
