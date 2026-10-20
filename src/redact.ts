const ASSIGNMENT =
  /((?:password|passwd|pass|pwd|token|secret|refresh_token|access_token|client_secret|authorization)\s*[:=]\s*["']?)([^\s"',}]+)/gi;

const BEARER = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;

const KEY_PATTERN = /pass(word|wd)?|token|secret|authorization|credential|cookie/i;

/**
 * Remove credential-shaped substrings from a log or error string.
 * Known secret values of any non-empty length are replaced. Shorter values are included
 * so a server that echoes a short password cannot leak it.
 */
export function redactText(value: string, secrets: readonly string[] = []): string {
  let out = value;
  const unique = [...new Set(secrets.filter((secret) => secret.length >= 1))].sort(
    (a, b) => b.length - a.length,
  );
  for (const secret of unique) {
    out = out.split(secret).join('[redacted]');
  }
  out = out.replace(BEARER, 'Bearer [redacted]');
  out = out.replace(ASSIGNMENT, '$1[redacted]');
  return out;
}

/**
 * Deep-copy a JSON-like value with secret object keys replaced and strings scrubbed.
 */
export function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    return redactText(value, secrets);
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (KEY_PATTERN.test(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = redactValue(inner, secrets);
      }
    }
    return out;
  }
  return redactText(String(value), secrets);
}
