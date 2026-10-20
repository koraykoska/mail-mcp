const REPLY_PREFIX = /^(re|aw|sv|antw)\s*(\[\d+\])?\s*:\s*/i;
const FORWARD_PREFIX = /^(fwd|fw|wg|tr|rv)\s*:\s*/i;

/** Add a Re: prefix unless the subject already looks like a reply. */
export function replySubject(subject: string | undefined): string {
  const base = (subject ?? '').trim();
  if (!base) {
    return 'Re:';
  }
  if (REPLY_PREFIX.test(base)) {
    return base;
  }
  return `Re: ${base}`;
}

/** Add a Fwd: prefix unless the subject already looks like a forward. */
export function forwardSubject(subject: string | undefined): string {
  const base = (subject ?? '').trim();
  if (!base) {
    return 'Fwd:';
  }
  if (FORWARD_PREFIX.test(base)) {
    return base;
  }
  return `Fwd: ${base}`;
}

/**
 * Build the References header for a reply: existing ids, then the parent message-id.
 * Duplicates are removed. Order follows RFC 5322 (oldest first).
 */
export function buildReferences(
  existing: string | string[] | undefined,
  messageId: string | undefined,
): string | undefined {
  const ids = normalizeIds(existing);
  if (messageId) {
    const id = ensureBrackets(messageId);
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  if (ids.length === 0) {
    return undefined;
  }
  return ids.join(' ');
}

export function ensureBrackets(id: string): string {
  const trimmed = id.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed;
  }
  return `<${trimmed.replace(/^<|>$/g, '')}>`;
}

function normalizeIds(existing: string | string[] | undefined): string[] {
  if (!existing) {
    return [];
  }
  const raw = Array.isArray(existing) ? existing.join(' ') : existing;
  const matches = raw.match(/<[^>]+>/g);
  if (matches && matches.length > 0) {
    return [...new Set(matches)];
  }
  return raw
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(ensureBrackets);
}
