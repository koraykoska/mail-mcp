import { describe, expect, it } from 'vitest';
import { MailError, mapTransportError, isRetryableConnectionError } from '../../src/errors.js';
import { redactText, redactValue } from '../../src/redact.js';
import { createLogger } from '../../src/log.js';
import {
  decodeCursor,
  encodeCursor,
  paginate,
  clampLimit,
  pageByPosition,
  pageAfterUid,
} from '../../src/pagination.js';
import { decodeModifiedUtf7, encodeModifiedUtf7 } from '../../src/utf7.js';
import { decodeBody, encodeBody } from '../../src/charset.js';
import { SlidingWindowLimiter } from '../../src/rate-limit.js';
import { withTimeout } from '../../src/timeout.js';
import { parseJsonc } from '../../src/config/jsonc.js';
import { substituteEnv } from '../../src/config/substitute.js';
import { normalizeFlag, normalizeFlags } from '../../src/imap/flags.js';
import { compileSearch, parseImapDate, assertSearchCapabilities } from '../../src/imap/search.js';
import { sortMessages } from '../../src/imap/sort.js';
import { resolveSpecialUse } from '../../src/imap/special-use.js';
import { parseThreadNode } from '../../src/imap/flow-session.js';
import { uidList } from '../../src/imap/session.js';

describe('errors', () => {
  it('maps auth, tls, timeout, missing, and connection failures', () => {
    expect(
      mapTransportError(
        Object.assign(new Error('Invalid credentials'), { authenticationFailed: true }),
      ).code,
    ).toBe('AUTH_FAILED');
    expect(mapTransportError(new Error('self-signed certificate')).code).toBe('TLS_FAILED');
    expect(
      mapTransportError(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })).code,
    ).toBe('TIMEOUT');
    expect(mapTransportError(new Error('Mailbox does not exist')).code).toBe('NOT_FOUND');
    expect(mapTransportError(new Error('Missing server extension MOVE')).code).toBe(
      'CAPABILITY_UNSUPPORTED',
    );
    expect(mapTransportError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })).code).toBe(
      'CONNECTION_FAILED',
    );
    expect(mapTransportError(new Error('NO [ALERT] nope')).code).toBe('PROTOCOL_ERROR');
    const existing = new MailError('SIZE_LIMIT', 'too big');
    expect(mapTransportError(existing)).toBe(existing);
  });

  it('retries only connection and timeout failures', () => {
    expect(isRetryableConnectionError(new MailError('CONNECTION_FAILED', 'x'))).toBe(true);
    expect(isRetryableConnectionError(new MailError('AUTH_FAILED', 'x'))).toBe(false);
  });
});

describe('redaction', () => {
  it('scrubs secrets, bearer tokens, and assignment forms', () => {
    const text = redactText('password=hunter2 Authorization: Bearer abc.def token: zzzz', [
      'hunter2',
    ]);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('abc.def');
    expect(text).toContain('[redacted]');
    const value = redactValue({ password: 'hunter2', nested: { note: 'hunter2' } }, ['hunter2']);
    expect(JSON.stringify(value)).not.toContain('hunter2');
  });
});

describe('logger', () => {
  it('writes redacted json to the provided stream and honours level', () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'info',
      secrets: ['secret'],
      stream: {
        write: (chunk: string) => lines.push(String(chunk)),
      } as unknown as NodeJS.WritableStream,
    });
    logger.debug('hidden');
    logger.info('hello', { password: 'secret', note: 'secret' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('secret');
    expect(lines[0]).toContain('hello');
  });
});

