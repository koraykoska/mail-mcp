import { beforeAll, describe, expect, it } from 'vitest';
import type { MailService } from '../../src/service/mail-service.js';
import { createRuntime } from '../../src/runtime.js';
import { TOOLS, toolByName } from '../../src/tools/catalog.js';
import { simpleMessage } from '../fixtures/messages.js';
import { ensureDovecot, type DovecotEndpoints } from '../support/dovecot.js';
import { ensureGreenMail, type GreenMailEndpoints } from '../support/greenmail.js';
import { appConfig } from '../support/config.js';
import { createLogger } from '../../src/log.js';

const ENVELOPE = ['items', 'nextCursor', 'total', 'truncated', 'snapshot', 'order'] as const;

let greenmail: GreenMailEndpoints;
let dovecot: DovecotEndpoints;

beforeAll(async () => {
  [greenmail, dovecot] = await Promise.all([ensureGreenMail(), ensureDovecot()]);
}, 180_000);

function threeParts(subject: string, messageId: string, from: string): Buffer {
  const files = ['a.pdf', 'b.pdf', 'c.pdf'].map((name) =>
    [
      '--bnd',
      'Content-Type: application/pdf',
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(name).toString('base64'),
    ].join('\r\n'),
  );
  return Buffer.from(
    [
      `From: ${from}`,
      'To: user@example.com',
      `Subject: ${subject}`,
      'Date: Tue, 04 Jan 2026 00:00:00 +0000',
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="bnd"',
      '',
      '--bnd',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'See attached.',
      ...files,
      '--bnd--',
      '',
    ].join('\r\n'),
  );
}

async function appendRaw(
  service: MailService,
  mailbox: string,
  raw: Buffer,
  date: string,
): Promise<number> {
  const row = await service.append({
    mailbox,
    rawBase64: raw.toString('base64'),
    date,
  });
  if (typeof row.uid !== 'number') {
    throw new Error('append did not return a uid');
  }
  return row.uid;
}

async function walk(
  run: (cursor?: string) => Promise<Record<string, unknown>>,
  keyOf: (item: Record<string, unknown>) => string,
  between?: (page: number, items: Array<Record<string, unknown>>) => Promise<void>,
): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 800; page += 1) {
    const result = await run(cursor);
    for (const field of ENVELOPE) {
      expect(result, field).toHaveProperty(field);
    }
    expect(['newest-first', 'oldest-first']).toContain(result.order);
    expect(result.nextCursor === null || typeof result.nextCursor === 'string').toBe(true);
    expect(typeof result.total).toBe('number');
    expect(typeof result.truncated).toBe('boolean');
    expect(result.snapshot).toEqual(expect.any(Object));
    const items = result.items as Array<Record<string, unknown>>;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeLessThanOrEqual(1);
    for (const item of items) {
      const key = keyOf(item);
      expect(keys).not.toContain(key);
      keys.push(key);
    }
    if (between && result.nextCursor) {
      await between(page, items);
    }
    if (!result.nextCursor) {
      return keys;
    }
    cursor = String(result.nextCursor);
  }
  throw new Error('page walk did not finish');
}

