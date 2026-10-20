import { MailError } from '../errors.js';
import type { AuthSettings } from '../config/schema.js';

export interface AccessToken {
  token: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

const cache = new Map<string, AccessToken>();
const inflight = new Map<string, Promise<string>>();

export interface OAuthRefreshInput {
  accountId: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scope?: string;
}

/**
 * Return a bearer token, refreshing it when the cached copy is within 60 seconds of expiry.
 * `fetchImpl` is injectable so tests never call a real token endpoint.
 */
export async function getAccessToken(
  auth: AuthSettings,
  accountId: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
  options?: { force?: boolean },
): Promise<string | undefined> {
  if (auth.type === 'password') {
    return undefined;
  }
  if (auth.type === 'xoauth2') {
    return auth.accessToken;
  }
  if (options?.force) {
    cache.delete(accountId);
  }
  const cached = cache.get(accountId);
  if (cached && cached.expiresAt - now() > 60_000) {
    return cached.token;
  }
  if (!options?.force && !cached && auth.accessToken) {
    cache.set(accountId, { token: auth.accessToken, expiresAt: now() + 3_600_000 });
    return auth.accessToken;
  }
  const pending = inflight.get(accountId);
  if (pending) {
    return pending;
  }
  const work = refreshAccessToken(
    {
      accountId,
      tokenUrl: auth.tokenUrl,
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      refreshToken: auth.refreshToken,
      ...(auth.scope ? { scope: auth.scope } : {}),
    },
    fetchImpl,
    now,
  ).then((refreshed) => {
    cache.set(accountId, refreshed);
    return refreshed.token;
  });
  inflight.set(accountId, work);
  try {
    return await work;
  } finally {
    inflight.delete(accountId);
  }
}

export async function refreshAccessToken(
  input: OAuthRefreshInput,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<AccessToken> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
    grant_type: 'refresh_token',
  });
  if (input.scope) {
    body.set('scope', input.scope);
  }
  let response: Response;
  try {
    response = await fetchImpl(input.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'network error';
    throw new MailError(
      'AUTH_FAILED',
      `OAuth token refresh for account "${input.accountId}" failed: ${message}`,
      'Check tokenUrl, client id, and that this host can reach the identity provider.',
    );
  }
  let payload: TokenResponse = {};
  try {
    payload = (await response.json()) as TokenResponse;
  } catch {
    payload = {};
  }
  if (!response.ok || !payload.access_token) {
    const reason = payload.error_description || payload.error || `HTTP ${response.status}`;
    throw new MailError(
      'AUTH_FAILED',
      `OAuth token refresh for account "${input.accountId}" was rejected (${reason}).`,
      'The refresh token may be expired or the client secret may be wrong. No token value is included in this error.',
    );
  }
  const expiresIn = payload.expires_in && payload.expires_in > 0 ? payload.expires_in : 3600;
  return { token: payload.access_token, expiresAt: now() + expiresIn * 1000 };
}

export function clearTokenCache(): void {
  cache.clear();
}
