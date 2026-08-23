import type { CampaignRoom } from './orchestrator/campaign-room';
import type { JobMessage } from './types';

export interface Env {
  // --- bindings ---
  DB: D1Database;
  CONFIG: KVNamespace;
  CACHE: KVNamespace;
  MEDIA: R2Bucket;
  JOBS: Queue<JobMessage>;
  CAMPAIGN_ROOM: DurableObjectNamespace<CampaignRoom>;

  // --- vars (wrangler.toml) ---
  BBA_ENV: string;
  BBA_BUSINESS_NAME: string;
  BBA_BUSINESS_EMAIL: string;
  DRY_RUN: string;
  REQUIRE_HUMAN_APPROVAL: string;
  DAILY_SPEND_CAP_CENTS: string;
  EDITORIAL_MIN_SCORE: string;
  LOG_LEVEL: string;
  /** Absolute origin of this Worker. Platforms fetch media from here. */
  PUBLIC_BASE_URL: string;

  // --- secrets (wrangler secret put) ---
  /** Bearer token for the console and the admin API. */
  ADMIN_TOKEN?: string;
  /** Signing key for one-click approval links delivered by email. */
  APPROVAL_SIGNING_KEY?: string;

  ANTHROPIC_API_KEY?: string;

  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;

  DATABENTO_API_KEY?: string;

  // Meta covers Facebook Pages, Instagram, Threads and Meta Ads.
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_SYSTEM_USER_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
  THREADS_ACCESS_TOKEN?: string;

  TIKTOK_APP_ID?: string;
  TIKTOK_APP_SECRET?: string;
  TIKTOK_ACCESS_TOKEN?: string;
  TIKTOK_ADVERTISER_ID?: string;

  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_TOKEN_SECRET?: string;
  X_BEARER_TOKEN?: string;

  YOUTUBE_CLIENT_ID?: string;
  YOUTUBE_CLIENT_SECRET?: string;
  YOUTUBE_REFRESH_TOKEN?: string;

  PINTEREST_ACCESS_TOKEN?: string;
  PINTEREST_AD_ACCOUNT_ID?: string;

  LINKEDIN_ACCESS_TOKEN?: string;
  LINKEDIN_ORG_URN?: string;

  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  REDDIT_REFRESH_TOKEN?: string;

  SNAPCHAT_CLIENT_ID?: string;
  SNAPCHAT_CLIENT_SECRET?: string;
  SNAPCHAT_REFRESH_TOKEN?: string;
  SNAPCHAT_AD_ACCOUNT_ID?: string;

  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  GOOGLE_ADS_REFRESH_TOKEN?: string;
  GOOGLE_ADS_CUSTOMER_ID?: string;
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;

  [key: string]: unknown;
}
