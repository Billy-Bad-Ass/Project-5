import { apiFetch, qs } from '../lib/http';
import { PlatformError } from '../lib/errors';
import { utcDate } from '../lib/time';
import type { MetricRow } from '../types';
import { credentialsFor, refreshedAccessToken } from './credentials';
import { captionFor } from './meta';
import {
  described,
  describedPublish,
  emptyMetric,
  type AdsAdapter,
  type OrganicAdapter,
  type VerifyResult,
} from './types';

/**
 * YouTube (organic Shorts and long form) and Google Ads.
 *
 * Both sit behind Google OAuth with a refresh token, so the token exchange is
 * shared. Google Ads additionally needs a developer token and, for a manager
 * account, a login-customer-id header.
 */
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const YT = 'https://www.googleapis.com/youtube/v3';
const YT_UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const ADS = 'https://googleads.googleapis.com/v19';

export const youtubeOrganic: OrganicAdapter = {
  channel: 'youtube',

  async verify(ctx, account): Promise<VerifyResult> {
    const token = await googleToken(ctx.env, account.secret_ref, credentialsFor(ctx.env, account));
    const data = await apiFetch<{ items?: { snippet?: { title?: string } }[] }>(
      `${YT}/channels?${qs({ part: 'snippet', mine: 'true' })}`,
      { channel: 'youtube', headers: { authorization: `Bearer ${token}` } },
    );
    const title = data.items?.[0]?.snippet?.title;
    return { ok: Boolean(title), detail: title ? `channel: ${title}` : 'no channel returned' };
  },

  async publish(ctx, account, input) {
    const creds = credentialsFor(ctx.env, account);
    const video = input.media.find((m) => m.kind === 'video');
    const title = (input.hook ?? input.body).slice(0, 100);
    const description = captionFor(input, { maxHashtags: 15 }).slice(0, 5000);

    if (ctx.dryRun) {
      return describedPublish('youtube.publish', { title, description, video: video?.url });
    }
    if (!video) throw new PlatformError('youtube', 'YouTube needs a video', 400);

    const token = await googleToken(ctx.env, account.secret_ref, creds);
    const metadata = {
      snippet: {
        title,
        description,
        tags: (input.hashtags ?? []).map((t) => t.replace('#', '')).slice(0, 15),
        categoryId: '22',
      },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    };

    // Resumable upload: ask for a session URL, then PUT the bytes to it.
    const initRes = await fetch(
      `${YT_UPLOAD}?${qs({ uploadType: 'resumable', part: 'snippet,status' })}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-upload-content-type': video.mimeType,
        },
        body: JSON.stringify(metadata),
      },
    );
    const sessionUrl = initRes.headers.get('location');
    if (!initRes.ok || !sessionUrl) {
      throw new PlatformError('youtube', `resumable init failed: ${initRes.status}`, initRes.status);
    }

    const source = await fetch(video.url);
    if (!source.ok) {
      throw new PlatformError('youtube', `could not fetch ${video.url}: ${source.status}`, 502);
    }
    const uploaded = await apiFetch<{ id?: string }>(sessionUrl, {
      channel: 'youtube',
      method: 'PUT',
      headers: { 'content-type': video.mimeType },
      body: await source.arrayBuffer(),
      timeoutMs: 120_000,
      attempts: 1,
    });
    if (!uploaded.id) throw new PlatformError('youtube', 'upload returned no video id', 502);
    return {
      externalId: uploaded.id,
      permalink: `https://www.youtube.com/watch?v=${uploaded.id}`,
      raw: uploaded,
    };
  },

  async insights(ctx, account, opts): Promise<MetricRow[]> {
    const token = await googleToken(ctx.env, account.secret_ref, credentialsFor(ctx.env, account));
    const ids = (opts.externalIds ?? []).filter((v) => !v.startsWith('dryrun:')).slice(0, 50);
    if (ids.length === 0) return [];

    const data = await apiFetch<{ items?: YouTubeVideo[] }>(
      `${YT}/videos?${qs({ part: 'statistics', id: ids.join(',') })}`,
      { channel: 'youtube', headers: { authorization: `Bearer ${token}` } },
    );
    return (data.items ?? []).map((v) => {
      const metric = emptyMetric('post', v.id ?? '', 'youtube', utcDate(opts.until));
      const s = v.statistics ?? {};
      metric.impressions = Number(s.viewCount ?? 0);
      metric.video_views = Number(s.viewCount ?? 0);
      metric.engagements = Number(s.likeCount ?? 0) + Number(s.commentCount ?? 0);
      metric.raw = v;
      return metric;
    });
  },
};

// ---------------------------------------------------------------------------
// Google Ads
// ---------------------------------------------------------------------------

