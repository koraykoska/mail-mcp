import { describe, expect, it } from 'vitest';
import { MailError } from '../../src/errors.js';
import { ImapFlowSession, parseThreadNode } from '../../src/imap/flow-session.js';
import { createLogger } from '../../src/log.js';
import { account } from '../support/config.js';
import { simpleMessage } from '../fixtures/messages.js';
import { ScriptedImap } from '../support/scripted-imap.js';

const logger = createLogger({ level: 'silent' });

function imapAccount(port: number) {
  return account({
    imap: {
      host: '127.0.0.1',
      port,
      secure: false,
      starttls: 'disabled',
      timeoutMs: 8_000,
      tls: { rejectUnauthorized: false },
    },
  });
}

async function connect(server: ScriptedImap): Promise<ImapFlowSession> {
  const session = new ImapFlowSession(imapAccount(server.port), async () => undefined, logger);
  await session.connect();
  return session;
}

describe('IMAP session branches', () => {
  it('sorts with a partial window, threads, stores flags, and reads a part', async () => {
    const server = new ScriptedImap({
      capabilities: [
        'IMAP4rev1',
        'UIDPLUS',
        'IDLE',
        'ENABLE',
        'CONDSTORE',
        'SORT',
        'ESORT',
        'THREAD=REFERENCES',
        'NAMESPACE',
        'ID',
        'QUOTA',
        'ACL',
        'METADATA',
      ],
    });
    await server.ready();
    server.addMessage(simpleMessage({ subject: 'One', text: 'alpha' }).toString('utf8'), [
      '\\Seen',
    ]);
    server.addMessage(simpleMessage({ subject: 'Two', text: 'beta' }).toString('utf8'), []);
    const session = await connect(server);
    expect(session.condstoreEnabled()).toBe(true);
    const sorted = await session.withMailbox('INBOX', 'read', (box) =>
      box.serverSort(
        { query: { all: true }, requires: [] },
        [{ field: 'arrival', reverse: true }],
        {
          start: 1,
          count: 1,
        },
      ),
    );
    expect(sorted?.partial).toBe(true);
    expect(sorted?.uids.length).toBeGreaterThan(0);
    expect(sorted?.total ?? 0).toBeGreaterThanOrEqual(sorted?.uids.length ?? 0);
    const threaded = await session.withMailbox('INBOX', 'read', (box) =>
      box.serverThread('REFERENCES', { query: { all: true }, requires: [] }),
    );
    expect(threaded && threaded.length).toBeGreaterThan(0);
    const flags = await session.withMailbox('INBOX', 'write', (box) =>
      box.setFlags([1], ['\\Flagged'], 'add', '1'),
    );
    expect(flags.updated).toContain(1);
    const copied = await session.withMailbox('INBOX', 'write', (box) => box.copy([1], 'Archive'));
    expect(copied['1'] || Object.values(copied)[0]).toBeTruthy();
    const listed = await session.listMailboxes({ subscribedOnly: true });
    expect(Array.isArray(listed)).toBe(true);
    expect(server.messagesIn('INBOX').length).toBeGreaterThan(0);
    await session.close();
    await server.close();
  });

  it('falls back when display sort is rejected and refuses a sort the server rejects', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'SORT', 'SORT=DISPLAY', 'ESORT', 'UIDPLUS'],
      badSortIncluding: 'DISPLAY',
    });
    await server.ready();
    server.addMessage(simpleMessage({ subject: 'A' }).toString('utf8'), []);
    const session = await connect(server);
    const sorted = await session.withMailbox('INBOX', 'read', (box) =>
      box.serverSort({ query: { all: true }, requires: [] }, [{ field: 'subject' }], {
        start: 1,
        count: 5,
      }),
    );
    expect(sorted?.uids.length).toBeGreaterThan(0);
    await session.close();
    await server.close();

    const refused = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'SORT', 'UIDPLUS'],
      badSortIncluding: 'SORT',
    });
    await refused.ready();
    refused.addMessage(simpleMessage().toString('utf8'), []);
    const second = await connect(refused);
    await expect(
      second.withMailbox('INBOX', 'read', (box) =>
        box.serverSort({ query: { all: true }, requires: [] }, [{ field: 'date', reverse: true }]),
      ),
    ).rejects.toBeInstanceOf(MailError);
    expect(
      await second.withMailbox('INBOX', 'read', (box) =>
        box.serverThread('REFERENCES', { query: { all: true }, requires: [] }),
      ),
    ).toBeNull();
    await second.close();
    await refused.close();
  });

  it('rejects extension calls the server does not advertise', async () => {
    const server = new ScriptedImap({ capabilities: ['IMAP4rev1'] });
    await server.ready();
    const session = await connect(server);
    await expect(session.getAcl('INBOX')).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await expect(session.setAcl('INBOX', 'user', 'lr', 'set')).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    });
    await expect(session.getMetadata('INBOX', ['/private/comment'])).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    });
    await expect(session.setMetadata('INBOX', { '/private/comment': 'x' })).rejects.toMatchObject({
      code: 'CAPABILITY_UNSUPPORTED',
    });
    expect(await session.quota('INBOX')).toBeNull();
    server.addMessage(simpleMessage({ subject: 'only' }).toString('utf8'), []);
    const flags = await session.withMailbox('INBOX', 'write', (box) =>
      box.setFlags([], ['\\Seen'], 'set'),
    );
    expect(flags).toEqual({ updated: [], modified: [], missing: [] });
    await expect(
      session.withMailbox('INBOX', 'write', (box) => box.setFlags([1], ['\\Seen'], 'add', '1')),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await expect(
      session.withMailbox('INBOX', 'write', (box) => box.setLabels([1], ['Work'], 'add')),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    await session.close();
    await server.close();
  });

  it('reads a body part when download is not available', async () => {
    const server = new ScriptedImap({ capabilities: ['IMAP4rev1', 'UIDPLUS'] });
    await server.ready();
    server.addMessage(simpleMessage({ subject: 'Part', text: 'hello-part' }).toString('utf8'), []);
    const session = await connect(server);
    const result = await Promise.race([
      session.withMailbox('INBOX', 'read', (box) =>
        box.fetchParts(1, [{ key: '1', maxLength: 4 }]),
      ),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error(server.trace.join('\n'))), 1500),
      ),
    ]);
    expect(result[0]?.content.toString()).toBe('hell');
    expect(result[0]?.truncated).toBe(true);
    await session.close();
    await server.close();
  });

  it('fills a snippet from the text part and from PREVIEW', async () => {
    const server = new ScriptedImap({ capabilities: ['IMAP4rev1', 'UIDPLUS'] });
    await server.ready();
    server.addMessage(
      simpleMessage({ subject: 'Snippet', text: 'hello snippet' }).toString('utf8'),
      [],
    );
    const session = await connect(server);
    const summaries = await session.withMailbox('INBOX', 'read', (box) =>
      box.fetchSummaries([1], { snippet: true, snippetChars: 40 }),
    );
    expect(summaries[0]?.subject).toBeTruthy();
    expect(summaries[0]?.snippet ?? '').toMatch(/hello|snippet|preview/i);
    await session.close();
    await server.close();

    const preview = new ScriptedImap({ capabilities: ['IMAP4rev1', 'UIDPLUS', 'PREVIEW'] });
    await preview.ready();
    preview.addMessage(simpleMessage({ text: 'body' }).toString('utf8'), []);
    const second = await connect(preview);
    const rows = await second.withMailbox('INBOX', 'read', (box) =>
      box.fetchSummaries([1], { snippet: true, snippetChars: 20 }),
    );
    expect(rows[0]?.snippet).toBeTruthy();
    await second.close();
    await preview.close();
  });

  it('covers connect, auth retry, missing fetches, and a refused store', async () => {
    const idle = new ImapFlowSession(imapAccount(1), async () => undefined, logger);
    expect(idle.condstoreEnabled()).toBe(false);
    await idle.logout();
    expect(() => idle.serverId()).toThrow(MailError);

    const server = new ScriptedImap({ capabilities: ['IMAP4rev1', 'UIDPLUS', 'QUOTA', 'IDLE'] });
    await server.ready();
    server.addMessage(simpleMessage({ subject: 'There' }).toString('utf8'), []);
    const session = await connect(server);
    await session.connect();
    const quota = await session.quota('INBOX');
    expect(quota?.resources.some((item) => item.name === 'MESSAGE')).toBe(true);
    expect(await session.withMailbox('INBOX', 'read', (box) => box.fetchSource(99))).toBeNull();
    expect(await session.withMailbox('INBOX', 'read', (box) => box.fetchHeaders(99))).toBeNull();
    expect(await session.withMailbox('INBOX', 'read', (box) => box.fetchParts(1, []))).toEqual([]);
    expect(await session.withMailbox('INBOX', 'read', (box) => box.fetchStructure(99))).toBeNull();
    const waited = await session.waitForChanges('INBOX', 200);
    expect(waited.idleSupported).toBe(true);
    expect(typeof waited.timedOut).toBe('boolean');
    await session.close();
    await server.close();

    const oauthServer = new ScriptedImap({ capabilities: ['IMAP4rev1', 'AUTH=XOAUTH2'] });
    await oauthServer.ready();
    let tokens = 0;
    const oauth = new ImapFlowSession(
      account({
        auth: {
          type: 'oauth2',
          refreshToken: 'refresh',
          clientId: 'id',
          clientSecret: 'secret',
          tokenUrl: 'https://example.invalid/token',
        },
        imap: {
          host: '127.0.0.1',
          port: oauthServer.port,
          secure: false,
          starttls: 'disabled',
          timeoutMs: 4_000,
          tls: { rejectUnauthorized: false },
        },
      }),
      async () => {
        tokens += 1;
        return tokens === 1 ? 'tok' : 'tok-2';
      },
      logger,
    );
    await expect(oauth.connect()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(tokens).toBeGreaterThan(1);
    await oauth.close();
    await oauthServer.close();

    const refused = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'UIDPLUS', 'ENABLE', 'CONDSTORE'],
      refuseStore: true,
    });
    await refused.ready();
    refused.addMessage(simpleMessage().toString('utf8'), []);
    const storing = await connect(refused);
    await expect(
      storing.withMailbox('INBOX', 'write', (box) => box.setFlags([1], ['\\Seen'], 'add')),
    ).rejects.toBeInstanceOf(MailError);
    await storing.close();
    await refused.close();
  });

  it('reads an ESEARCH sort window and a conditional store MODIFIED set', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'SORT', 'ESORT', 'UIDPLUS', 'ENABLE', 'CONDSTORE'],
      esearchSort: true,
      modifiedStore: true,
    });
    await server.ready();
    server.addMessage(simpleMessage({ subject: 'A' }).toString('utf8'), []);
    server.addMessage(simpleMessage({ subject: 'B' }).toString('utf8'), []);
    const session = await connect(server);
    const sorted = await session.withMailbox('INBOX', 'read', (box) =>
      box.serverSort(
        { query: { all: true }, requires: [] },
        [{ field: 'arrival', reverse: true }],
        {
          start: 1,
          count: 2,
        },
      ),
    );
    expect(sorted?.partial).toBe(true);
    expect((sorted?.total ?? 0) >= (sorted?.uids.length ?? 0)).toBe(true);
    const flags = await session.withMailbox('INBOX', 'write', (box) =>
      box.setFlags([1], ['\\Seen'], 'add', '5'),
    );
    expect(flags.modified.length + flags.updated.length).toBeGreaterThan(0);
    await session.close();
    await server.close();
  });

  it('sets labels and reports a refused copy', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'UIDPLUS', 'X-GM-EXT-1'],
    });
    await server.ready();
    server.addMessage(simpleMessage({ subject: 'L' }).toString('utf8'), []);
    const session = await connect(server);
    await session.withMailbox('INBOX', 'write', async (box) => {
      await box.setLabels([1], ['Work'], 'add');
      await box.setLabels([1], ['Work'], 'remove');
      await box.setLabels([1], ['Work'], 'set');
    });
    await session.close();
    await server.close();

    const refused = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'UIDPLUS'],
      refuseCopy: true,
    });
    await refused.ready();
    refused.addMessage(simpleMessage().toString('utf8'), []);
    const copying = await connect(refused);
    await expect(
      copying.withMailbox('INBOX', 'write', (box) => box.copy([1], 'Archive')),
    ).rejects.toBeInstanceOf(MailError);
    await copying.close();
    await refused.close();
  });

  it('reports a label update for an unknown UID as not found', async () => {
    const server = new ScriptedImap({
      capabilities: ['IMAP4rev1', 'UIDPLUS', 'X-GM-EXT-1'],
    });
    await server.ready();
    server.addMessage(simpleMessage({ subject: 'L' }).toString('utf8'), []);
    const session = await connect(server);
    await expect(
      session.withMailbox('INBOX', 'write', (box) => box.setLabels([999999], ['Work'], 'add')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await session.withMailbox('INBOX', 'write', (box) => box.setLabels([1], ['Work'], 'add'));
    await session.close();
    await server.close();
  });

  it('parses thread nodes that are a bare uid or a nested list', () => {
    expect(parseThreadNode({ value: '4' }).uid).toBe(4);
    const nested = parseThreadNode({
      attributes: [{ value: '1' }, { attributes: [{ value: '2' }] }],
    });
    expect(nested.uid).toBe(1);
    expect(nested.children[0]?.uid).toBe(2);
    expect(parseThreadNode({ value: 'nope' }).uid).toBeUndefined();
  });
});
