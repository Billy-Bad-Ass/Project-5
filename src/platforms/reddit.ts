import { apiFetch, qs } from '../lib/http';
import { PlatformError } from '../lib/errors';
import { utcDate } from '../lib/time';
import type { MetricRow } from '../types';
import { credentialsFor } from './credentials';
import { describedPublish, emptyMetric, type OrganicAdapter, type VerifyResult } from './types';

/**
 * Reddit. Posts go to a subreddit, so `destination` on the publish input is
 * required and the guardian treats a missing one as a hard failure rather than
 * guessing. Reddit communities remove promotional posts quickly, so the
 * strategist should only schedule these where BBA actually participates.
 */
const OAUTH = 'https://oauth.reddit.com';
const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const UA = 'web:bba-growth-os:v0.1.0 (by /u/bbanetwork)';

async function token(env: import('../env').Env, account: import('../types').Account): Promise<string> {
  const creds = credentialsFor(env, account);
  const cacheKey = `reddit_token:${account.secret_ref}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return cached;

  if (!creds.refreshToken || !creds.clientId || !creds.clientSecret) {
    return creds.accessToken;
  }
  // Reddit wants HTTP Basic with the app credentials, not client_id in the body.
  const basic = btoa(`${creds.clientId}:${creds.clientSecret}`);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
    }),
  });
  if (!res.ok) throw new PlatformError('reddit', `token refresh failed: ${res.status}`, res.status);
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new PlatformError('reddit', 'token refresh returned nothing', 502);
  await env.CACHE.put(cacheKey, data.access_token, {
    expirationTtl: Math.max(60, (data.expires_in ?? 3600) - 60),
  });
  return data.access_token;
}

function headers(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}`, 'user-agent': UA };
}

export const redditOrganic: OrganicAdapter = {
  channel: 'reddit',

  async verify(ctx, account): Promise<VerifyResult> {
    const accessToken = await token(ctx.env, account);
    const data = await apiFetch<{ name?: string }>(`${OAUTH}/api/v1/me`, {
      channel: 'reddit',
      headers: headers(accessToken),
    });
    return { ok: Boolean(data.name), detail: data.name ? `connected as u/${data.name}` : 'no user returned' };
  },

  async publish(ctx, account, input) {
    const subreddit = (input.destination ?? '').replace(/^r\//, '');
    const title = (input.title ?? input.hook ?? input.body.split('\n')[0] ?? '').slice(0, 300);

    if (ctx.dryRun) {
      return describedPublish('reddit.publish', { subreddit, title, body: input.body });
    }
    if (!subreddit) {
      throw new PlatformError('reddit', 'reddit posts need a target subreddit', 400);
    }

    const accessToken = await token(ctx.env, account);
    const form = new URLSearchParams({
      sr: subreddit,
      title,
      api_type: 'json',
      ...(input.linkUrl
        ? { kind: 'link', url: input.linkUrl }
        : { kind: 'self', text: input.body.slice(0, 40_000) }),
    });

    const res = await apiFetch<RedditSubmit>(`${OAUTH}/api/submit`, {
      channel: 'reddit',
      method: 'POST',
      headers: { ...headers(accessToken), 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const errors = res.json?.errors ?? [];
    if (errors.length) {
      throw new PlatformError('reddit', `submit rejected: ${JSON.stringify(errors)}`, 400);
    }
    const name = res.json?.data?.name;
    const url = res.json?.data?.url;
    if (!name) throw new PlatformError('reddit', 'submit returned no fullname', 502);
    return { externalId: name, permalink: url ?? undefined, raw: res };
  },

  async insights(ctx, account, opts): Promise<MetricRow[]> {
    const ids = (opts.externalIds ?? []).filter((v) => v.startsWith('t3_'));
    if (ids.length === 0) return [];
    const accessToken = await token(ctx.env, account);
    const data = await apiFetch<RedditListing>(
      `${OAUTH}/api/info?${qs({ id: ids.join(',') })}`,
      { channel: 'reddit', headers: headers(accessToken) },
    );
    return (data.data?.children ?? []).map((child) => {
      const post = child.data ?? {};
      const metric = emptyMetric('post', post.name ?? '', 'reddit', utcDate(opts.until));
      metric.impressions = post.view_count ?? 0;
      metric.engagements = (post.score ?? 0) + (post.num_comments ?? 0);
      metric.raw = post;
      return metric;
    });
  },
};

interface RedditSubmit {
  json?: { errors?: unknown[]; data?: { name?: string; url?: string } };
}

interface RedditListing {
  data?: {
    children?: {
      data?: { name?: string; score?: number; num_comments?: number; view_count?: number };
    }[];
  };
}