async function exercise(label: string, service: MailService, email: string): Promise<void> {
  const called = new Set<string>();
  const stamp = `${label}-${Date.now()}`;
  const box = `Page/${stamp}`;
  const threadBox = `Thread/${stamp}`;
  await service.createMailbox(undefined, box);
  await service.createMailbox(undefined, threadBox);

  const uid = async (
    mailbox: string,
    subject: string,
    messageId: string,
    extra: { inReplyTo?: string; references?: string; from?: string; date?: string } = {},
  ) =>
    appendRaw(
      service,
      mailbox,
      simpleMessage({
        subject,
        messageId,
        from: extra.from ?? 'Ada <ada@example.com>',
        text: subject,
        ...(extra.inReplyTo ? { inReplyTo: extra.inReplyTo } : {}),
        ...(extra.references ? { references: extra.references } : {}),
        date: extra.date ?? 'Tue, 01 Jan 2026 00:00:00 +0000',
      }),
      extra.date ?? '2026-01-01T00:00:00Z',
    );

  const listed = [
    await uid(box, 'm-01', `<${stamp}-1@ex>`, { from: 'Ada <ada@example.com>' }),
    await uid(box, 'm-02', `<${stamp}-2@ex>`, { from: 'Bob <bob@example.com>' }),
    await uid(box, 'm-03', `<${stamp}-3@ex>`, { from: 'Cara <cara@example.com>' }),
  ];
  const mixed = await appendRaw(
    service,
    box,
    threeParts('m-04', `<${stamp}-4@ex>`, 'Ada <ada@example.com>'),
    '2026-01-04T00:00:00Z',
  );
  const original = new Set([...listed, mixed]);

  const listTool = toolByName('mail_list_messages');
  const searchTool = toolByName('mail_search_messages');
  if (!listTool || !searchTool) {
    throw new Error('paged message tools are missing');
  }
  let inserted = 0;
  const listKeys = await walk(
    (cursor) =>
      listTool.run(
        {
          mailbox: box,
          limit: 1,
          sort: [{ field: 'subject' }],
          includeSnippet: false,
          ...(cursor ? { cursor } : {}),
        },
        service,
      ),
    (item) => `${item.mailbox}:${item.uid}`,
    async (page, items) => {
      if (page !== 0) {
        return;
      }
      const seen = new Set(items.map((item) => Number(item.uid)));
      const victim = listed.find((id) => !seen.has(id));
      if (victim === undefined) {
        return;
      }
      await service.deleteMessages({ mailbox: box, uids: [victim], permanent: true });
      original.delete(victim);
      inserted = await uid(box, 'zz-new', `<${stamp}-new@ex>`, {
        date: 'Tue, 01 Jan 2020 00:00:00 +0000',
      });
    },
  );
  called.add('mail_list_messages');
  expect(listKeys).not.toContain(`${box}:${inserted}`);
  expect(new Set(listKeys)).toEqual(new Set([...original].map((id) => `${box}:${id}`)));

  const searchKeys = await walk(
    (cursor) =>
      searchTool.run(
        {
          mailbox: box,
          limit: 1,
          search: { subject: 'm-' },
          sort: [{ field: 'subject' }],
          includeSnippet: false,
          ...(cursor ? { cursor } : {}),
        },
        service,
      ),
    (item) => `${item.mailbox}:${item.uid}`,
  );
  called.add('mail_search_messages');
  expect(new Set(searchKeys)).toEqual(new Set([...original].map((id) => `${box}:${id}`)));

  const root = await uid(threadBox, 'm-01', `<${stamp}-root@ex>`);
  const mid = await uid(threadBox, 'm-02', `<${stamp}-mid@ex>`, {
    inReplyTo: `<${stamp}-root@ex>`,
    references: `<${stamp}-root@ex>`,
    date: 'Wed, 02 Jan 2026 00:00:00 +0000',
  });
  const late = await uid(threadBox, 'm-03', `<${stamp}-late@ex>`, {
    inReplyTo: `<${stamp}-mid@ex>`,
    references: `<${stamp}-root@ex> <${stamp}-mid@ex>`,
    date: 'Thu, 03 Jan 2026 00:00:00 +0000',
  });
  await appendRaw(
    service,
    threadBox,
    threeParts('m-04', `<${stamp}-files@ex>`, 'Cara <cara@example.com>'),
    '2026-01-04T00:00:00Z',
  );
  const lone = await uid(threadBox, 'm-08', `<${stamp}-lone@ex>`, {
    date: 'Thu, 08 Jan 2026 00:00:00 +0000',
  });

  const threadList = toolByName('mail_list_threads');
  const threadGet = toolByName('mail_get_thread');
  if (!threadList || !threadGet) {
    throw new Error('thread tools are missing');
  }
  const beforeThreads = await threadList.run({ mailbox: threadBox, limit: 20 }, service);
  const beforeKeys = (beforeThreads.items as Array<{ threadKey: string; uid: number }>).map(
    (item) => item.threadKey,
  );
  const loneKey = (beforeThreads.items as Array<{ threadKey: string; uid: number }>).find(
    (item) => item.uid === lone,
  )?.threadKey;
  let outsiderUid = 0;
  const threadKeys = await walk(
    (cursor) =>
      threadList.run({ mailbox: threadBox, limit: 1, ...(cursor ? { cursor } : {}) }, service),
    (item) => String(item.threadKey),
    async (page, items) => {
      if (page !== 0) {
        return;
      }
      const seen = new Set(items.map((item) => Number(item.uid)));
      if (!seen.has(lone)) {
        await service.deleteMessages({ mailbox: threadBox, uids: [lone], permanent: true });
      }
      outsiderUid = await uid(threadBox, 'zz-thread', `<${stamp}-outsider@ex>`);
    },
  );
  called.add('mail_list_threads');
  const freshThreads = await threadList.run({ mailbox: threadBox, limit: 20 }, service);
  const outsiderKey = (freshThreads.items as Array<{ threadKey: string; uid: number }>).find(
    (item) => item.uid === outsiderUid,
  )?.threadKey;
  expect(outsiderKey).toEqual(expect.any(String));
  expect(threadKeys).not.toContain(outsiderKey);
  for (const key of beforeKeys) {
    if (key !== loneKey) {
      expect(threadKeys).toContain(key);
    }
  }

  const pageThreadKeys = new Set<string>();
  let intruder = 0;
  const memberKeys = await walk(
    async (cursor) => {
      const result = await threadGet.run(
        {
          mailbox: threadBox,
          uid: root,
          folders: [threadBox],
          limit: 1,
          order: 'oldest-first',
          ...(cursor ? { cursor } : {}),
        },
        service,
      );
      pageThreadKeys.add(String(result.threadKey));
      for (const item of result.items as Array<{ threadKey: string }>) {
        expect(item.threadKey).toBe(result.threadKey);
      }
      return result;
    },
    (item) => `${item.mailbox}:${item.uid}`,
    async (page) => {
      if (page !== 0) {
        return;
      }
      await service.deleteMessages({ mailbox: threadBox, uids: [mid], permanent: true });
      intruder = await uid(threadBox, 'm-09', `<${stamp}-later@ex>`, {
        inReplyTo: `<${stamp}-root@ex>`,
        references: `<${stamp}-root@ex>`,
        date: 'Fri, 09 Jan 2026 00:00:00 +0000',
      });
    },
  );
  called.add('mail_get_thread');
  expect(pageThreadKeys.size).toBe(1);
  expect(memberKeys).toContain(`${threadBox}:${root}`);
  expect(memberKeys).toContain(`${threadBox}:${late}`);
  expect(memberKeys).not.toContain(`${threadBox}:${mid}`);
  expect(memberKeys).not.toContain(`${threadBox}:${intruder}`);

  const attachments = toolByName('mail_list_attachments');
  if (!attachments) {
    throw new Error('attachment tool is missing');
  }
  const files = await walk(
    (cursor) =>
      attachments.run({ mailbox: threadBox, limit: 1, ...(cursor ? { cursor } : {}) }, service),
    (item) => `${item.mailbox}:${item.uid}:${item.partId}`,
  );
  called.add('mail_list_attachments');
  expect(files.map((key) => key.split(':').length)).toEqual(files.map(() => 3));
  const names = await attachments.run({ mailbox: threadBox, limit: 10 }, service);
  expect(
    (names.items as Array<{ filename: string | null }>).map((item) => item.filename).sort(),
  ).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);

  const people = toolByName('mail_list_correspondents');
  if (!people) {
    throw new Error('correspondent tool is missing');
  }
  const addresses = await walk(
    (cursor) => people.run({ mailbox: box, limit: 1, ...(cursor ? { cursor } : {}) }, service),
    (item) => String(item.address),
    async (page) => {
      if (page !== 0) {
        return;
      }
      await uid(box, 'm-08', `<${stamp}-zed@ex>`, { from: 'Zed <zed@example.com>' });
    },
  );
  called.add('mail_list_correspondents');
  expect(addresses).not.toContain('zed@example.com');
  expect(addresses).not.toContain(email.toLowerCase());
  expect(new Set(addresses)).toEqual(new Set(['ada@example.com', 'cara@example.com']));

  const bulk = toolByName('mail_modify_by_search');
  if (!bulk) {
    throw new Error('bulk tool is missing');
  }
  const preview = await walk(
    (cursor) =>
      bulk.run(
        {
          mailbox: threadBox,
          limit: 1,
          search: { all: true },
          action: 'addFlags',
          flags: ['\\Flagged'],
          dryRun: true,
          sort: [{ field: 'subject' }],
          ...(cursor ? { cursor } : {}),
        },
        service,
      ),
    (item) => `${item.mailbox}:${item.uid}`,
  );
  called.add('mail_modify_by_search');
  expect(preview.length).toBeGreaterThan(1);
  const flagged = await service.searchMessages({
    mailbox: threadBox,
    search: { flagged: true },
    limit: 10,
    includeSnippet: false,
  });
  expect(flagged.total).toBe(0);

  const counted = toolByName('mail_count');
  const accounts = toolByName('mail_list_accounts');
  const boxes = toolByName('mail_list_mailboxes');
  const subscribed = toolByName('mail_list_subscribed');
  if (!counted || !accounts || !boxes || !subscribed) {
    throw new Error('folder page tools are missing');
  }
  const one = `Count/${stamp}/a`;
  const two = `Count/${stamp}/b`;
  const three = `Count/${stamp}/c`;
  await service.createMailbox(undefined, one);
  await service.createMailbox(undefined, two);
  await service.createMailbox(undefined, three);
  const counts = await walk(
    (cursor) =>
      counted.run(
        {
          folders: { globs: [`Count/${stamp}/*`] },
          limit: 1,
          ...(cursor ? { cursor } : {}),
        },
        service,
      ),
    (item) => String(item.mailbox),
    async () => undefined,
  );
  called.add('mail_count');
  expect(new Set(counts)).toEqual(new Set([one, two, three]));

  const accountKeys = await walk(
    (cursor) => accounts.run({ limit: 1, ...(cursor ? { cursor } : {}) }, service),
    (item) => String(item.id),
  );
  called.add('mail_list_accounts');
  expect(accountKeys).toContain('work');

  let created = '';
  const mailboxKeys = await walk(
    (cursor) => boxes.run({ limit: 1, ...(cursor ? { cursor } : {}) }, service),
    (item) => String(item.path),
    async (page) => {
      if (page === 0) {
        created = `Late/${stamp}`;
        await service.createMailbox(undefined, created);
      }
    },
  );
  called.add('mail_list_mailboxes');
  expect(mailboxKeys).toContain(box);
  expect(mailboxKeys).not.toContain(created);

  await service.subscribe(undefined, one, true);
  await service.subscribe(undefined, two, true);
  let extraSub = '';
  const subs = await walk(
    (cursor) => subscribed.run({ limit: 1, ...(cursor ? { cursor } : {}) }, service),
    (item) => String(item.path),
    async (page) => {
      if (page === 0) {
        extraSub = `LateSub/${stamp}`;
        await service.createMailbox(undefined, extraSub);
        await service.subscribe(undefined, extraSub, true);
      }
    },
  );
  called.add('mail_list_subscribed');
  expect(subs).toContain(one);
  expect(subs).not.toContain(extraSub);

  let lateAll = 0;
  const allKeys = await walk(
    (cursor) =>
      listTool.run(
        {
          folders: { all: true },
          search: { header: { name: 'Message-ID', value: stamp } },
          limit: 1,
          includeSnippet: false,
          ...(cursor ? { cursor } : {}),
        },
        service,
      ),
    (item) => `${item.mailbox}:${item.uid}`,
    async (page) => {
      if (page !== 0) {
        return;
      }
      lateAll = await uid(box, 'zz-all', `<${stamp}-all-late@ex>`);
    },
  );
  expect(allKeys).not.toContain(`${box}:${lateAll}`);
  expect(allKeys.some((key) => key.startsWith(`${box}:`))).toBe(true);

  const byMessageId = await walk(
    (cursor) =>
      threadGet.run(
        {
          messageId: `<${stamp}-root@ex>`,
          limit: 1,
          order: 'oldest-first',
          ...(cursor ? { cursor } : {}),
        },
        service,
      ),
    (item) => `${item.mailbox}:${item.uid}`,
  );
  expect(byMessageId).toContain(`${threadBox}:${root}`);
  expect(byMessageId).toContain(`${threadBox}:${late}`);

  const paged = TOOLS.filter((tool) => tool.paged).map((tool) => tool.name);
  expect([...called].sort()).toEqual([...paged].sort());
}