export const googleAds: AdsAdapter = {
  channel: 'google',

  async verify(ctx, account): Promise<VerifyResult> {
    const { token, headers } = await adsAuth(ctx.env, account);
    const data = await apiFetch<{ results?: { customer?: { descriptiveName?: string } }[] }>(
      `${ADS}/customers/${customerId(account)}/googleAds:search`,
      {
        channel: 'google',
        method: 'POST',
        headers: { ...headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          query: 'SELECT customer.descriptive_name, customer.currency_code FROM customer LIMIT 1',
        }),
      },
    );
    const name = data.results?.[0]?.customer?.descriptiveName;
    return { ok: Boolean(name), detail: name ? `customer: ${name}` : 'customer query returned nothing' };
  },

  async createCampaign(ctx, account, spec) {
    // Google Ads wants micros of the account currency.
    const micros = spec.dailyBudgetCents * 10_000;
    if (ctx.dryRun) {
      return {
        campaign: described('google.createCampaign', { ...spec, budget_micros: micros }),
        adSet: described('google.createAdGroup', { budget_micros: micros }),
      };
    }
    const { token, headers } = await adsAuth(ctx.env, account);
    const cid = customerId(account);
    const auth = { ...headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const budget = await apiFetch<MutateResponse>(`${ADS}/customers/${cid}/campaignBudgets:mutate`, {
      channel: 'google',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        operations: [
          {
            create: {
              name: `${spec.name} budget ${Date.now()}`,
              amountMicros: String(micros),
              deliveryMethod: 'STANDARD',
              explicitlyShared: false,
            },
          },
        ],
      }),
    });
    const budgetResource = budget.results?.[0]?.resourceName;
    if (!budgetResource) throw new PlatformError('google', 'budget create returned no resource', 502);

    const campaign = await apiFetch<MutateResponse>(`${ADS}/customers/${cid}/campaigns:mutate`, {
      channel: 'google',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        operations: [
          {
            create: {
              name: spec.name,
              // Paused on creation. Activation is a separate, approved decision.
              status: 'PAUSED',
              advertisingChannelType: 'SEARCH',
              campaignBudget: budgetResource,
              maximizeConversions: {},
              startDate: gDate(spec.startsAt),
              ...(spec.endsAt ? { endDate: gDate(spec.endsAt) } : {}),
            },
          },
        ],
      }),
    });
    const campaignResource = campaign.results?.[0]?.resourceName;
    if (!campaignResource) throw new PlatformError('google', 'campaign create returned no resource', 502);

    const adGroup = await apiFetch<MutateResponse>(`${ADS}/customers/${cid}/adGroups:mutate`, {
      channel: 'google',
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        operations: [
          {
            create: {
              name: `${spec.name} / ad group`,
              campaign: campaignResource,
              status: 'PAUSED',
              type: 'SEARCH_STANDARD',
            },
          },
        ],
      }),
    });
    const adGroupResource = adGroup.results?.[0]?.resourceName;
    if (!adGroupResource) throw new PlatformError('google', 'ad group create returned no resource', 502);

    return {
      campaign: { externalId: campaignResource, raw: campaign },
      adSet: { externalId: adGroupResource, raw: adGroup },
    };
  },

  async createAd(ctx, account, adSetExternalId, spec) {
    if (ctx.dryRun) return described('google.createAd', { adSetExternalId, ...spec });
    const { token, headers } = await adsAuth(ctx.env, account);
    const cid = customerId(account);

    // A responsive search ad needs at least 3 headlines and 2 descriptions.
    const headlines = splitForRsa(spec.headline ?? spec.body, 30, 3);
    const descriptions = splitForRsa(spec.body, 90, 2);

    const res = await apiFetch<MutateResponse>(`${ADS}/customers/${cid}/adGroupAds:mutate`, {
      channel: 'google',
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        operations: [
          {
            create: {
              adGroup: adSetExternalId,
              status: 'PAUSED',
              ad: {
                finalUrls: [spec.landingUrl],
                responsiveSearchAd: {
                  headlines: headlines.map((text) => ({ text })),
                  descriptions: descriptions.map((text) => ({ text })),
                },
              },
            },
          },
        ],
      }),
    });
    const resource = res.results?.[0]?.resourceName;
    if (!resource) throw new PlatformError('google', 'ad create returned no resource', 502);
    return { externalId: resource, raw: res };
  },

  async setBudget(ctx, account, adSetExternalId, dailyBudgetCents) {
    if (ctx.dryRun) return described('google.setBudget', { adSetExternalId, dailyBudgetCents });
    const { token, headers } = await adsAuth(ctx.env, account);
    const cid = customerId(account);
    // adSetExternalId is an ad group resource; find its campaign's budget.
    const found = await apiFetch<{ results?: { campaign?: { campaignBudget?: string } }[] }>(
      `${ADS}/customers/${cid}/googleAds:search`,
      {
        channel: 'google',
        method: 'POST',
        headers: { ...headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `SELECT campaign.campaign_budget FROM ad_group WHERE ad_group.resource_name = '${adSetExternalId}'`,
        }),
      },
    );
    const budgetResource = found.results?.[0]?.campaign?.campaignBudget;
    if (!budgetResource) throw new PlatformError('google', 'could not resolve campaign budget', 404);

    await apiFetch(`${ADS}/customers/${cid}/campaignBudgets:mutate`, {
      channel: 'google',
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        operations: [
          {
            update: { resourceName: budgetResource, amountMicros: String(dailyBudgetCents * 10_000) },
            updateMask: 'amount_micros',
          },
        ],
      }),
    });
    return { externalId: adSetExternalId };
  },

  async setStatus(ctx, account, externalId, status, level) {
    if (ctx.dryRun) return described('google.setStatus', { externalId, status, level });
    const { token, headers } = await adsAuth(ctx.env, account);
    const cid = customerId(account);
    const endpoint =
      level === 'campaign' ? 'campaigns' : level === 'adset' ? 'adGroups' : 'adGroupAds';
    await apiFetch(`${ADS}/customers/${cid}/${endpoint}:mutate`, {
      channel: 'google',
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        operations: [
          {
            update: { resourceName: externalId, status: status === 'active' ? 'ENABLED' : 'PAUSED' },
            updateMask: 'status',
          },
        ],
      }),
    });
    return { externalId };
  },

  async report(ctx, account, opts): Promise<MetricRow[]> {
    const { token, headers } = await adsAuth(ctx.env, account);
    const cid = customerId(account);
    const query = `
      SELECT ad_group.resource_name, segments.date, metrics.impressions, metrics.clicks,
             metrics.cost_micros, metrics.conversions, metrics.conversions_value
      FROM ad_group
      WHERE segments.date BETWEEN '${opts.since}' AND '${opts.until}'`;
    const data = await apiFetch<{ results?: GoogleAdsRow[] }>(
      `${ADS}/customers/${cid}/googleAds:search`,
      {
        channel: 'google',
        method: 'POST',
        headers: { ...headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, pageSize: 1000 }),
      },
    );
    return (data.results ?? []).map((row) => {
      const metric = emptyMetric(
        'campaign_channel',
        row.adGroup?.resourceName ?? account.external_id,
        'google',
        row.segments?.date ?? opts.until,
      );
      const m = row.metrics ?? {};
      metric.impressions = Number(m.impressions ?? 0);
      metric.clicks = Number(m.clicks ?? 0);
      metric.spend_cents = Math.round(Number(m.costMicros ?? 0) / 10_000);
      metric.conversions = Math.round(Number(m.conversions ?? 0));
      metric.revenue_cents = Math.round(Number(m.conversionsValue ?? 0) * 100);
      metric.currency = account.currency;
      metric.raw = row;
      return metric;
    });
  },
};

