function shrink(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    if (value.length > 500 && /^[A-Za-z0-9+/=\s]+$/.test(value)) {
      return `<base64 ${value.length} characters>`;
    }
    if (value.length > 4000) {
      return `${value.slice(0, 4000)}…`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => shrink(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'contentBase64' && typeof inner === 'string') {
        out[key] = `<base64 ${inner.length} characters>`;
      } else {
        out[key] = shrink(inner, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/** Human-readable tool text. Structured content still carries full base64 payloads. */
export function renderToolText(data: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof data.account === 'string') {
    lines.push(`Account: ${data.account}`);
  }
  if (typeof data.mailbox === 'string') {
    lines.push(`Mailbox: ${data.mailbox}`);
  }
  if (typeof data.total === 'number') {
    lines.push(`Total: ${data.total}`);
  }
  if (data.ok === false) {
    lines.push('Result: failed');
  }
  lines.push(JSON.stringify(shrink(data), null, 2));
  return lines.join('\n');
}
