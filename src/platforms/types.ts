import type { Env } from '../env';
import type { Logger } from '../lib/log';
import type { Account, Channel, MetricRow } from '../types';

export interface PlatformContext {
  env: Env;
  log: Logger;
  /** When true, an adapter must describe the call instead of making it. */
  dryRun: boolean;
}

export interface MediaRef {
  /** Publicly reachable URL. Most platforms pull media rather than accept bytes. */
  url: string;
  mimeType: string;
  kind: 'image' | 'video';
  durationMs?: number;
  altText?: string;
}

export interface PublishInput {
  body: string;
  hook?: string | null;
  cta?: string | null;
  hashtags?: string[];
  media: MediaRef[];
  /** Passed upstream where the platform supports it, otherwise used locally. */
  idempotencyKey: string;
  /** Reddit needs one, LinkedIn and Pinterest use it as the title field. */
  title?: string;
  /** Reddit subreddit, Pinterest board id. */
  destination?: string;
  linkUrl?: string;
}

export interface PublishResult {
  externalId: string;
  permalink?: string;
  /** Set when the adapter only described the call because dryRun was on. */
  dryRun?: boolean;
  raw?: unknown;
}

/** Posting to an owned account: TikTok, Instagram, Threads, and the rest. */
export interface OrganicAdapter {
  readonly channel: Channel;
  /** Cheap credential check used by the health endpoint and the guardian. */
  verify(ctx: PlatformContext, account: Account): Promise<VerifyResult>;
  publish(ctx: PlatformContext, account: Account, input: PublishInput): Promise<PublishResult>;
  /** Per-post metrics for the window, newest platform data wins on upsert. */
  insights(
    ctx: PlatformContext,
    account: Account,
    opts: { since: string; until: string; externalIds?: string[] },
  ): Promise<MetricRow[]>;
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
  /** Present when the token is close enough to expiry to act on. */
  expiresAt?: string;
}

export interface AdCampaignSpec {
  name: string;
  objective: string;
  dailyBudgetCents: number;
  currency: string;
  startsAt?: string | null;
  endsAt?: string | null;
  targeting: Record<string, unknown>;
  landingUrl: string;
}

export interface AdCreativeSpec {
  headline?: string | null;
  body: string;
  cta?: string | null;
  media: MediaRef[];
  landingUrl: string;
  /** Boosting an existing organic post rather than uploading new media. */
  sourcePostId?: string | null;
}

export interface AdEntityResult {
  externalId: string;
  dryRun?: boolean;
  raw?: unknown;
}

/** Buying media on a channel. */
export interface AdsAdapter {
  readonly channel: Channel;
  verify(ctx: PlatformContext, account: Account): Promise<VerifyResult>;
  /** Creates campaign + ad group in whatever shape the platform requires. */
  createCampaign(
    ctx: PlatformContext,
    account: Account,
    spec: AdCampaignSpec,
  ): Promise<{ campaign: AdEntityResult; adSet: AdEntityResult }>;
  createAd(
    ctx: PlatformContext,
    account: Account,
    adSetExternalId: string,
    spec: AdCreativeSpec,
  ): Promise<AdEntityResult>;
  setBudget(
    ctx: PlatformContext,
    account: Account,
    adSetExternalId: string,
    dailyBudgetCents: number,
    currency: string,
  ): Promise<AdEntityResult>;
  setStatus(
    ctx: PlatformContext,
    account: Account,
    externalId: string,
    status: 'active' | 'paused',
    level: 'campaign' | 'adset' | 'ad',
  ): Promise<AdEntityResult>;
  report(
    ctx: PlatformContext,
    account: Account,
    opts: { since: string; until: string; externalIds?: string[] },
  ): Promise<MetricRow[]>;
}

/** Shape returned when dryRun stops a call from going out. */
export function described(action: string, detail: Record<string, unknown>): AdEntityResult {
  return { externalId: `dryrun:${action}`, dryRun: true, raw: detail };
}

export function describedPublish(
  action: string,
  detail: Record<string, unknown>,
): PublishResult {
  return { externalId: `dryrun:${action}`, dryRun: true, raw: detail };
}

export function emptyMetric(
  entityType: MetricRow['entity_type'],
  entityId: string,
  channel: Channel,
  date: string,
): MetricRow {
  return {
    entity_type: entityType,
    entity_id: entityId,
    channel,
    metric_date: date,
    impressions: 0,
    reach: 0,
    clicks: 0,
    video_views: 0,
    engagements: 0,
    follows: 0,
    conversions: 0,
    spend_cents: 0,
    revenue_cents: 0,
    currency: 'USD',
  };
}
