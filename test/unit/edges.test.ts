import { describe, expect, it, vi } from 'vitest';
import { clearTokenCache, getAccessToken } from '../../src/auth/oauth.js';
import { htmlToRoughText } from '../../src/mime/snippet.js';
import { findTextPart } from '../../src/mime/parse.js';
import { sortMessages } from '../../src/imap/sort.js';
import { decodeBody, encodeBody } from '../../src/charset.js';
import { parseJsonc } from '../../src/config/jsonc.js';
import { SlidingWindowLimiter } from '../../src/rate-limit.js';
import { makeSnippet } from '../../src/mime/snippet.js';
import { redactValue } from '../../src/redact.js';
import { headerValue } from '../../src/mime/headers.js';
import { replySubject, forwardSubject } from '../../src/mime/subject.js';
import { normalizeFlag } from '../../src/imap/flags.js';
import { uidList } from '../../src/imap/session.js';
import { renderToolText } from '../../src/tools/render.js';
import { compileSearch, assertSearchCapabilities } from '../../src/imap/search.js';
import { ImapConnectionPool } from '../../src/imap/pool.js';
import { MailError, mapTransportError } from '../../src/errors.js';
import type { ImapSession } from '../../src/imap/session.js';
import { createLogger } from '../../src/log.js';
import * as api from '../../src/index.js';

describe('edges', () => {
  it('exports the public API and renders rough HTML', () => {
    expect(api.VERSION).toMatch(/\d+\.\d+\.\d+/);
    expect(api.PACKAGE_NAME).toBe('mail-mcp');
    expect(htmlToRoughText('<style>x</style><p>A &amp; B<br>&#65;</p>')).toContain('A & B');
    expect(
      findTextPart({
        type: 'multipart',
        subtype: 'mixed',
        parameters: {},
        dispositionParameters: {},
        children: [
          {
            type: 'text',
            subtype: 'html',
            part: '1',
            parameters: {},
            dispositionParameters: {},
            children: [],
          },
        ],
      })?.kind,
    ).toBe('html');
    expect(
      sortMessages(
        [{ uid: 1 }, { uid: 2, size: 3, from: 'b' }, { uid: 3, size: 9, from: 'a' }],
        [{ field: 'size' }, { field: 'from', reverse: true }],
      ).map((item) => item.uid),
    ).toEqual([2, 3, 1]);
    expect(decodeBody(Buffer.from('h'), '')).toBe('h');
    expect(encodeBody('é', 'latin1').length).toBeGreaterThan(0);
    expect(encodeBody('x', 'not-a-charset').toString()).toBe('x');
    expect(makeSnippet('hello world', 5).endsWith('…')).toBe(true);
    expect(htmlToRoughText('<script>no</script>&#x41;&unknown;')).toContain('A');
    expect(() => parseJsonc('{', 'bad')).toThrow(/Could not parse/);
    const limiter = new SlidingWindowLimiter();
    limiter.consume('k', 0, 1);
    limiter.reset();
    expect(redactValue(1)).toBe(1);
    expect(headerValue('Subject: hi\n continuation\nFrom: a\n', 'subject')).toContain('hi');
    expect(replySubject('')).toBe('Re:');
    expect(forwardSubject(undefined)).toBe('Fwd:');
    expect(() => normalizeFlag('\\')).toThrow();
    expect(() => uidList([])).toThrow();
    expect(mapTransportError(new Error('UIDVALIDITY changed')).code).toBe('UIDVALIDITY_CHANGED');
    expect(mapTransportError(new Error('')).code).toBe('PROTOCOL_ERROR');
    expect(mapTransportError('plain failure').code).toBe('PROTOCOL_ERROR');
    expect(renderToolText({ ok: false, note: '!'.repeat(4500) })).toContain('…');
  });

  it('compiles the remaining search shapes and checks capabilities', () => {
    const compiled = compileSearch({
      and: [{ from: 'a' }, { subject: 'b' }],
      labels: { has: ['Work'], not: ['Spam'] },
      emailId: 'e1',
      threadId: 't1',
      larger: 10,
      smaller: 20,
      keyword: '$Forwarded',
      unkeyword: 'junk',
      seq: '1:2',
      sentSince: '2026-01-01',
      sentBefore: '2026-02-01',
      sentOn: '2026-01-15',
      on: '2026-01-15T12:00:00Z',
      answered: true,
      flagged: false,
      deleted: false,
      draft: false,
      recent: false,
    });
    expect(compiled.requires).toEqual(expect.arrayContaining(['gmail', 'objectid']));
    expect(() => assertSearchCapabilities(['condstore'], () => false)).toThrow(/CONDSTORE/);
    expect(() => assertSearchCapabilities(['objectid'], () => false)).toThrow(/OBJECTID/);
    expect(() => compileSearch({ since: 'not-a-date' })).toThrow(MailError);
  });

  it('refreshes an OAuth token and reuses the cache', async () => {
    clearTokenCache();
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'cached-token', expires_in: 3600 }), {
          status: 200,
        }),
    );
    const auth = {
      type: 'oauth2' as const,
      refreshToken: 'r',
      clientId: 'id',
      clientSecret: 'secret',
      tokenUrl: 'https://example.com/token',
      scope: 'mail',
    };
    const first = await getAccessToken(
      auth,
      'acct',
      fetchImpl as unknown as typeof fetch,
      () => 10_000,
    );
    const second = await getAccessToken(
      auth,
      'acct',
      fetchImpl as unknown as typeof fetch,
      () => 11_000,
    );
    expect(first).toBe('cached-token');
    expect(second).toBe('cached-token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await getAccessToken({ type: 'password', password: 'x' }, 'acct')).toBeUndefined();
    expect(await getAccessToken({ type: 'xoauth2', accessToken: 'direct' }, 'other')).toBe(
      'direct',
    );
    const failing = vi.fn(async () => {
      throw new Error('network down');
    });
    clearTokenCache();
    await expect(getAccessToken(auth, 'acct2', failing as unknown as typeof fetch)).rejects.toThrow(
      /network down/,
    );
  });

  it('retries a dropped IMAP connection once', async () => {
    let connects = 0;
    const session = {
      async connect() {
        connects += 1;
        if (connects === 1) {
          throw new MailError('CONNECTION_FAILED', 'dropped');
        }
      },
      async logout() {
        return undefined;
      },
      close() {
        return undefined;
      },
    } as unknown as ImapSession;
    const pool = new ImapConnectionPool(async () => session, 1, createLogger({ level: 'silent' }));
    let calls = 0;
    await pool.use('work', async () => {
      calls += 1;
      if (calls === 1) {
        throw new MailError('CONNECTION_FAILED', 'reset');
      }
      return 'ok';
    });
    expect(calls).toBe(2);
    await pool.close();
  });
});
