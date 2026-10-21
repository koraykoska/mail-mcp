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
import {
  FORWARD_SUBJECT_PREFIXES,
  REPLY_SUBJECT_PREFIXES,
  buildReferences,
  forwardSubject,
  replySubject,
} from '../../src/mime/subject.js';
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
    expect(replySubject('Antw: Hallo')).toBe('Antw: Hallo');
    expect(replySubject('Re[2]: Hello')).toBe('Re[2]: Hello');
    expect(replySubject('Antw[2]: Hallo')).toBe('Antw[2]: Hallo');
    for (const prefix of REPLY_SUBJECT_PREFIXES) {
      expect(replySubject(`${prefix}: Hello`)).toBe(`${prefix}: Hello`);
      expect(replySubject(`${prefix}[2]: Hello`)).toBe(`${prefix}[2]: Hello`);
    }
    expect(forwardSubject('Hello')).toBe('Fwd: Hello');
    expect(forwardSubject('Fw: Hello')).toBe('Fw: Hello');
    for (const prefix of FORWARD_SUBJECT_PREFIXES) {
      expect(forwardSubject(`${prefix}: Hello`)).toBe(`${prefix}: Hello`);
    }
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
    expect(flattenThread(tree).map((item) => item.uid)).toEqual([1, 2, 3]);
    const bySubject = threadMessages(
      [
        { uid: 1, subject: 'Hello' },
        { uid: 2, subject: 'Re: Hello' },
      ],
      true,
    );
    expect(flattenThread(bySubject).map((item) => item.uid)).toEqual([1, 2]);
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

function expectHeaderLines(raw: Buffer): void {
  const text = raw.toString('binary');
  const headerEnd = text.indexOf('\r\n\r\n');
  const block = headerEnd === -1 ? text : text.slice(0, headerEnd);
  for (const line of block.split('\r\n')) {
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(998);
  }
}

/** Unfold one header and decode the UTF-8 Base64 words this builder emits. */
function decodedHeader(raw: Buffer, name: string): string {
  const text = raw.toString('binary');
  const headerEnd = text.indexOf('\r\n\r\n');
  const block = headerEnd === -1 ? text : text.slice(0, headerEnd);
  const lines = block.split('\r\n');
  const collected: string[] = [];
  const prefix = `${name.toLowerCase()}:`;
  let capture = false;
  for (const line of lines) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (capture) {
        collected.push(line);
      }
      continue;
    }
    capture = line.toLowerCase().startsWith(prefix);
    if (capture) {
      collected.push(line);
    }
  }
  const unfolded = collected
    .join('\r\n')
    .replace(/\r\n([ \t])/g, '$1')
    .slice(name.length + 1)
    .trim();
  return unfolded.replace(
    /(=\?UTF-8\?B\?[A-Za-z0-9+/=]*\?=)(?:[ \t]+(=\?UTF-8\?B\?[A-Za-z0-9+/=]*\?=))*/g,
    (group) =>
      group
        .split(/[ \t]+/)
        .map((word) => Buffer.from(word.slice('=?UTF-8?B?'.length, -2), 'base64').toString('utf8'))
        .join(''),
  );
}

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

  it('omits a message id that cannot fit on one 998-octet line', async () => {
    const long = `<${'a'.repeat(1200)}@example.com>`;
    const fitting = `<${'b'.repeat(880)}@example.com>`;
    const raw = await buildRawMessage({
      from: { address: 'a@example.com' },
      to: [{ address: 'b@example.com' }],
      subject: 'x',
      text: 'y',
      messageId: long,
      inReplyTo: long,
      references: `<short@example.com> ${long}`,
    });
    const text = raw.toString('binary');
    const headerEnd = text.indexOf('\r\n\r\n');
    const block = headerEnd === -1 ? text : text.slice(0, headerEnd);
    for (const line of block.split('\r\n')) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(998);
    }
    expect(block).not.toContain('a'.repeat(200));
    expect(block).toMatch(/^Message-ID:/im);
    expect(block).toContain('<short@example.com>');
    expect(block).not.toMatch(/^In-Reply-To:/im);

    const kept = await buildRawMessage({
      from: { address: 'a@example.com' },
      to: [{ address: 'b@example.com' }],
      subject: 'x',
      text: 'y',
      messageId: fitting,
      inReplyTo: fitting,
    });
    const keptText = kept.toString('binary');
    expect(keptText).toContain(fitting);
    expect(keptText).toMatch(/^In-Reply-To:/im);
    const keptEnd = keptText.indexOf('\r\n\r\n');
    const keptBlock = keptEnd === -1 ? keptText : keptText.slice(0, keptEnd);
    for (const line of keptBlock.split('\r\n')) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(998);
    }
  });

  it('encodes a subject, Comments, and Keywords that cannot fit on one line', async () => {
    for (const length of [998, 5000]) {
      const subject = 'a'.repeat(length);
      const comments = 'c'.repeat(length);
      const keywords = 'k'.repeat(length);
      const raw = await buildRawMessage({
        from: { address: 'a@example.com' },
        to: [{ address: 'b@example.com' }],
        subject,
        text: 'y',
        headers: { Comments: comments, Keywords: keywords },
      });
      expectHeaderLines(raw);
      const parsed = await parseRawMessage(raw);
      expect(parsed.subject).toBe(subject);
      expect(decodedHeader(raw, 'Comments')).toBe(comments);
      expect(decodedHeader(raw, 'Keywords')).toBe(keywords);
    }

    const viaFields = await buildRawMessage({
      from: { address: 'a@example.com' },
      to: [{ address: 'b@example.com' }],
      subject: 'a'.repeat(998),
      text: 'y',
      headerFields: [{ name: 'Comments', value: 'c'.repeat(5000) }],
    });
    expectHeaderLines(viaFields);
    expect(decodedHeader(viaFields, 'Comments')).toBe('c'.repeat(5000));
    expect((await parseRawMessage(viaFields)).subject).toBe('a'.repeat(998));
  });

  it('keeps a subject that fits on one line as itself', async () => {
    const subject = 'a'.repeat(989);
    const raw = await buildRawMessage({
      from: { address: 'a@example.com' },
      to: [{ address: 'b@example.com' }],
      subject,
      text: 'y',
    });
    expectHeaderLines(raw);
    expect(raw.toString('utf8')).toContain(subject);
    expect(raw.toString('utf8')).not.toContain('=?UTF-8?B?');
    expect((await parseRawMessage(raw)).subject).toBe(subject);
  });

  it('round-trips a long subject that contains multibyte characters', async () => {
    const subject = `${'é'.repeat(600)}${'😀'.repeat(20)}`;
    const raw = await buildRawMessage({
      from: { address: 'a@example.com' },
      to: [{ address: 'b@example.com' }],
      subject,
      text: 'y',
    });
    expectHeaderLines(raw);
    expect((await parseRawMessage(raw)).subject).toBe(subject);
  });

  it('names the header when a line is still over 998 octets', async () => {
    await expect(
      buildRawMessage({
        from: { address: 'a@example.com' },
        to: [{ address: 'b@example.com' }],
        subject: 'x',
        text: 'y',
        headers: { 'X-Long': 'z'.repeat(1200) },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringMatching(/The X-Long header has a line of \d+ octets/),
      hint: expect.stringContaining('X-Long'),
    });
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