describe('paged tool contract', () => {
  it('walks every paged tool on GreenMail without gaps or duplicates', async () => {
    const runtime = createRuntime({
      config: appConfig({
        imap: {
          host: greenmail.host,
          port: greenmail.imapPort,
          secure: false,
          starttls: 'disabled',
          timeoutMs: 45_000,
          tls: { rejectUnauthorized: false },
        },
        user: greenmail.user,
        email: greenmail.email,
        auth: { type: 'password', password: greenmail.password },
        identities: [{ id: 'default', email: greenmail.email, name: 'User', default: true }],
        allowDelete: true,
        allowPermanentDelete: true,
        appendSent: false,
      }),
      logger: createLogger({ level: 'silent' }),
    });
    await exercise('gm', runtime.service, greenmail.email);
    await runtime.close();
  }, 300_000);

  it('walks every paged tool on Dovecot without gaps or duplicates', async () => {
    const runtime = createRuntime({
      config: appConfig({
        imap: {
          host: dovecot.host,
          port: dovecot.imapPort,
          secure: false,
          starttls: 'required',
          timeoutMs: 15_000,
          tls: { rejectUnauthorized: true, caFile: dovecot.caFile, servername: 'localhost' },
        },
        user: dovecot.user,
        email: dovecot.email,
        auth: { type: 'password', password: dovecot.password },
        identities: [{ id: 'default', email: dovecot.email, name: 'User', default: true }],
        allowDelete: true,
        allowPermanentDelete: true,
        appendSent: false,
      }),
      logger: createLogger({ level: 'silent' }),
    });
    await exercise('dv', runtime.service, dovecot.email);
    await runtime.close();
  }, 180_000);
});
