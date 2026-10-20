/**
 * Stable error codes returned to MCP clients.
 * Messages never include passwords, tokens, or raw server credentials.
 */
export const MAIL_ERROR_CODES = [
  'AUTH_FAILED',
  'TLS_FAILED',
  'NOT_FOUND',
  'UIDVALIDITY_CHANGED',
  'CAPABILITY_UNSUPPORTED',
  'PERMISSION_DENIED',
  'SIZE_LIMIT',
  'TIMEOUT',
  'RATE_LIMITED',
  'CONFIG_ERROR',
  'PROTOCOL_ERROR',
  'CONNECTION_FAILED',
  'INVALID_ARGUMENT',
] as const;

export type MailErrorCode = (typeof MAIL_ERROR_CODES)[number];

/**
 * Operational failure with a stable code, a safe message, and an optional next step.
 */
export class MailError extends Error {
  readonly code: MailErrorCode;
  readonly hint?: string;

  constructor(code: MailErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'MailError';
    this.code = code;
    if (hint !== undefined) {
      this.hint = hint;
    }
  }
}

export function isMailError(error: unknown): error is MailError {
  return error instanceof MailError;
}

interface ErrorLike {
  code?: unknown;
  message?: unknown;
  name?: unknown;
  authenticationFailed?: unknown;
  response?: unknown;
}

function asErrorLike(error: unknown): ErrorLike {
  if (typeof error === 'object' && error !== null) {
    return error as ErrorLike;
  }
  return { message: String(error) };
}

function textOf(error: ErrorLike): string {
  const parts: string[] = [];
  if (typeof error.message === 'string') {
    parts.push(error.message);
  }
  if (typeof error.response === 'string') {
    parts.push(error.response);
  }
  if (typeof error.code === 'string') {
    parts.push(error.code);
  }
  return parts.join(' ');
}

/**
 * Map a library or network error onto a {@link MailError}.
 * Connection-reset style failures are retryable by the pool; auth and TLS are not.
 */
export function mapTransportError(error: unknown): MailError {
  if (error instanceof MailError) {
    return error;
  }
  const like = asErrorLike(error);
  const code = typeof like.code === 'string' ? like.code : '';
  const name = typeof like.name === 'string' ? like.name : '';
  const text = textOf(like);
  const lower = text.toLowerCase();

  if (
    like.authenticationFailed === true ||
    name === 'AuthenticationFailure' ||
    code === 'AUTHENTICATIONFAILED' ||
    /authentication failed|invalid credentials|login failed|auth(entication)?\s+fail|invalid login|bad credentials|535 |534 /.test(
      lower,
    )
  ) {
    return new MailError(
      'AUTH_FAILED',
      'Authentication failed. Check the username, password, or OAuth token for this account.',
      'Gmail and Microsoft 365 usually require an app password or OAuth2, not the account password.',
    );
  }

  if (
    /certificate|self-signed|unable to verify|altname|err_tls|ssl routines|hostname\/ip does not match|tls/.test(
      lower,
    ) ||
    code.startsWith('ERR_TLS') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED'
  ) {
    return new MailError(
      'TLS_FAILED',
      'TLS handshake failed. The server certificate was rejected.',
      'Pin the CA with tls.caFile, or set tls.rejectUnauthorized to false only on a trusted network.',
    );
  }

  if (
    /timeout|timed out|etimedout|esockettimedout/.test(lower) ||
    code === 'ETIMEDOUT' ||
    code === 'CONNECT_TIMEOUT'
  ) {
    return new MailError(
      'TIMEOUT',
      'The mail server did not respond in time.',
      'Increase imap.timeoutMs or smtp.timeoutMs, and confirm the host and port are reachable.',
    );
  }

  if (/uidvalidity/.test(lower) || code === 'UIDVALIDITYCHANGED') {
    return new MailError(
      'UIDVALIDITY_CHANGED',
      'The mailbox UIDVALIDITY changed, so previously seen UIDs are no longer valid.',
      'List or search the mailbox again and retry with the new uidValidity.',
    );
  }

  if (
    /no such|not found|doesn't exist|does not exist|nonexistent|mailbox missing|unknown mailbox/.test(
      lower,
    )
  ) {
    return new MailError(
      'NOT_FOUND',
      'The mailbox, message, or attachment was not found.',
      'List mailboxes or search again. UIDs change when UIDVALIDITY changes.',
    );
  }

  if (
    /not supported|missing server extension|capability|unknown command|unrecognized/.test(lower) ||
    code === 'MissingServerExtension'
  ) {
    return new MailError(
      'CAPABILITY_UNSUPPORTED',
      'The server does not advertise the IMAP or SMTP extension required for this operation.',
      'Call mail_get_capabilities and use the documented fallback where one exists.',
    );
  }

  if (
    /econnrefused|econnreset|ehostunreach|enetunreach|epipe|socket hang up|connection closed|not connected|econnectionclosed/.test(
      lower,
    ) ||
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EPIPE',
      'ECONNECTIONCLOSED',
    ].includes(code)
  ) {
    return new MailError(
      'CONNECTION_FAILED',
      'The connection to the mail server failed or was closed.',
      'Check host, port, firewall, and whether the server expects implicit TLS or STARTTLS.',
    );
  }

  const safe = text.replace(/\s+/g, ' ').trim().slice(0, 400);
  return new MailError(
    'PROTOCOL_ERROR',
    safe ? `The mail server returned an error: ${safe}` : 'The mail server returned an error.',
  );
}

/** True when the pool should drop the session and try a fresh connection once. */
export function isRetryableConnectionError(error: unknown): boolean {
  const mapped = error instanceof MailError ? error : mapTransportError(error);
  return mapped.code === 'CONNECTION_FAILED' || mapped.code === 'TIMEOUT';
}
