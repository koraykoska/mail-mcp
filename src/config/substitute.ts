import { MailError } from '../errors.js';

const PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$\$\{/g;

/**
 * Replace `${VAR}` and `${VAR:-default}` from the environment.
 * `$${` is an escape that becomes `${`.
 * A missing variable without a default is a configuration error.
 */
export function substituteEnv(value: string, env: NodeJS.ProcessEnv, source: string): string {
  return value.replace(PATTERN, (match, name: string | undefined, fallback: string | undefined) => {
    if (match === '$${') {
      return '${';
    }
    if (!name) {
      return match;
    }
    const found = env[name];
    if (found !== undefined && found !== '') {
      return found;
    }
    if (fallback !== undefined) {
      return fallback;
    }
    throw new MailError(
      'CONFIG_ERROR',
      `Environment variable ${name} referenced by ${source} is not set.`,
      `Export ${name} or provide a default with \${${name}:-value}.`,
    );
  });
}

export function substituteDeep(value: unknown, env: NodeJS.ProcessEnv, source: string): unknown {
  if (typeof value === 'string') {
    return substituteEnv(value, env, source);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => substituteDeep(item, env, `${source}[${index}]`));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = substituteDeep(inner, env, `${source}.${key}`);
    }
    return out;
  }
  return value;
}
