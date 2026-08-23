import { apiFetch, qs } from '../lib/http';
import { PlatformError } from '../lib/errors';
import { oauth1Header, type OAuth1Credentials } from '../lib/oauth1';
import { utcDate } from '../lib/time';
import type { MetricRow } from '../types';
import { credentialsFor, type Credentials } from './credentials';
import { captionFor } from './meta';
import {
  describedPublish,
  emptyMetric,
  type MediaRef,
  type OrganicAdapter,
  type PlatformContext,
  type VerifyResult,
} from './types';

/**
 * X (Twitter). Posting goes through API v2, media upload still needs the v1.1
 * endpoints with OAuth 1.0a user context.
 *
 * The credential secret for an X account is JSON:
 *   {"consumer_key":"","consumer_secret":"","access_token":"","token_secret":""}
 */
const API = 'https://api.x.com';
const UPLOAD = 'https://upload.x.com/1.1/media/upload.json';

function oauthCreds(creds: Credentials): OAuth1Credentials {
  const consumerKey = creds.clientId ?? creds.extra.consumer_key;
  const consumerSecret = creds.clientSecret ?? creds.extra.consumer_secret;
  const tokenSecret = creds.extra.token_secret ?? creds.extra.access_token_secret;
  if (!consumerKey || !consumerSecret || !tokenSecret) {
    throw new PlatformError('x', 'X credentials need consumer_key, consumer_secret and token_secret', 400);
  }
  return {
    consumerKey,
    consumerSecret,
    token: creds.accessToken,
    tokenSecret,
  };
}

export const xOrganic: OrganicAdapter = {
  channel: 'x',

  async verify(ctx, account): Promise<VerifyResult> {
    const creds = credentialsFor(ctx.env, account);
    const url = `${API}/2/users/me?${qs({ 'user.fields': 'username,public_metrics' })}`;
    const auth = await oauth1Header('GET', url, oauthCreds(creds));
    const data = await apiFetch<{ data?: { username?: string; id?: string } }>(url, {
      channel: 'x',
      headers: { authorization: auth },
    });
    return {
      ok: Boolean(data.data?.id),
      detail: data.data?.username ? `connected as @${data.data.username}` : 'no user returned',
    };
  },

  async publish(ctx, account, input) {
    const creds = credentialsFor(ctx.env, account);
    // 280 characters, and hashtags eat into that budget fast.
    const text = captionFor(input, { maxHashtags: 2 }).slice(0, 280);

    if (ctx.dryRun) {
      return describedPublish('x.publish', { text, media: input.media.map((m) => m.url) });
    }

    const mediaIds: string[] = [];
    for (const media of input.media.slice(0, 4)) {
      mediaIds.push(await uploadMedia(ctx, oauthCreds(creds), media));
    }

    const url = `${API}/2/tweets`;
    const body = JSON.stringify({
      text,
      ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}),
    });
    // v2 JSON bodies are not part of the OAuth 1.0a signature base string.
    const auth = await oauth1Header('POST', url, oauthCreds(creds));
    const res = await apiFetch<{ data?: { id?: string } }>(url, {
      channel: 'x',
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body,
    });
    const tweetId = res.data?.id;
    if (!tweetId) throw new PlatformError('x', 'tweet create returned no id', 502);
    return {
      externalId: tweetId,
      permalink: `https://x.com/${account.handle?.replace('@', '') ?? 'i'}/status/${tweetId}`,
      raw: res,
    };
  },

  async insights(ctx, account, opts): Promise<MetricRow[]> {
    const creds = credentialsFor(ctx.env, account);
    const ids = (opts.externalIds ?? []).filter((v) => !v.startsWith('dryrun:')).slice(0, 100);
    if (ids.length === 0) return [];

    const url = `${API}/2/tweets?${qs({
      ids: ids.join(','),
      'tweet.fields': 'public_metrics,non_public_metrics,created_at',
    })}`;
    const auth = await oauth1Header('GET', url, oauthCreds(creds));
    const data = await apiFetch<{ data?: XTweet[] }>(url, {
      channel: 'x',
      headers: { authorization: auth },
      tolerate: [403],
    });

    return (data.data ?? []).map((t) => {
      const metric = emptyMetric('post', t.id ?? '', 'x', utcDate(opts.until));
      const pm = t.public_metrics ?? {};
      const npm = t.non_public_metrics ?? {};
      metric.impressions = npm.impression_count ?? pm.impression_count ?? 0;
      metric.clicks = npm.url_link_clicks ?? 0;
      metric.engagements =
        (pm.like_count ?? 0) + (pm.reply_count ?? 0) + (pm.retweet_count ?? 0) + (pm.quote_count ?? 0);
      metric.raw = t;
      return metric;
    });
  },
};

