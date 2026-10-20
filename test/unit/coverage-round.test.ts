import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { MailError } from '../../src/errors.js';
import {
  comparePath,
  defaultThreadFolders,
  globMatch,
  parseFolderRequest,
  resolveFolderPaths,
  uniquePaths,
} from '../../src/folders.js';
import { parseIdentityList, selectIdentity, splitIdentityList } from '../../src/identities.js';
import { dialTarget, parseConnectAddress } from '../../src/net/connect.js';
import {
  assertCursorFits,
  comparePageRows,
  decodeSnapshotCursor,
  encodeSnapshotCursor,
  orderFromKeys,
  pageKeys,
  pageRows,
  sortKeysFor,
} from '../../src/page/snapshot.js';
import {
  pageKeyList,
  pageLimit,
  pageServerUids,
  resolveOrder,
  scopeFor,
} from '../../src/service/browse.js';
import { MailService } from '../../src/service/mail-service.js';
import {
  applySubjectHeuristic,
  buildTree,
  chronological,
  closeByHeaders,
  dedupeMessages,
  threadKeyFor,
  type ConversationMessage,
} from '../../src/thread/walk.js';
import { toolByName } from '../../src/tools/catalog.js';
import { multipartMixed, simpleMessage } from '../fixtures/messages.js';
import { createLogger } from '../../src/log.js';
import { appConfig } from '../support/config.js';
import { FakePool, FakeSession } from '../support/fake-session.js';
import type { ResolvedSpecialUse } from '../../src/imap/special-use.js';

const special: ResolvedSpecialUse = {
  inbox: 'INBOX',
  sent: 'Sent',
  drafts: 'Drafts',
  trash: 'Trash',
  junk: 'Junk',
  archive: 'Archive',
  all: 'All',
  sources: {},
};

function msg(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    mailbox: 'INBOX',
    uid: 1,
    uidValidity: '1',
    messageId: '<a@ex>',
    references: [],
    from: [{ address: 'ada@example.com' }],
    to: [{ address: 'user@example.com' }],
    cc: [],
    flags: [],
    hasAttachments: false,
    linked: 'header',
    ...overrides,
  };
}

function serviceFor(
  session: FakeSession,
  overrides: Parameters<typeof appConfig>[0] = {},
): MailService {
  return new MailService({
    config: appConfig(overrides),
    pool: new FakePool(session) as never,
    smtpFactory: async () => {
      throw new Error('unused');
    },
    logger: createLogger({ level: 'silent' }),
  });
}

describe('folder scope helpers', () => {
  const listed = [
    { path: 'INBOX', specialUse: '\\Inbox' },
    { path: 'Sent', specialUse: '\\Sent' },
    { path: 'Trash', specialUse: '\\Trash' },
    { path: 'Junk', specialUse: '\\Junk' },
    { path: 'Archive', specialUse: '\\Archive' },
    { path: 'Projects/2026' },
  ];

  it('parses strings, lists, globs, and objects', () => {
    expect(parseFolderRequest('all').all).toBe(true);
    expect(parseFolderRequest(['INBOX', '\\Sent', 'Projects/*']).globs).toEqual(['Projects/*']);
    expect(
      parseFolderRequest({ all: true, exclude: ['\\Junk'], includeTrash: true }).includeTrash,
    ).toBe(true);
    expect(() => parseFolderRequest(1)).toThrow(MailError);
    expect(() => parseFolderRequest([''])).toThrow(MailError);
    expect(() => parseFolderRequest({ mailboxes: [1] })).toThrow(MailError);
  });

  it('resolves all, special-use, globs, and excludes', () => {
    const all = resolveFolderPaths(listed, special, parseFolderRequest('all'));
    expect(all.paths).toEqual(['Archive', 'INBOX', 'Projects/2026', 'Sent']);
    const named = resolveFolderPaths(listed, special, parseFolderRequest(['\\Trash', 'Missing']));
    expect(named.paths).toEqual(['Missing', 'Trash']);
    expect(named.missing).toContain('Missing');
    expect(() => resolveFolderPaths(listed, special, parseFolderRequest('No/*'))).toThrow(
      MailError,
    );
    const missing = resolveFolderPaths(listed, special, parseFolderRequest('Nope'));
    expect(missing.paths).toEqual(['Nope']);
    expect(missing.missing).toContain('Nope');
    expect(defaultThreadFolders('INBOX', special)).toEqual(['INBOX', 'Sent', 'Archive', 'All']);
    expect(globMatch('Projects/?026', 'Projects/2026')).toBe(true);
    expect(comparePath('a', 'b')).toBe(-1);
    expect(comparePath('b', 'a')).toBe(1);
    expect(comparePath('a', 'a')).toBe(0);
    expect(uniquePaths(['', 'INBOX', 'INBOX'])).toEqual(['INBOX']);
  });
});

