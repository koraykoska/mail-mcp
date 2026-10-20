/** True when the buffer contains an octet above 7 bits. */
export function hasHighOctets(buffer: Buffer): boolean {
  for (const byte of buffer) {
    if (byte > 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Decode a MIME body fetched with BODY[section]. FETCH BINARY and ImapFlow's
 * download() already return decoded octets; pass those through with encoding "binary".
 */
export function decodeTransfer(content: Buffer, encoding: string | undefined): Buffer {
  const normalized = (encoding ?? '7bit').toLowerCase().trim();
  if (normalized === 'base64') {
    const compact = content.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, '');
    return Buffer.from(compact, 'base64');
  }
  if (normalized === 'quoted-printable') {
    return decodeQuotedPrintable(content);
  }
  return content;
}

export function decodeQuotedPrintable(content: Buffer): Buffer {
  const text = content.toString('latin1');
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '=') {
      bytes.push(text.charCodeAt(index));
      continue;
    }
    const next = text[index + 1];
    if (next === '\r' && text[index + 2] === '\n') {
      index += 2;
      continue;
    }
    if (next === '\n') {
      index += 1;
      continue;
    }
    const hex = text.slice(index + 1, index + 3);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    bytes.push(text.charCodeAt(index));
  }
  return Buffer.from(bytes);
}

/** Remove Bcc header fields, including folded continuation lines, from an RFC 5322 message. */
export function stripBcc(raw: Buffer): Buffer {
  const text = raw.toString('latin1');
  const split = text.indexOf('\r\n\r\n');
  const sep = split >= 0 ? split : text.indexOf('\n\n');
  const width = split >= 0 ? 4 : 2;
  if (sep < 0) {
    return raw;
  }
  const header = text.slice(0, sep);
  const body = text.slice(sep + width);
  const lines = header.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) {
        kept.push(line);
      }
      continue;
    }
    skipping = /^bcc\s*:/i.test(line);
    if (!skipping) {
      kept.push(line);
    }
  }
  const ending = text.includes('\r\n') ? '\r\n' : '\n';
  return Buffer.from(`${kept.join(ending)}${ending}${ending}${body}`, 'latin1');
}

/** Expand a compact IMAP sequence set such as `1,5:7,9`. */
export function parseSequenceSet(value: string): number[] {
  const numbers: number[] = [];
  for (const part of value.split(',')) {
    const piece = part.trim();
    if (!piece) {
      continue;
    }
    const range = /^(\d+):(\d+)$/.exec(piece);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      for (let uid = low; uid <= high; uid += 1) {
        numbers.push(uid);
      }
      continue;
    }
    if (/^\d+$/.test(piece)) {
      numbers.push(Number(piece));
    }
  }
  return numbers;
}