/**
 * v1.1 chunked upload. Images could use the simple path, but going through
 * INIT/APPEND/FINALIZE for everything keeps one code path.
 */
async function uploadMedia(
  ctx: PlatformContext,
  creds: OAuth1Credentials,
  media: MediaRef,
): Promise<string> {
  const source = await fetch(media.url);
  if (!source.ok) {
    throw new PlatformError('x', `could not fetch media ${media.url}: ${source.status}`, 502);
  }
  const bytes = new Uint8Array(await source.arrayBuffer());
  const category = media.kind === 'video' ? 'tweet_video' : 'tweet_image';

  const initParams = {
    command: 'INIT',
    total_bytes: String(bytes.length),
    media_type: media.mimeType,
    media_category: category,
  };
  const initAuth = await oauth1Header('POST', UPLOAD, creds, initParams);
  const init = await apiFetch<{ media_id_string?: string }>(UPLOAD, {
    channel: 'x',
    method: 'POST',
    headers: { authorization: initAuth, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(initParams).toString(),
  });
  const mediaId = init.media_id_string;
  if (!mediaId) throw new PlatformError('x', 'media INIT returned no media_id', 502);

  const CHUNK = 4 * 1024 * 1024;
  for (let i = 0, segment = 0; i < bytes.length; i += CHUNK, segment++) {
    const chunk = bytes.slice(i, i + CHUNK);
    const appendParams = {
      command: 'APPEND',
      media_id: mediaId,
      segment_index: String(segment),
    };
    // multipart bodies are not signed, only the query parameters are.
    const appendUrl = `${UPLOAD}?${new URLSearchParams(appendParams).toString()}`;
    const appendAuth = await oauth1Header('POST', appendUrl, creds);
    const fd = new FormData();
    fd.set('media', new Blob([chunk], { type: media.mimeType }));
    await apiFetch(appendUrl, {
      channel: 'x',
      method: 'POST',
      headers: { authorization: appendAuth },
      body: fd,
      tolerate: [204],
    });
  }

  const finalizeParams = { command: 'FINALIZE', media_id: mediaId };
  const finalizeAuth = await oauth1Header('POST', UPLOAD, creds, finalizeParams);
  const finalized = await apiFetch<{ processing_info?: { state?: string; check_after_secs?: number } }>(
    UPLOAD,
    {
      channel: 'x',
      method: 'POST',
      headers: { authorization: finalizeAuth, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(finalizeParams).toString(),
    },
  );

  // Video needs transcoding before it can be attached to a post.
  let info = finalized.processing_info;
  for (let attempt = 0; info && info.state !== 'succeeded' && attempt < 10; attempt++) {
    if (info.state === 'failed') {
      throw new PlatformError('x', 'media processing failed', 502, { media_id: mediaId });
    }
    await new Promise((r) => setTimeout(r, (info?.check_after_secs ?? 3) * 1000));
    const statusUrl = `${UPLOAD}?${qs({ command: 'STATUS', media_id: mediaId })}`;
    const statusAuth = await oauth1Header('GET', statusUrl, creds);
    const status = await apiFetch<{ processing_info?: { state?: string; check_after_secs?: number } }>(
      statusUrl,
      { channel: 'x', headers: { authorization: statusAuth } },
    );
    info = status.processing_info;
  }

  ctx.log.debug('x media uploaded', { media_id: mediaId, bytes: bytes.length });
  return mediaId;
}


interface XTweet {
  id?: string;
  public_metrics?: {
    like_count?: number;
    reply_count?: number;
    retweet_count?: number;
    quote_count?: number;
    impression_count?: number;
  };
  non_public_metrics?: { impression_count?: number; url_link_clicks?: number };
}