describe('identity parsing', () => {
  it('splits names and commas inside angle brackets', () => {
    expect(splitIdentityList('Ada <a@ex>, Bob <b@ex>')).toEqual(['Ada <a@ex>', 'Bob <b@ex>']);
    expect(splitIdentityList('Ada <a,b@ex>, , Bob <b@ex>')).toEqual(['Ada <a,b@ex>', 'Bob <b@ex>']);
    expect(parseIdentityList('plain@ex')).toEqual([{ email: 'plain@ex' }]);
    expect(parseIdentityList('Ada <ada@ex>')[0]).toMatchObject({ name: 'Ada', email: 'ada@ex' });
  });

  it('covers explicit, domain, and empty identity lists', () => {
    const chosen = selectIdentity({
      identities: [],
      accountEmail: 'user@example.com',
      requested: { address: 'user@example.com', name: 'User' },
    });
    expect(chosen.reason).toBe('explicit');
    expect(chosen.id).toBe('default');
    const domain = selectIdentity({
      identities: [{ id: 'a', email: 'user@example.com', default: true }],
      accountEmail: 'user@example.com',
      allowFromDomains: ['example.com'],
      requested: 'other@example.com',
    });
    expect(domain.id).toBeNull();
    expect(
      selectIdentity({
        identities: [{ id: 'a', email: 'user@example.com', default: true }],
        accountEmail: 'user@example.com',
        recipients: [],
      }).reason,
    ).toBe('default-no-match');
  });
});

