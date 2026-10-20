import iconv from 'iconv-lite';

/**
 * Decode a MIME body part. Unknown charsets fall back to UTF-8 with replacement
 * rather than throwing, so one odd message does not fail a whole fetch.
 */
export function decodeBody(buffer: Buffer, charset: string | undefined): string {
  const name = (charset || 'utf-8')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]/g, '');
  const normalized = name === 'utf8' ? 'utf-8' : name;
  if (
    !normalized ||
    normalized === 'utf-8' ||
    normalized === 'us-ascii' ||
    normalized === 'ascii'
  ) {
    return buffer.toString('utf8');
  }
  if (iconv.encodingExists(normalized)) {
    return iconv.decode(buffer, normalized);
  }
  return buffer.toString('utf8');
}

/** Encode a Unicode string for a MIME part. */
export function encodeBody(text: string, charset = 'utf-8'): Buffer {
  const normalized = charset.toLowerCase();
  if (normalized === 'utf-8' || normalized === 'utf8') {
    return Buffer.from(text, 'utf8');
  }
  if (iconv.encodingExists(normalized)) {
    return iconv.encode(text, normalized);
  }
  return Buffer.from(text, 'utf8');
}
