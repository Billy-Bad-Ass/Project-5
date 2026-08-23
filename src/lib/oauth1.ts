/**
 * OAuth 1.0a request signing (HMAC-SHA1).
 *
 * X still requires OAuth 1.0a user context for the v1.1 media upload endpoints,
 * so this exists even though the v2 posting endpoints accept OAuth 2.0.
 */

export interface OAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

export async function oauth1Header(
  method: string,
  url: string,
  creds: OAuth1Credentials,
  /** Only form-encoded body params take part in the signature. */
  bodyParams: Record<string, string> = {},
): Promise<string> {
  const parsed = new URL(url);
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.token,
    oauth_version: '1.0',
  };

  const allParams: Record<string, string> = { ...oauthParams, ...bodyParams };
  for (const [k, v] of parsed.searchParams.entries()) allParams[k] = v;

  const paramString = Object.keys(allParams)
    .map((k) => [percentEncode(k), percentEncode(allParams[k] ?? '')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const baseUrl = `${parsed.origin}${parsed.pathname}`;
  const signatureBase = [
    method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(paramString),
  ].join('&');

  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.tokenSecret)}`;
  const signature = await hmacSha1Base64(signingKey, signatureBase);

  const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  return `OAuth ${Object.keys(headerParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k] ?? '')}"`)
    .join(', ')}`;
}

/** RFC 3986. encodeURIComponent leaves !*'() alone, OAuth does not. */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function hmacSha1Base64(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return base64(new Uint8Array(sig));
}

export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