describe('thread walk edges', () => {
  it('dedupes by preference, builds a tree, and applies the subject heuristic', () => {
    const copy = dedupeMessages(
      [
        msg({ mailbox: 'Archive', uid: 2, messageId: '<a@ex>' }),
        msg({ mailbox: 'INBOX', uid: 9, messageId: '<a@ex>' }),
        msg({ uid: 3, messageId: undefined }),
      ],
      ['INBOX'],
    );
    expect(copy).toHaveLength(2);
    expect(copy.find((item) => item.messageId)?.alsoIn?.[0]?.mailbox).toBe('Archive');
    const tree = buildTree([
      msg({ messageId: '<root@ex>', uid: 1 }),
      msg({
        messageId: '<child@ex>',
        uid: 2,
        inReplyTo: '<root@ex>',
        references: ['<root@ex>'],
      }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children).toHaveLength(1);
    const added = applySubjectHeuristic(
      [msg({ subject: 'Re: Hello', from: [{ address: 'ada@example.com' }] })],
      [
        msg({
          uid: 4,
          messageId: '<other@ex>',
          subject: 'Hello',
          from: [{ address: 'ada@example.com' }],
        }),
        msg({
          uid: 5,
          messageId: '<nope@ex>',
          subject: 'Other',
          from: [{ address: 'ada@example.com' }],
        }),
      ],
      10,
    );
    expect(added.messages.map((item) => item.uid)).toEqual([1, 4]);
    expect(applySubjectHeuristic([msg({ subject: '' })], [], 1).messages).toHaveLength(1);
    const capped = applySubjectHeuristic(
      [msg({ subject: 'Hello' })],
      [
        msg({
          uid: 8,
          messageId: '<z@ex>',
          subject: 'Hello',
          from: [{ address: 'ada@example.com' }],
        }),
      ],
      1,
    );
    expect(capped.truncated).toBe(true);
    expect(threadKeyFor(msg({ messageId: undefined, uid: 4, uidValidity: '9' }))).toBe(
      'uid:INBOX:9:4',
    );
    const ordered = chronological(
      [
        msg({ uid: 1, date: '2026-01-02', mailbox: 'B' }),
        msg({ uid: 2, date: '2026-01-02', mailbox: 'A' }),
      ],
      false,
    );
    expect(ordered.map((item) => item.uid)).toEqual([2, 1]);
  });

  it('stops the header walk when the message cap is hit', async () => {
    const closed = await closeByHeaders({
      seed: msg(),
      folders: ['INBOX'],
      maxMessages: 1,
      maxRounds: 2,
      search: async () => [msg({ uid: 2, messageId: '<b@ex>', references: ['<a@ex>'] })],
    });
    expect(closed.truncated).toBe(true);
    expect(closed.messages).toHaveLength(1);
  });
});

describe('snapshot and connect edges', () => {
  it('rejects bad cursors and pages keys', () => {
    expect(() => decodeSnapshotCursor('@@@')).toThrow(MailError);
    expect(() => decodeSnapshotCursor(Buffer.from('null').toString('base64url'))).toThrow(
      MailError,
    );
    expect(() =>
      decodeSnapshotCursor(
        Buffer.from(JSON.stringify({ v: 4, order: 'sideways' }), 'utf8').toString('base64url'),
      ),
    ).toThrow(MailError);
    expect(sortKeysFor('oldest-first')).toEqual([{ field: 'arrival', reverse: false }]);
    expect(sortKeysFor('newest-first', [{ field: 'subject', reverse: true }])[0]?.reverse).toBe(
      true,
    );
    expect(orderFromKeys([])).toBe('newest-first');
    expect(orderFromKeys([{ field: 'date' }])).toBe('oldest-first');
    const rows = [
      { mailbox: 'B', uid: 1, date: '2026-01-01', arrival: '2026-01-01', size: 2 },
      { mailbox: 'A', uid: 2, date: '2026-01-01', arrival: '2026-01-01', size: 1 },
    ];
    expect(comparePageRows(rows[0]!, rows[1]!, [{ field: 'size' }])).toBeGreaterThan(0);
    const paged = pageKeys(['a', 'c'], 1, 'b');
    expect(paged.keys).toEqual(['c']);
    expect(pageKeys(['a'], 1, 'z').keys).toEqual([]);
    const slice = pageRows(rows, {
      limit: 1,
      keys: [{ field: 'size', reverse: true }],
      buildCursor: (anchor) => ({
        v: 4 as const,
        order: 'newest-first' as const,
        sort: [{ field: 'size' as const, reverse: true }],
        cap: 1,
        scope: 's',
        folders: [],
        anchor,
      }),
    });
    expect(slice.nextCursor).toEqual(expect.any(String));
    expect(() => parseConnectAddress('   ')).toThrow(/empty/);
    expect(() => parseConnectAddress('[::1]')).toThrow(/\[ipv6\]:port/);
    expect(() => parseConnectAddress('[::1%eth0]:993')).toThrow(/invalid IPv6/);
    expect(() => parseConnectAddress('host:nope')).toThrow(/non-numeric/);
    expect(() => parseConnectAddress('host:0')).toThrow(/1-65535/);
    expect(
      dialTarget({
        host: 'imap.mail.me.com',
        port: 993,
        tls: { rejectUnauthorized: true, servername: 'mail.example' },
      }).servername,
    ).toBe('mail.example');
  });

  it('rejects a page that is too large and an order that disagrees with sort', () => {
    expect(() => pageLimit(0, 25, 200, false)).toThrow(MailError);
    expect(() => pageLimit(500, 25, 200, false)).toThrow(/maximum/);
    expect(() => pageLimit(21, 25, 200, true)).toThrow(/20/);
    expect(() =>
      resolveOrder({ sort: [{ field: 'arrival', reverse: true }], order: 'oldest-first' }),
    ).toThrow(/does not match/);
  });
});

describe('new tools against a fake server', () => {
  it('threads, counts, attachments, correspondents, facets, and bulk edits', async () => {
    const session = new FakeSession(['IMAP4rev1', 'MOVE', 'UIDPLUS']);
    session.ensure('Archive', '\\Archive');
    session.structure = {
      type: 'application',
      subtype: 'pdf',
      parameters: { name: 'notes.pdf' },
      disposition: 'attachment',
      dispositionParameters: { filename: 'notes.pdf' },
      children: [],
      part: '2',
    };
    await session.append(
      'INBOX',
      simpleMessage({
        from: 'ada@example.com',
        to: 'user@example.com',
        subject: 'Hello',
        messageId: '<root@ex>',
        date: 'Mon, 01 Jan 2024 00:00:00 +0000',
      }),
      [],
    );
    await session.append(
      'INBOX',
      simpleMessage({
        from: 'bob@example.com',
        to: 'ada@example.com',
        subject: 'Hello',
        messageId: '<sib@ex>',
        date: 'Tue, 02 Jan 2024 00:00:00 +0000',
      }),
      ['\\Seen'],
    );
    await session.append('Sent', multipartMixed, []);
    const service = serviceFor(session);
    const thread = await toolByName('mail_get_thread')!.run(
      {
        mailbox: 'INBOX',
        uid: 1,
        subjectHeuristic: true,
        onlyUnread: true,
        includeBodies: true,
        order: 'oldest-first',
        limit: 5,
      },
      service,
    );
    expect(thread.ok).toBe(true);
    expect((thread.items as unknown[]).length).toBeGreaterThan(0);
    const byId = await service.getThread({ messageId: '<sib@ex>', folders: 'all' });
    expect(byId.threadKey).toEqual(expect.any(String));
    await expect(service.getThread({})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.getThread({ uid: 1 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(service.getThread({ messageId: '   ' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(service.getThread({ messageId: '<missing@ex>' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const counted = await toolByName('mail_count')!.run(
      { folders: 'all', search: { all: true }, limit: 1 },
      service,
    );
    expect(counted.total).toBeGreaterThan(1);
    const next = await service.countMessages({
      folders: 'all',
      search: { all: true },
      limit: 1,
      cursor: String(counted.nextCursor),
    });
    expect(next.items).toEqual(expect.any(Array));

    const attachments = await toolByName('mail_list_attachments')!.run(
      { folders: ['Sent'], includeSnippet: false },
      service,
    );
    expect((attachments.items as Array<{ filename: string | null }>)[0]?.filename).toBe(
      'notes.pdf',
    );

    const people = await toolByName('mail_list_correspondents')!.run(
      { mailbox: 'INBOX', limit: 1 },
      service,
    );
    expect(people.total).toBe(2);
    const rest = await service.listCorrespondents({
      mailbox: 'INBOX',
      limit: 1,
      cursor: String(people.nextCursor),
    });
    expect((rest.items as unknown[]).length).toBe(1);

    const facets = await toolByName('mail_search_facets')!.run(
      { folders: ['INBOX', 'Sent'], top: 2, maxPerFolder: 1 },
      service,
    );
    expect(facets.truncated).toBe(false);
    expect(facets.partial).toBe(false);
    expect((facets.senders as unknown[]).length).toBeGreaterThan(0);

    const preview = await toolByName('mail_modify_by_search')!.run(
      { mailbox: 'INBOX', search: { all: true }, action: 'addFlags', flags: ['\\Flagged'] },
      service,
    );
    expect(preview.dryRun).toBe(true);
    const flagged = await service.modifyBySearch({
      mailbox: 'INBOX',
      search: { all: true },
      action: 'addFlags',
      flags: ['\\Flagged'],
      dryRun: false,
    });
    expect(flagged.dryRun).toBe(false);
    const moved = await service.modifyBySearch({
      mailbox: 'INBOX',
      search: { all: true },
      action: 'move',
      destination: 'Archive',
      dryRun: false,
    });
    expect(moved.matched).toBeGreaterThan(0);
    await session.append('INBOX', simpleMessage({ messageId: '<later@ex>', subject: 'Later' }), []);
    const archived = await service.modifyBySearch({
      mailbox: 'INBOX',
      action: 'archive',
      dryRun: false,
    });
    expect(archived.ok).toBe(true);

    const listed = await service.listMessages({
      folders: { all: true, exclude: ['Sent'] },
      order: 'oldest-first',
      includeSnippet: false,
      limit: 1,
    });
    expect(listed.total).toEqual(expect.any(Number));
    if (listed.nextCursor) {
      const page = await service.listMessages({
        folders: { all: true, exclude: ['Sent'] },
        order: 'oldest-first',
        includeSnippet: false,
        limit: 1,
        cursor: String(listed.nextCursor),
      });
      expect(page.messages).toEqual(expect.any(Array));
    }
    const threads = await service.listThreads({ folders: ['INBOX', 'Archive'], limit: 5 });
    expect(threads.total).toEqual(expect.any(Number));
  });

  it('refuses a bulk edit that is too large or not permitted', async () => {
    const session = new FakeSession(['IMAP4rev1', 'UIDPLUS']);
    await session.append('INBOX', simpleMessage({ messageId: '<1@ex>' }), []);
    await session.append('INBOX', simpleMessage({ messageId: '<2@ex>' }), []);
    const tight = serviceFor(session, { limits: { ...appConfig().limits, maxBulk: 1 } });
    await expect(
      tight.modifyBySearch({
        mailbox: 'INBOX',
        action: 'addFlags',
        flags: ['\\Seen'],
        dryRun: false,
      }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    const readOnly = serviceFor(session, { readOnly: true });
    await expect(
      readOnly.modifyBySearch({
        mailbox: 'INBOX',
        action: 'addFlags',
        flags: ['\\Seen'],
        dryRun: false,
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const noDelete = serviceFor(session, { allowDelete: false });
    await expect(
      noDelete.modifyBySearch({
        mailbox: 'INBOX',
        action: 'move',
        destination: 'Trash',
        dryRun: false,
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      noDelete.modifyBySearch({
        mailbox: 'INBOX',
        action: 'archive',
        dryRun: false,
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const empty = new FakeSession(['IMAP4rev1']);
    empty.ensure('Empty');
    const bare = serviceFor(empty);
    const none = await bare.listMessages({ mailbox: 'Empty', includeSnippet: false });
    expect(none.total).toBe(0);
    const scope = scopeFor(
      ['INBOX'],
      undefined,
      5000,
      JSON.stringify([{ field: 'arrival', reverse: true }]),
    );
    const cursor = encodeSnapshotCursor({
      v: 4,
      order: 'newest-first',
      sort: [{ field: 'arrival', reverse: true }],
      cap: 25,
      scope,
      folders: [{ mailbox: 'INBOX', uidValidity: '100', upperUid: 0 }],
    });
    const frozen = await bare.listMessages({ mailbox: 'INBOX', cursor, includeSnippet: false });
    expect(frozen.total).toBe(0);
    await expect(bare.listMessages({ folders: { mailboxes: [] } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(bare.listMessages({ maxPerFolder: 0 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('remaining branch edges', () => {
  it('covers cursor, folder, and sort branches that the happy path skips', () => {
    expect(defaultThreadFolders('INBOX', { sources: {} })).toEqual(['INBOX']);
    expect(() =>
      resolveFolderPaths([{ path: 'INBOX' }], { sources: {} }, parseFolderRequest('\\Flagged')),
    ).toThrow(MailError);
    const glob = resolveFolderPaths(
      [{ path: 'Projects/2026' }, { path: 'Other' }],
      special,
      parseFolderRequest(['Projects/*', '\\Sent']),
    );
    expect(glob.paths).toEqual(expect.arrayContaining(['Projects/2026', 'Sent']));
    expect(glob.missing).toEqual([]);

    const merged = dedupeMessages(
      [
        msg({ mailbox: 'INBOX', uid: 2, messageId: '<same@ex>' }),
        msg({ mailbox: 'INBOX', uid: 1, messageId: '<same@ex>' }),
        msg({ mailbox: 'archive', uid: 3, messageId: '<same@ex>' }),
      ],
      ['Sent'],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ mailbox: 'INBOX', uid: 1 });
    expect(merged[0]?.alsoIn).toEqual([
      { mailbox: 'INBOX', uid: 2, uidValidity: '1' },
      { mailbox: 'archive', uid: 3, uidValidity: '1' },
    ]);
    const newest = chronological(
      [
        msg({ uid: 1, mailbox: 'INBOX', date: '', internalDate: '2026-01-02' }),
        msg({ uid: 2, mailbox: 'INBOX', date: '', internalDate: '2026-01-01' }),
        msg({ uid: 3, mailbox: 'Sent', date: '2026-01-01' }),
      ],
      true,
    );
    expect(newest.map((item) => item.uid)).toEqual([1, 3, 2]);
    expect(
      selectIdentity({
        identities: [{ id: 'a', email: 'a@ex', default: true }],
        accountEmail: 'a@ex',
      }).name,
    ).toBeUndefined();

    const bad = (value: unknown) =>
      decodeSnapshotCursor(Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'));
    expect(() => bad({ v: 4, order: 'newest-first' })).toThrow(MailError);
    expect(() => bad({ v: 4, order: 'newest-first', sort: [], scope: 's' })).toThrow(MailError);
    expect(() => bad({ v: 4, order: 'newest-first', sort: [{}], scope: 's', folders: [] })).toThrow(
      MailError,
    );
    expect(() =>
      bad({
        v: 4,
        order: 'newest-first',
        sort: [{ field: 'arrival' }],
        scope: 's',
        folders: [{ mailbox: 'INBOX' }],
      }),
    ).toThrow(MailError);
    expect(() =>
      bad({
        v: 4,
        order: 'newest-first',
        sort: [{ field: 'arrival' }],
        scope: 's',
        folders: [],
        anchor: null,
      }),
    ).toThrow(MailError);
    expect(() =>
      bad({
        v: 4,
        order: 'newest-first',
        sort: [{ field: 'arrival' }],
        scope: 's',
        folders: [],
        anchor: { mailbox: 'INBOX' },
      }),
    ).toThrow(MailError);

    const cursor = {
      v: 4 as const,
      order: 'newest-first' as const,
      sort: [{ field: 'arrival' as const, reverse: true }],
      cap: 1,
      scope: 'INBOX',
      folders: [{ mailbox: 'Sent', uidValidity: '1', upperUid: 1 }],
    };
    expect(() =>
      assertCursorFits(cursor, {
        scope: 'INBOX',
        order: 'newest-first',
        sort: cursor.sort,
        cap: 1,
        folders: [{ mailbox: 'INBOX', uidValidity: '1' }],
      }),
    ).toThrow(/does not include/);
    expect(() =>
      assertCursorFits(
        { ...cursor, folders: [{ mailbox: 'INBOX', uidValidity: '1', upperUid: 1 }] },
        {
          scope: 'INBOX',
          order: 'newest-first',
          sort: cursor.sort,
          cap: 1,
          folders: [{ mailbox: 'INBOX', uidValidity: '2' }],
        },
      ),
    ).toThrow(/UIDVALIDITY/);

    expect(pageServerUids([3, 2, 1], 9, 1).anchorMissing).toBe(true);
    expect(
      sortKeysFor('newest-first', [{ field: 'subject', reverse: false }])[0]?.reverse,
    ).toBeUndefined();
    expect(
      comparePageRows(
        { mailbox: 'A', uid: 1, date: '2026-01-01', arrival: '2026-01-01' },
        { mailbox: 'B', uid: 2, date: '2026-01-01', arrival: '2026-01-01' },
        [],
      ),
    ).toBeLessThan(0);
    const keyed = pageKeyList(['b', 'a'], {
      limit: 1,
      order: 'oldest-first',
      scope: 'keys',
      sort: [{ field: 'arrival', reverse: true }],
    });
    expect(keyed.nextCursor).toEqual(expect.any(String));
    expect(() =>
      pageKeyList(['a'], {
        limit: 1,
        order: 'newest-first',
        scope: 'keys',
        sort: [{ field: 'arrival', reverse: true }],
        cursor: {
          v: 4,
          order: 'newest-first',
          sort: [{ field: 'arrival', reverse: true }],
          cap: 1,
          scope: 'keys',
          folders: [],
        },
      }),
    ).toThrow(/not valid/);

    const sameDay = chronological(
      [
        msg({ uid: 2, mailbox: 'INBOX', date: '2026-01-01' }),
        msg({ uid: 1, mailbox: 'INBOX', date: '2026-01-01' }),
      ],
      false,
    );
    expect(sameDay.map((item) => item.uid)).toEqual([1, 2]);
    const subject = applySubjectHeuristic(
      [msg({ uid: 1, messageId: '<one@ex>', subject: 'Hello', from: [{ address: 'a@ex' }] })],
      [
        msg({
          uid: 2,
          mailbox: 'Sent',
          messageId: '<two@ex>',
          subject: 'Hello',
          from: [{ address: 'b@ex' }],
          to: [],
          cc: [],
        }),
        msg({
          uid: 3,
          mailbox: 'Archive',
          messageId: '<three@ex>',
          subject: 'Hello',
          from: [{ address: 'a@ex' }],
        }),
      ],
      10,
    );
    expect(subject.messages.map((item) => item.uid)).toEqual([1, 3]);
    expect(subject.messages[1]?.linked).toBe('subject');
    expect(subject.truncated).toBe(false);
    const undated = pageRows(
      [
        { mailbox: 'A', uid: 1 },
        { mailbox: 'B', uid: 2 },
      ],
      {
        limit: 1,
        keys: [],
        buildCursor: (anchor) => ({
          v: 4 as const,
          order: 'newest-first' as const,
          sort: [],
          cap: 1,
          scope: 'undated',
          folders: [],
          anchor,
        }),
      },
    );
    expect(undated.items).toHaveLength(1);
    expect(undated.nextCursor).toEqual(expect.any(String));
    expect(pageLimit(undefined, 25, 200, false)).toBe(25);
  });
});

describe('environment account extras', () => {
  it('applies identities, from domains, and connect overrides', () => {
    const config = loadConfig({
      env: {
        MAIL_ACCOUNT: 'personal',
        MAIL_IMAP_HOST: 'imap.example.com',
        MAIL_SMTP_HOST: 'smtp.example.com',
        MAIL_USER: 'user@example.com',
        MAIL_PASSWORD: 'secret',
        MAIL_IDENTITIES: 'Ada <ada@example.com>, Bob <bob@example.com>',
        MAIL_ALLOW_FROM_DOMAINS: '@example.com',
        MAIL_IMAP_CONNECT: '127.0.0.1:1993',
        MAIL_SMTP_CONNECT: '[::1]:1587',
        MAIL_APPEND_SENT: 'auto',
      },
    });
    expect(config.defaultAccount).toBe('personal');
    expect(config.accounts.personal?.identities.map((item) => item.email)).toEqual([
      'ada@example.com',
      'bob@example.com',
      'user@example.com',
    ]);
    expect(config.accounts.personal?.imap.connectHost).toBe('127.0.0.1');
    expect(config.accounts.personal?.smtp?.connectPort).toBe(1587);
    expect(config.accounts.personal?.allowFromDomains).toEqual(['example.com']);
  });
});