describe('pagination', () => {
  it('pages and round-trips cursors', () => {
    const page = paginate([1, 2, 3, 4], 0, 2);
    expect(page.items).toEqual([1, 2]);
    expect(page.nextCursor).toBeTruthy();
    const cursor = decodeCursor(encodeCursor({ v: 1, offset: 2, uidValidity: '9' }), '9');
    expect(cursor.offset).toBe(2);
    expect(() => decodeCursor('@@@')).toThrow(MailError);
    expect(() => decodeCursor(encodeCursor({ v: 1, offset: 1, uidValidity: '1' }), '2')).toThrow(
      /UIDVALIDITY/,
    );
    expect(clampLimit(undefined, 25, 100)).toBe(25);
    expect(() => clampLimit(0, 25, 100)).toThrow(MailError);
    expect(() => clampLimit(101, 25, 100)).toThrow(MailError);
    const first = pageByPosition([3, 1, 2], 1, 0, '9');
    expect(first.uids).toEqual([3]);
    expect(decodeCursor(first.nextCursor ?? '', '9')).toMatchObject({
      v: 3,
      position: 1,
      uidValidity: '9',
    });
    expect(pageByPosition([3, 1, 2], 1, 1, '9').uids).toEqual([1]);
    expect(pageByPosition([3, 1, 2], 1, 2, '9')).toMatchObject({ uids: [2], nextCursor: null });
    expect(pageByPosition([3, 1, 2], 1, 0).nextCursor).toEqual(expect.any(String));
    expect(() => pageByPosition([1], 1, -1)).toThrow(MailError);
    expect(() => pageByPosition([1], 1, 1.5)).toThrow(MailError);
    expect(() => decodeCursor(encodeCursor({ v: 3, position: -1 }))).toThrow(MailError);
    expect(() => decodeCursor(encodeCursor({ v: 3, position: 1.5 }))).toThrow(MailError);
    expect(() =>
      decodeCursor(
        Buffer.from(JSON.stringify({ v: 3, position: '1' }), 'utf8').toString('base64url'),
      ),
    ).toThrow(MailError);
    expect(() =>
      decodeCursor(Buffer.from(JSON.stringify({ v: 4 }), 'utf8').toString('base64url')),
    ).toThrow(MailError);
    expect(() => decodeCursor(Buffer.from('null').toString('base64url'))).toThrow(MailError);
    expect(() => decodeCursor(Buffer.from('1').toString('base64url'))).toThrow(MailError);
    expect(() => decodeCursor(encodeCursor({ v: 1, offset: -1 }))).toThrow(MailError);
    expect(() => decodeCursor(encodeCursor({ v: 2, afterUid: 0 }))).toThrow(MailError);
    expect(pageAfterUid([4, 3, 2, 1], 2).nextCursor).toEqual(expect.any(String));
    expect(paginate([1], 0, 2).nextCursor).toBeUndefined();
  });
});

describe('modified utf-7', () => {
  it('round-trips ascii, ampersand, and non-ascii mailbox names', () => {
    for (const name of ['INBOX', 'A&B', 'Entwürfe', '收件箱', 'Café/2026']) {
      expect(decodeModifiedUtf7(encodeModifiedUtf7(name))).toBe(name);
    }
    expect(encodeModifiedUtf7('&')).toBe('&-');
  });
});

describe('charset', () => {
  it('decodes latin1 and falls back for unknown charsets', () => {
    const latin = encodeBody('café', 'latin1');
    expect(decodeBody(latin, 'iso-8859-1')).toContain('caf');
    expect(decodeBody(Buffer.from('hello'), 'x-nope')).toBe('hello');
  });
});

describe('rate limit', () => {
  it('allows a burst then rejects until the window moves', () => {
    let now = 1_000;
    const limiter = new SlidingWindowLimiter(() => now);
    limiter.consume('a', 2, 1_000);
    limiter.consume('a', 2, 1_000);
    expect(() => limiter.consume('a', 2, 1_000)).toThrow(/RATE_LIMITED|rate limit/i);
    now += 1_001;
    limiter.consume('a', 2, 1_000);
  });
});

describe('timeout', () => {
  it('rejects when the work is slower than the budget', async () => {
    await expect(withTimeout(20, 'op', new Promise(() => undefined))).rejects.toThrow(/timed out/);
    await expect(withTimeout(50, 'op', Promise.resolve(1))).resolves.toBe(1);
  });
});