async function googleToken(
  env: import('../env').Env,
  cacheKey: string,
  creds: import('./credentials').Credentials,
): Promise<string> {
  return refreshedAccessToken(env, `google_token:${cacheKey}`, GOOGLE_TOKEN_URL, creds);
}

async function adsAuth(
  env: import('../env').Env,
  account: import('../types').Account,
): Promise<{ token: string; headers: Record<string, string> }> {
  const creds = credentialsFor(env, account);
  const developerToken = creds.developerToken ?? creds.extra.developer_token;
  if (!developerToken) {
    throw new PlatformError('google', 'Google Ads credentials need a developer_token', 400);
  }
  const token = await googleToken(env, account.secret_ref, creds);
  const headers: Record<string, string> = { 'developer-token': developerToken };
  const loginCustomerId = creds.extra.login_customer_id;
  if (loginCustomerId) headers['login-customer-id'] = loginCustomerId.replace(/-/g, '');
  return { token, headers };
}

function customerId(account: import('../types').Account): string {
  return account.external_id.replace(/-/g, '');
}

function gDate(iso: string | null | undefined): string {
  return (iso ? utcDate(iso) : utcDate()).replace(/-/g, '');
}

/** Split copy into RSA-sized assets, padding to the platform minimum. */
function splitForRsa(text: string, maxLen: number, minCount: number): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const s of sentences) {
    if (s.length <= maxLen) out.push(s);
    else out.push(s.slice(0, maxLen - 1).trimEnd());
    if (out.length >= 8) break;
  }
  while (out.length < minCount && out.length > 0) {
    out.push(out[out.length - 1]!.slice(0, maxLen));
  }
  return out.length ? out : [text.slice(0, maxLen)];
}

interface MutateResponse {
  results?: { resourceName?: string }[];
}

interface GoogleAdsRow {
  adGroup?: { resourceName?: string };
  segments?: { date?: string };
  metrics?: {
    impressions?: string;
    clicks?: string;
    costMicros?: string;
    conversions?: number;
    conversionsValue?: number;
  };
}

interface YouTubeVideo {
  id?: string;
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}
