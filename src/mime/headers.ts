/** Unfold and read one header from a raw header block. Matching is case-insensitive. */
export function headerValue(raw: string, name: string): string | undefined {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const wanted = name.toLowerCase();
  let found: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (!match) {
      if (found !== undefined && /^[ \t]/.test(line)) {
        found += ` ${line.trim()}`;
      }
      continue;
    }
    if (found !== undefined && match[1]?.toLowerCase() !== wanted) {
      break;
    }
    if (match[1]?.toLowerCase() === wanted) {
      found = match[2] ?? '';
    }
  }
  return found?.trim() || undefined;
}

export function messageIds(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const bracketed = value.match(/<[^>]+>/g);
  if (bracketed && bracketed.length > 0) {
    return bracketed;
  }
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
