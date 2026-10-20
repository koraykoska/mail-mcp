import { describe, expect, it } from 'vitest';
import {
  addressToAscii,
  formatAddress,
  parseAddress,
  parseAddressList,
} from '../../src/mime/address.js';
import { buildRawMessage } from '../../src/mime/build.js';
import { headerValue, messageIds } from '../../src/mime/headers.js';
import { capText, parseRawMessage } from '../../src/mime/parse.js';
import { domainAllowed, planReply, planReplyAll, quotePlain } from '../../src/mime/reply.js';
import { makeSnippet } from '../../src/mime/snippet.js';
import { buildReferences, forwardSubject, replySubject } from '../../src/mime/subject.js';
import { flattenThread, threadMessages } from '../../src/mime/thread.js';
import {
  brokenEncoding,
  calendarInvite,
  htmlAlternative,
  multipartMixed,
  nestedRfc822,
  smimeSigned,
} from '../fixtures/messages.js';

describe('addresses', () => {
  it('parses display names, lists, and IDN domains', () => {
    expect(parseAddress('Ada <ada@example.com>')).toEqual({
      name: 'Ada',
      address: 'ada@example.com',
    });
    expect(parseAddressList('a@example.com, "Bee, C" <bee@example.com>')).toHaveLength(2);
    const idn = parseAddress('用户@例子.测试');
    expect(addressToAscii(idn.address)).toMatch(/xn--/);
    expect(formatAddress({ name: 'A, B', address: 'a@example.com' })).toContain('<a@example.com>');
    expect(() => parseAddress('not an address')).toThrow(/missing a domain|Could not parse/);
  });
});

describe('subjects and quoting', () => {
  it('adds reply and forward prefixes once', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('Re: Hello')).toBe('Re: Hello');
    expect(replySubject('Aw: Hallo')).toBe('Aw: Hallo');
    expect(forwardSubject('Hello')).toBe('Fwd: Hello');
    expect(forwardSubject('Fw: Hello')).toBe('Fw: Hello');
    expect(buildReferences('<a@x> <b@x>', '<c@x>')).toBe('<a@x> <b@x> <c@x>');
    expect(buildReferences('<a@x>', '<a@x>')).toBe('<a@x>');
  });

  it('plans reply and reply-all without our own addresses', () => {
    const original = {
      from: [{ name: 'Ada', address: 'ada@example.com' }],
      to: [{ address: 'user@example.com' }, { address: 'bea@example.com' }],
      cc: [{ address: 'ada@example.com' }],
      replyTo: [],
    };
    expect(planReply(original, ['user@example.com']).map((item) => item.address)).toEqual([
      'ada@example.com',
    ]);
    const all = planReplyAll(original, ['user@example.com']);
    expect(all.to.map((item) => item.address)).toEqual(['ada@example.com']);
    expect(all.cc.map((item) => item.address)).toEqual(['bea@example.com']);
    expect(quotePlain('line', 'Ada', 'Tuesday')).toContain('> line');
    expect(domainAllowed('a@mail.example.com', ['example.com'])).toBe(true);
    expect(domainAllowed('a@other.test', ['example.com'])).toBe(false);
    expect(domainAllowed('a@other.test', [])).toBe(true);
  });
});

describe('threading', () => {
  it('links replies and flattens parent-before-child', () => {
    const tree = threadMessages([
      { uid: 1, messageId: '<a@x>', subject: 'Hello' },
      {
        uid: 2,
        messageId: '<b@x>',
        inReplyTo: '<a@x>',
        references: ['<a@x>'],
        subject: 'Re: Hello',
      },
      { uid: 3, messageId: '<c@x>', subject: 'Other' },
    ]);
    expect(flattenThread(tree)).toEqual([1, 2, 3]);
    const bySubject = threadMessages(
      [
        { uid: 1, subject: 'Hello' },
        { uid: 2, subject: 'Re: Hello' },
      ],
      true,
    );
    expect(flattenThread(bySubject)).toEqual([1, 2]);
  });
});

describe('mime fixtures', () => {
  it('parses multipart, html, nested, calendar, smime, and broken charset mail', async () => {
    const mixed = await parseRawMessage(multipartMixed);
    expect(mixed.attachments.some((item) => item.filename === 'notes.pdf')).toBe(true);
    expect(mixed.text).toContain('See attached');

    const html = await parseRawMessage(htmlAlternative);
    expect(html.subject).toBe('Café');
    expect(html.htmlAsText?.toLowerCase()).toContain('cafe');
    expect(html.from[0]?.name).toContain('Ada');

    const nested = await parseRawMessage(nestedRfc822);
    expect(nested.subject).toBe('Nested');

    const calendar = await parseRawMessage(calendarInvite);
    expect(calendar.attachments.some((item) => item.contentType.includes('calendar'))).toBe(true);

    const signed = await parseRawMessage(smimeSigned);
    expect(signed.text).toContain('Signed body');
    expect(signed.attachments.length).toBeGreaterThan(0);

    const broken = await parseRawMessage(brokenEncoding);
    expect(broken.subject).toBeTruthy();
    expect(capText('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
    expect(makeSnippet('  hello   world  ', 100)).toBe('hello world');
  });
});

describe('message builder', () => {
  it('builds alternative bodies, inline images, and encoded subjects', async () => {
    const raw = await buildRawMessage({
      from: { name: 'User', address: 'user@example.com' },
      to: [{ address: 'ada@example.com' }],
      cc: [{ name: 'Bee', address: 'bee@example.com' }],
      subject: 'Café',
      text: 'plain',
      html: '<p>html <img src="cid:logo"></p>',
      attachments: [
        {
          filename: 'logo.png',
          contentType: 'image/png',
          contentBase64: Buffer.from('png').toString('base64'),
          cid: 'logo',
          inline: true,
        },
      ],
      inReplyTo: '<m@example.com>',
      references: '<m@example.com>',
      priority: 'high',
      readReceipt: true,
      headers: { 'X-Test': '1' },
    });
    const text = raw.toString('utf8');
    expect(text.toLowerCase()).toContain('multipart/');
    expect(text).toContain('X-Test: 1');
    expect(text.toLowerCase()).toContain('disposition-notification-to');
    const parsed = await parseRawMessage(raw);
    expect(parsed.subject).toBe('Café');
    expect(parsed.inReplyTo).toContain('m@example.com');
    expect(headerValue(text, 'x-test')).toBe('1');
    expect(messageIds(headerValue(text, 'references'))).toContain('<m@example.com>');
  });

  it('rejects an empty message', async () => {
    await expect(
      buildRawMessage({
        from: { address: 'a@example.com' },
        to: [{ address: 'b@example.com' }],
        subject: 'x',
      }),
    ).rejects.toThrow(/text, html, or at least one attachment/);
  });
});
