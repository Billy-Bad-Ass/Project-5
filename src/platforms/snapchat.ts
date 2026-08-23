import { apiFetch, qs } from '../lib/http';
import { PlatformError } from '../lib/errors';
import type { MetricRow } from '../types';
import { credentialsFor, refreshedAccessToken } from './credentials';
import {
  described,
  emptyMetric,
  type AdsAdapter,
  type VerifyResult,
} from './types';

/** Snapchat Marketing API. developers.snap.com/api/marketing-api */
const API = 'https://adsapi.snapchat.com/v1';
const TOKEN_URL = 'https://accounts.snapchat.com/login/oauth2/access_token';

async function token(env: import('../env').Env, account: import('../types').Account): Promise<string> {
  const creds = credentialsFor(env, account);
  return refreshedAccessToken(env, `snap_token:${account.secret_ref}`, TOKEN_URL, creds);
}

function headers(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
}

const SNAP_OBJECTIVE: Record<string, string> = {
  conversions: 'WEB_CONVERSION',
  traffic: 'WEB_VIEW',
  awareness: 'BRAND_AWARENESS',
  leads: 'LEAD_GENERATION',
  app_installs: 'APP_INSTALL',
};

export const snapchatAds: AdsAdapter = {
  channel: 'snapchat',

  async verify(ctx, account): Promise<VerifyResult> {
    const accessToken = await token(ctx.env, account);
    const data = await apiFetch<SnapEnvelope<'adaccounts', { name?: string; id?: string }>>(
      `${API}/adaccounts/${account.external_id}`,
      { channel: 'snapchat', headers: headers(accessToken) },
    );
    const record = data.adaccounts?.[0]?.adaccount;
    return { ok: Boolean(record?.id), detail: record?.name ? `ad account ${record.name}` : 'not found' };
  },

  async createCampaign(ctx, account, spec) {
    const objective = SNAP_OBJECTIVE[spec.objective] ?? 'WEB_VIEW';
    if (ctx.dryRun) {
      return {
        campaign: described('snapchat.createCampaign', { ...spec, objective }),
        adSet: described('snapchat.createAdSquad', { dailyBudgetCents: spec.dailyBudgetCents }),
      };
    }
    const accessToken = await token(ctx.env, account);

    const campaigns = await apiFetch<SnapEnvelope<'campaigns', { id?: string }>>(
      `${API}/adaccounts/${account.external_id}/campaigns`,
      {
        channel: 'snapchat',
        method: 'POST',
        headers: headers(accessToken),
        body: JSON.stringify({
          campaigns: [
            {
              name: spec.name,
              ad_account_id: account.external_id,
              status: 'PAUSED',
              objective,
              start_time: spec.startsAt ?? new Date().toISOString(),
              ...(spec.endsAt ? { end_time: spec.endsAt } : {}),
            },
          ],
        }),
      },
    );
    const campaignId = campaigns.campaigns?.[0]?.campaign?.id;
    if (!campaignId) throw new PlatformError('snapchat', 'campaign create returned no id', 502);

    const squads = await apiFetch<SnapEnvelope<'adsquads', { id?: string }>>(
      `${API}/campaigns/${campaignId}/adsquads`,
      {
        channel: 'snapchat',
        method: 'POST',
        headers: headers(accessToken),
        body: JSON.stringify({
          adsquads: [
            {
              campaign_id: campaignId,
              name: `${spec.name} / ad squad`,
              type: 'SNAP_ADS',
              status: 'PAUSED',
              // Snapchat budgets are micro-currency.
              daily_budget_micro: spec.dailyBudgetCents * 10_000,
              bid_strategy: 'AUTO_BID',
              billing_event: 'IMPRESSION',
              optimization_goal: objective === 'WEB_CONVERSION' ? 'PIXEL_PURCHASE' : 'SWIPES',
              placement_v2: { config: 'AUTOMATIC' },
              targeting: spec.targeting ?? { geos: [{ country_code: 'us' }] },
            },
          ],
        }),
      },
    );
    const squadId = squads.adsquads?.[0]?.adsquad?.id;
    if (!squadId) throw new PlatformError('snapchat', 'ad squad create returned no id', 502);

    return {
      campaign: { externalId: campaignId, raw: campaigns },
      adSet: { externalId: squadId, raw: squads },
    };
  },

  async createAd(ctx, account, adSetExternalId, spec) {
    if (ctx.dryRun) return described('snapchat.createAd', { adSetExternalId, ...spec });
    if (!spec.sourcePostId) {
      throw new PlatformError(
        'snapchat',
        'Snapchat ads reference a creative id: upload the creative first and pass it as sourcePostId',
        400,
      );
    }
    const accessToken = await token(ctx.env, account);
    const res = await apiFetch<SnapEnvelope<'ads', { id?: string }>>(
      `${API}/adsquads/${adSetExternalId}/ads`,
      {
        channel: 'snapchat',
        method: 'POST',
        headers: headers(accessToken),
        body: JSON.stringify({
          ads: [
            {
              ad_squad_id: adSetExternalId,
              creative_id: spec.sourcePostId,
              name: (spec.headline ?? 'BBA ad').slice(0, 175),
              type: 'SNAP_AD',
              status: 'PAUSED',
            },
          ],
        }),
      },
    );
    const adId = res.ads?.[0]?.ad?.id;
    if (!adId) throw new PlatformError('snapchat', 'ad create returned no id', 502);
    return { externalId: adId, raw: res };
  },

  async setBudget(ctx, account, adSetExternalId, dailyBudgetCents) {
    if (ctx.dryRun) return described('snapchat.setBudget', { adSetExternalId, dailyBudgetCents });
    const accessToken = await token(ctx.env, account);
    await apiFetch(`${API}/adsquads`, {
      channel: 'snapchat',
      method: 'PUT',
      headers: headers(accessToken),
      body: JSON.stringify({
        adsquads: [{ id: adSetExternalId, daily_budget_micro: dailyBudgetCents * 10_000 }],
      }),
    });
    return { externalId: adSetExternalId };
  },

  async setStatus(ctx, account, externalId, status, level) {
    if (ctx.dryRun) return described('snapchat.setStatus', { externalId, status, level });
    const accessToken = await token(ctx.env, account);
    const collection = level === 'campaign' ? 'campaigns' : level === 'adset' ? 'adsquads' : 'ads';
    await apiFetch(`${API}/${collection}`, {
      channel: 'snapchat',
      method: 'PUT',
      headers: headers(accessToken),
      body: JSON.stringify({
        [collection]: [{ id: externalId, status: status === 'active' ? 'ACTIVE' : 'PAUSED' }],
      }),
    });
    return { externalId };
  },

  async report(ctx, account, opts): Promise<MetricRow[]> {
    const accessToken = await token(ctx.env, account);
    const out: MetricRow[] = [];
    for (const squadId of opts.externalIds ?? []) {
      const data = await apiFetch<SnapStatsEnvelope>(
        `${API}/adsquads/${squadId}/stats?${qs({
          granularity: 'DAY',
          start_time: `${opts.since}T00:00:00.000-00:00`,
          end_time: `${opts.until}T00:00:00.000-00:00`,
          fields: 'impressions,swipes,spend,conversion_purchases,conversion_purchases_value',
        })}`,
        { channel: 'snapchat', headers: headers(accessToken), tolerate: [400] },
      );
      for (const bucket of data.timeseries_stats ?? []) {
        for (const point of bucket.timeseries_stat?.timeseries ?? []) {
          const metric = emptyMetric(
            'campaign_channel',
            squadId,
            'snapchat',
            (point.start_time ?? opts.until).slice(0, 10),
          );
          const s = point.stats ?? {};
          metric.impressions = Number(s.impressions ?? 0);
          metric.clicks = Number(s.swipes ?? 0);
          metric.spend_cents = Math.round(Number(s.spend ?? 0) / 10_000);
          metric.conversions = Number(s.conversion_purchases ?? 0);
          metric.revenue_cents = Math.round(Number(s.conversion_purchases_value ?? 0) / 10_000);
          metric.currency = account.currency;
          metric.raw = point;
          out.push(metric);
        }
      }
    }
    return out;
  },
};

type SnapEnvelope<K extends string, T> = {
  [P in K]?: ({ [Q in Singular<K>]?: T } & { sub_request_status?: string })[];
};

type Singular<K extends string> = K extends 'adaccounts'
  ? 'adaccount'
  : K extends 'campaigns'
    ? 'campaign'
    : K extends 'adsquads'
      ? 'adsquad'
      : K extends 'ads'
        ? 'ad'
        : never;

interface SnapStatsEnvelope {
  timeseries_stats?: {
    timeseries_stat?: {
      timeseries?: { start_time?: string; stats?: Record<string, number> }[];
    };
  }[];
}
