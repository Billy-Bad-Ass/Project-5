import type { Env } from '../env';

/**
 * Bearer auth for the console and the admin API.
 *
 * One shared token, compared in constant time. This protects an interface that
 * can spend money, so it is deliberately not optional: with no ADMIN_TOKEN set
 * the admin surface refuses every request rather than running open.
 */
export function requireAdmin(request: Request, env: Env): Response | null {
  if (!env.ADMIN_TOKEN) {
    return json(
      {
        error: 'admin_token_not_set',
        message: 'Run: wrangler secret put ADMIN_TOKEN',
      },
      503,
    );
  }

  const presented = bearerFrom(request);
  if (!presented || !timingSafeEqual(presented, env.ADMIN_TOKEN)) {
    return json({ error: 'unauthorized' }, 401, {
      'www-authenticate': 'Bearer realm="bba-growth-os"',
    });
  }
  return null;
}

function bearerFrom(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  // The console stores the token in a cookie after the first successful call.
  const cookie = request.headers.get('cookie') ?? '';
  const match = cookie.match(/(?:^|;\s*)bba_admin=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function json(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