describe('jsonc and env substitution', () => {
  it('strips comments and trailing commas', () => {
    const parsed = parseJsonc('{\n// hi\n"a": 1, /* c */ "b": "http://x",\n}');
    expect(parsed).toEqual({ a: 1, b: 'http://x' });
    expect(() => parseJsonc('{ "a": /* unterminated')).toThrow(MailError);
  });

  it('substitutes variables, defaults, and escapes', () => {
    expect(substituteEnv('x ${NAME:-fallback}', {}, 'cfg')).toBe('x fallback');
    expect(substituteEnv('${NAME}', { NAME: 'Ada' }, 'cfg')).toBe('Ada');
    expect(substituteEnv('$${NAME}', {}, 'cfg')).toBe('${NAME}');
    expect(() => substituteEnv('${MISSING}', {}, 'file')).toThrow(/MISSING/);
  });
});

describe('flags', () => {
  it('normalizes system flags and rejects empty or spaced keywords', () => {
    expect(normalizeFlags(['seen', '\\Flagged', 'seen', '$Forwarded'])).toEqual([
      '\\Seen',
      '\\Flagged',
      '$Forwarded',
    ]);
    expect(() => normalizeFlag('bad keyword')).toThrow(MailError);
    expect(() => normalizeFlag('  ')).toThrow(MailError);
  });
});

describe('search compiler', () => {
  it('compiles flat, nested, and capability-sensitive criteria', () => {
    expect(compileSearch(undefined).query).toEqual({ all: true });
    const compiled = compileSearch({
      from: 'ada',
      seen: false,
      since: '2026-01-02',
      header: { name: 'List-Id', value: 'dev' },
      not: { subject: 'spam' },
      or: [{ from: 'a' }, { from: 'b' }],
    });
    expect(compiled.requires).toEqual([]);
    expect(compiled.query).toBeTruthy();
    const gmail = compileSearch({ gmraw: 'is:unread', modseq: '10' });
    expect(gmail.requires).toContain('gmail');
    expect(gmail.requires).toContain('condstore');
    expect(() => compileSearch({ or: [{ from: 'a' }] })).toThrow(/at least two/);
    expect(() => compileSearch({ modseq: 'nope' })).toThrow(MailError);
    expect(parseImapDate('2026-05-01').toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(() => assertSearchCapabilities(['gmail'], () => false)).toThrow(/X-GM-EXT-1/);
  });
});

describe('sort and special use', () => {
  it('sorts with missing values last and resolves provider folders', () => {
    const sorted = sortMessages(
      [
        { uid: 1, subject: 'b', arrival: '2026-01-02T00:00:00.000Z' },
        { uid: 2, subject: 'a' },
        { uid: 3, subject: 'a', arrival: '2026-01-03T00:00:00.000Z' },
      ],
      [{ field: 'subject' }, { field: 'arrival', reverse: true }],
    );
    expect(sorted.map((item) => item.uid)).toEqual([2, 3, 1]);
    const special = resolveSpecialUse(
      [
        { path: 'INBOX', name: 'INBOX', flags: [], specialUse: '\\Inbox' },
        { path: '[Gmail]/Sent Mail', name: 'Sent Mail', flags: [] },
        {
          path: 'Trash',
          name: 'Trash',
          flags: [],
          specialUse: '\\Trash',
          specialUseSource: 'extension',
        },
      ],
      'gmail',
      { drafts: 'My Drafts' },
    );
    expect(special.sent).toBe('[Gmail]/Sent Mail');
    expect(special.trash).toBe('Trash');
    expect(special.drafts).toBe('My Drafts');
    expect(special.sources.drafts).toBe('config');
  });
});

describe('thread parser and uid lists', () => {
  it('parses a THREAD response and compacts uid sets', () => {
    const node = parseThreadNode({
      attributes: [
        { value: '2' },
        { value: '3' },
        { attributes: [{ value: '4' }, { value: '5' }] },
      ],
    });
    expect(node.uid).toBe(2);
    expect(node.children.map((child) => child.uid)).toEqual([3, 4]);
    expect(uidList([3, 1, 2, 2, 8])).toBe('1:3,8');
  });
});
