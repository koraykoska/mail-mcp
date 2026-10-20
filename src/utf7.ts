/**
 * IMAP modified UTF-7 (RFC 3501 section 5.1.3).
 * Mailbox names on the wire use this encoding unless the server enabled UTF8=ACCEPT.
 */

function utf16be(input: string): Buffer {
  const le = Buffer.from(input, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1] ?? 0;
    be[i + 1] = le[i] ?? 0;
  }
  return be;
}

function utf16beToString(buffer: Buffer): string {
  const le = Buffer.alloc(buffer.length);
  for (let i = 0; i < buffer.length; i += 2) {
    le[i] = buffer[i + 1] ?? 0;
    le[i + 1] = buffer[i] ?? 0;
  }
  return le.toString('utf16le');
}

function encodeBase64Modified(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\//g, ',').replace(/=+$/g, '');
}

function decodeBase64Modified(value: string): Buffer {
  const padded = value.replace(/,/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

/** Encode a Unicode mailbox name to modified UTF-7. */
export function encodeModifiedUtf7(input: string): string {
  let out = '';
  let buffer = '';
  const flush = (): void => {
    if (!buffer) {
      return;
    }
    out += `&${encodeBase64Modified(utf16be(buffer))}-`;
    buffer = '';
  };
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code <= 0x7e && char !== '&') {
      flush();
      out += char;
    } else if (char === '&') {
      flush();
      out += '&-';
    } else {
      buffer += char;
    }
  }
  flush();
  return out;
}

/** Decode a modified UTF-7 mailbox name to Unicode. */
export function decodeModifiedUtf7(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char !== '&') {
      out += char;
      continue;
    }
    const end = input.indexOf('-', i);
    if (end === -1) {
      throw new Error('Modified UTF-7 sequence is missing its terminator.');
    }
    const payload = input.slice(i + 1, end);
    if (payload === '') {
      out += '&';
    } else {
      const bytes = decodeBase64Modified(payload);
      out += utf16beToString(bytes);
    }
    i = end;
  }
  return out;
}
