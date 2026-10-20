import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { renderConfigSchema } from '../../src/config/json-schema.js';
import { selectIdentity } from '../../src/identities.js';
import { dialTarget, parseConnectAddress } from '../../src/net/connect.js';
import { pageRows, decodeSnapshotCursor, encodeSnapshotCursor } from '../../src/page/snapshot.js';
import { assertSupportedNode } from '../../src/runtime-check.js';
import { dedupeMessages, closeByHeaders, type ConversationMessage } from '../../src/thread/walk.js';
import { TOOLS } from '../../src/tools/catalog.js';
import { toolsForService } from '../../src/tools/register.js';
import { MailError } from '../../src/errors.js';
import { MailService } from '../../src/service/mail-service.js';
import { appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';
import { simpleMessage } from '../fixtures/messages.js';
import { createLogger } from '../../src/log.js';

describe('connect address', () => {
  it('parses host:port and bracketed IPv6', () => {
    expect(parseConnectAddress('127.0.0.1:1993')).toEqual({ host: '127.0.0.1', port: 1993 });
    expect(parseConnectAddress('[::1]:993')).toEqual({ host: '::1', port: 993 });
    expect(() => parseConnectAddress('2001:db8::1:993')).toThrow(MailError);
    expect(() => parseConnectAddress('imap.example.com')).toThrow(MailError);
  });

  it('dials the override and verifies the logical host', () => {
    const dial = dialTarget({
      host: 'imap.mail.me.com',
      port: 993,
      connectHost: '127.0.0.1',
      connectPort: 1993,
      tls: { rejectUnauthorized: true },
    });
    expect(dial).toMatchObject({
      host: '127.0.0.1',
      port: 1993,
      servername: 'imap.mail.me.com',
      logicalHost: 'imap.mail.me.com',
    });
  });
});

describe('identities', () => {
  const identities = [
    { id: 'personal', email: 'user@icloud.com', name: 'User', default: true },
    { id: 'domain', email: 'me@example.com', name: 'Me', default: false },
  ];

  it('selects explicit, single-match, none, and ambiguous', () => {
    expect(
      selectIdentity({ identities, accountEmail: 'user@icloud.com', requested: 'me@example.com' })
        .reason,
    ).toBe('explicit');
    expect(
      selectIdentity({
        identities,
        accountEmail: 'user@icloud.com',
        recipients: ['me@example.com'],
      }).reason,
    ).toBe('single-match');
    expect(
      selectIdentity({
        identities,
        accountEmail: 'user@icloud.com',
        recipients: ['other@example.com'],
      }).reason,
    ).toBe('default-no-match');
    expect(
      selectIdentity({
        identities,
        accountEmail: 'user@icloud.com',
        recipients: ['user@icloud.com', 'me@example.com'],
      }).reason,
    ).toBe('default-ambiguous');
  });

  it('does not treat a domain allow-list as a reason to skip TLS, and rejects unknown from', () => {
    expect(() =>
      selectIdentity({
        identities,
        accountEmail: 'user@icloud.com',
        requested: 'stranger@evil.test',
      }),
    ).toThrow(MailError);
    const allowed = selectIdentity({
      identities,
      accountEmail: 'user@icloud.com',
      allowFromDomains: ['example.com'],
      requested: 'other@example.com',
    });
    expect(allowed.reason).toBe('explicit');
  });
});

describe('thread identity', () => {
  it('does not merge messages that lack a Message-ID', () => {
    const left: ConversationMessage = {
      mailbox: 'INBOX',
      uid: 1,
      uidValidity: '1',
      references: [],
      from: [],
      to: [],
      cc: [],
      flags: [],
      hasAttachments: false,
      linked: 'header',
    };
    const right: ConversationMessage = { ...left, uid: 2, mailbox: 'Sent' };
    expect(dedupeMessages([left, right], ['INBOX'])).toHaveLength(2);
  });

  it('closes a header chain', async () => {
    const seed: ConversationMessage = {
      mailbox: 'INBOX',
      uid: 1,
      uidValidity: '9',
      messageId: '<a@ex>',
      references: [],
      from: [],
      to: [],
      cc: [],
      flags: [],
      hasAttachments: false,
      linked: 'header',
    };
    const reply: ConversationMessage = {
      ...seed,
      mailbox: 'Sent',
      uid: 2,
      messageId: '<b@ex>',
      inReplyTo: '<a@ex>',
      references: ['<a@ex>'],
    };
    const closed = await closeByHeaders({
      seed,
      folders: ['INBOX', 'Sent'],
      maxMessages: 10,
      maxRounds: 4,
      search: async (folder, ids) => (folder === 'Sent' && ids.includes('a@ex') ? [reply] : []),
    });
    expect(closed.messages.map((item) => item.messageId).sort()).toEqual(['<a@ex>', '<b@ex>']);
  });
});

describe('snapshot pages', () => {
  it('does not skip or duplicate when a later UID arrives outside the snapshot', () => {
    const keys = [{ field: 'arrival' as const, reverse: true }];
    const rows = [1, 2, 3].map((uid) => ({
      mailbox: 'INBOX',
      uid,
      arrival: `2026-01-0${uid}T00:00:00.000Z`,
      date: `2026-01-0${uid}T00:00:00.000Z`,
    }));
    const first = pageRows(rows, {
      limit: 1,
      keys,
      buildCursor: (anchor) => ({
        v: 4 as const,
        order: 'newest-first' as const,
        sort: keys,
        cap: 1,
        scope: 'INBOX',
        folders: [{ mailbox: 'INBOX', uidValidity: '1', upperUid: 3 }],
        anchor,
      }),
    });
    expect(first.items.map((item) => item.uid)).toEqual([3]);
    const grown = [
      ...rows,
      {
        mailbox: 'INBOX',
        uid: 4,
        arrival: '2026-02-01T00:00:00.000Z',
        date: '2026-02-01T00:00:00.000Z',
      },
    ];
    const cursor = decodeSnapshotCursor(first.nextCursor ?? '');
    const second = pageRows(
      grown.filter((row) => row.uid <= 3),
      { limit: 1, keys, cursor, buildCursor: () => cursor },
    );
    expect(second.items.map((item) => item.uid)).toEqual([2]);
    const seen = new Set<number>();
    let next = first.nextCursor;
    const walked = [3];
    while (next) {
      const page = pageRows(
        grown.filter((row) => row.uid <= 3),
        {
          limit: 1,
          keys,
          cursor: decodeSnapshotCursor(next),
          buildCursor: (anchor) => ({ ...cursor, anchor }),
        },
      );
      for (const item of page.items) {
        expect(seen.has(item.uid)).toBe(false);
        seen.add(item.uid);
        walked.push(item.uid);
      }
      next = page.nextCursor;
    }
    expect(walked).toEqual([3, 2, 1]);
  });

  it('rejects an older cursor', () => {
    const legacy = encodeSnapshotCursor({
      v: 4,
      order: 'newest-first',
      sort: [],
      cap: 1,
      scope: 'x',
      folders: [],
    });
    expect(decodeSnapshotCursor(legacy).v).toBe(4);
    expect(() =>
      decodeSnapshotCursor(
        Buffer.from(JSON.stringify({ v: 3, position: 0 }), 'utf8').toString('base64url'),
      ),
    ).toThrow(MailError);
  });
});

describe('node version', () => {
  it('rejects Node before 22 and allows Bun', () => {
    expect(() => assertSupportedNode('20.11.0')).toThrow(/Node.js 22/);
    expect(() => assertSupportedNode('22.0.0')).not.toThrow();
    expect(() => assertSupportedNode('18.0.0', '1.1.0')).not.toThrow();
  });
});

describe('catalog paging contract', () => {
  it('gives every paged tool the shared fields', () => {
    const paged = TOOLS.filter((tool) => tool.paged);
    expect(paged.length).toBeGreaterThan(5);
    for (const tool of paged) {
      expect(tool.input.shape.limit, tool.name).toBeDefined();
      expect(tool.input.shape.cursor, tool.name).toBeDefined();
      expect(tool.input.shape.order, tool.name).toBeDefined();
      expect(tool.output.shape.items, tool.name).toBeDefined();
      expect(tool.output.shape.nextCursor, tool.name).toBeDefined();
      expect(tool.output.shape.total, tool.name).toBeDefined();
      expect(tool.output.shape.truncated, tool.name).toBeDefined();
      expect(tool.output.shape.snapshot, tool.name).toBeDefined();
    }
    const service = new MailService({
      config: appConfig(),
      pool: new FakePool(new FakeSession()) as never,
      smtpFactory: async () => {
        throw new Error('unused');
      },
      logger: createLogger({ level: 'silent' }),
    });
    const registered = toolsForService(service).length;
    const hidden = TOOLS.filter((tool) => tool.kind === 'permanent').length;
    expect(registered).toBe(TOOLS.length - hidden);
    expect(hidden).toBe(1);
  });
});

describe('config schema', () => {
  it('matches schema/config.schema.json', async () => {
    const schemaUrl = new URL('../../schema/config.schema.json', import.meta.url);
    const file = readFileSync(schemaUrl, 'utf8');
    const rendered = await prettier.format(renderConfigSchema(), {
      filepath: fileURLToPath(schemaUrl),
    });
    expect(file).toBe(rendered);
  });

  it('loads the documented multi-account example', () => {
    const exampleUrl = new URL('../../examples/config.jsonc', import.meta.url);
    const example = readFileSync(exampleUrl, 'utf8').trim();
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    expect(readme).toContain(example);
    expect(readme).toContain(
      'ssh -N -L 1993:imap.mail.me.com:993 -L 1587:smtp.mail.me.com:587 user@vm',
    );
    const config = loadConfig({
      configPath: fileURLToPath(exampleUrl),
      env: {
        ICLOUD_APP_PASSWORD: 'icloud-secret',
        GMAIL_REFRESH_TOKEN: 'refresh-token',
        GMAIL_CLIENT_ID: 'client-id',
        GMAIL_CLIENT_SECRET: 'client-secret',
        WORK_IMAP_PASSWORD: 'work-secret',
      },
    });
    expect(config.defaultAccount).toBe('icloud');
    expect(config.accounts.icloud?.identities.map((item) => item.email)).toEqual([
      'user@icloud.com',
      'me@example.com',
    ]);
    expect(config.accounts.icloud?.identities.find((item) => item.default)?.email).toBe(
      'user@icloud.com',
    );
    expect(config.accounts.icloud?.imap.host).toBe('imap.mail.me.com');
    expect(config.accounts.gmail?.auth.type).toBe('oauth2');
    expect(config.accounts.work?.imap).toMatchObject({
      host: 'imap.work.example',
      port: 993,
      secure: true,
    });
    expect(config.accounts.work?.smtp).toMatchObject({
      host: 'smtp.work.example',
      port: 587,
      secure: false,
      starttls: 'required',
    });
    expect(config.accounts.work?.readOnly).toBe(true);
    expect(config.limits.maxPageSize).toBe(200);
  });
});

describe('two identities on one mailbox', () => {
  it('auto-selects the address that appears once in To', async () => {
    const session = new FakeSession(['IMAP4rev1']);
    const config = appConfig({
      identities: [
        { id: 'a', email: 'user@icloud.com', name: 'User', default: true },
        { id: 'b', email: 'me@example.com', name: 'Me', default: false },
      ],
      email: 'user@icloud.com',
    });
    const service = new MailService({
      config,
      pool: new FakePool(session) as never,
      smtpFactory: async () => ({
        verify: async () => undefined,
        send: async () => ({ accepted: [], rejected: [], pending: [], response: '250' }),
        close: () => undefined,
      }),
      logger: createLogger({ level: 'silent' }),
    });
    await session.append(
      'INBOX',
      simpleMessage({
        from: 'Ada <ada@example.com>',
        to: 'Me <me@example.com>',
        subject: 'Hello',
        messageId: '<hello@ex>',
      }),
      [],
    );
    const sent = await service.reply({ mailbox: 'INBOX', uid: 1, text: 'Thanks' });
    expect(sent.identityReason).toBe('single-match');
    expect(sent.identity).toMatchObject({ email: 'me@example.com' });
  });
});
