import type { Env } from '../env';
import { ConfigError } from '../lib/errors';
import type { Account } from '../types';

/**
 * Credentials live in Worker secrets, never in D1. An account row stores only
 * `secret_ref`, the name of the secret holding its token.
 *
 * A secret may be a bare token or a JSON object, which lets one account carry
 * an access token plus a refresh token and a client id.
 */
export interface Credentials {
  accessToken: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  developerToken?: string;
  extra: Record<string, string>;
}

export function readSecret(env: Env, name: string): string | undefined {
  const value = env[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function credentialsFor(env: Env, account: Account): Credentials {
  const raw = readSecret(env, account.secret_ref);
  if (!raw) {
    throw new ConfigError(
      `Missing secret ${account.secret_ref} for ${account.channel}/${account.surface}. Run: wrangler secret put ${account.secret_ref}`,
      { channel: account.channel, secret_ref: account.secret_ref },
    );
  }
  return parseCredentials(raw);
}

export function parseCredentials(raw: string): Credentials {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) {
    return { accessToken: trimmed, extra: {} };
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { accessToken: trimmed, extra: {} };
  }
  const str = (k: string): string | undefined =>
    typeof obj[k] === 'string' && (obj[k] as string).length > 0 ? (obj[k] as string) : undefined;

  const accessToken = str('access_token') ?? str('accessToken') ?? str('token');
  if (!accessToken) {
    throw new ConfigError('Credential JSON has no access_token field');
  }
  const known = new Set([
    'access_token',
    'accessToken',
    'token',
    'refresh_token',
    'refreshToken',
    'client_id',
    'clientId',
    'client_secret',
    'clientSecret',
    'developer_token',
    'developerToken',
  ]);
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!known.has(k) && typeof v === 'string') extra[k] = v;
  }
  const creds: Credentials = { accessToken, extra };
  const refreshToken = str('refresh_token') ?? str('refreshToken');
  const clientId = str('client_id') ?? str('clientId');
  const clientSecret = str('client_secret') ?? str('clientSecret');
  const developerToken = str('developer_token') ?? str('developerToken');
  if (refreshToken) creds.refreshToken = refreshToken;
  if (clientId) creds.clientId = clientId;
  if (clientSecret) creds.clientSecret = clientSecret;
  if (developerToken) creds.developerToken = developerToken;
  return creds;
}

/**
 * OAuth2 refresh-token exchange, cached in KV until shortly before expiry.
 * Google, Reddit and Snapchat all use short-lived access tokens.
 */
export async function refreshedAccessToken(
  env: Env,
  cacheKey: string,
  tokenUrl: string,
  creds: Credentials,
  extraParams: Record<string, string> = {},
): Promise<string> {
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return cached;

  if (!creds.refreshToken || !creds.clientId || !creds.clientSecret) {
    // No refresh material: the stored access token is all we have.
    return creds.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    ...extraParams,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new ConfigError(`Token refresh failed for ${cacheKey}: ${res.status}`, {
      status: res.status,
    });
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new ConfigError(`Token refresh for ${cacheKey} returned no access_token`);
  }
  // Expire the cache a minute early so a request never races the expiry.
  const ttl = Math.max(60, (data.expires_in ?? 3600) - 60);
  await env.CACHE.put(cacheKey, data.access_token, { expirationTtl: ttl });
  return data.access_token;
}
