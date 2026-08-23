/** Shared domain types. Kept free of Worker globals so tests can import them. */

export const CHANNELS = [
  'tiktok',
  'instagram',
  'threads',
  'facebook',
  'x',
  'youtube',
  'pinterest',
  'linkedin',
  'reddit',
  'snapchat',
  'google',
] as const;
export type Channel = (typeof CHANNELS)[number];

export type Surface = 'organic' | 'ads';

export const AGENTS = [
  'strategist',
  'creative',
  'producer',
  'publisher',
  'mediabuyer',
  'optimizer',
  'analyst',
  'guardian',
  'scout',
  'quant',
] as const;
export type AgentId = (typeof AGENTS)[number];

export interface Account {
  id: string;
  channel: Channel;
  surface: Surface;
  handle: string | null;
  external_id: string;
  display_name: string | null;
  timezone: string;
  currency: string;
  secret_ref: string;
  status: 'active' | 'paused' | 'revoked' | 'needs_reauth';
  scopes: string | null;
  token_expires_at: string | null;
  meta: string;
  created_at: string;
  updated_at: string;
}

export interface Campaign {
  id: string;
  name: string;
  offer_id: string | null;
  objective: 'conversions' | 'traffic' | 'awareness' | 'leads' | 'app_installs';
  status: 'draft' | 'pending_approval' | 'active' | 'paused' | 'archived';
  daily_budget_cents: number;
  total_budget_cents: number | null;
  currency: string;
  starts_at: string | null;
  ends_at: string | null;
  brief: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignChannel {
  id: string;
  campaign_id: string;
  account_id: string;
  channel: Channel;
  external_id: string | null;
  external_adset_id: string | null;
  status: string;
  daily_budget_cents: number;
  bid_strategy: string | null;
  targeting: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Creative {
  id: string;
  campaign_id: string | null;
  kind: 'ad' | 'organic_post' | 'story' | 'short';
  channel: Channel | null;
  version: number;
  parent_id: string | null;
  hook: string | null;
  body: string;
  cta: string | null;
  hashtags: string | null;
  media: string;
  editorial_score: number | null;
  editorial_report: string | null;
  status:
    | 'draft'
    | 'needs_revision'
    | 'pending_approval'
    | 'approved'
    | 'rejected'
    | 'live'
    | 'retired';
  authored_by: string;
  approved_by: string | null;
  approved_at: string | null;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Post {
  id: string;
  account_id: string;
  creative_id: string;
  channel: Channel;
  scheduled_for: string;
  published_at: string | null;
  external_id: string | null;
  permalink: string | null;
  status:
    | 'scheduled'
    | 'pending_approval'
    | 'publishing'
    | 'published'
    | 'failed'
    | 'cancelled';
  attempts: number;
  last_error: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

export interface Offer {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  landing_url: string;
  price_cents: number;
  currency: string;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  target_cac_cents: number | null;
  gross_margin_bps: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface MetricRow {
  entity_type: 'campaign_channel' | 'post' | 'account' | 'creative';
  entity_id: string;
  channel: Channel;
  metric_date: string;
  impressions: number;
  reach: number;
  clicks: number;
  video_views: number;
  engagements: number;
  follows: number;
  conversions: number;
  spend_cents: number;
  revenue_cents: number;
  currency: string;
  raw?: unknown;
}

export interface JobRecord {
  id: string;
  run_id: string | null;
  agent: AgentId;
  task: string;
  payload: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'blocked';
  priority: number;
  attempts: number;
  max_attempts: number;
  not_before: string | null;
  idempotency_key: string | null;
  result: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The message shape that travels on the Cloudflare Queue. */
export interface JobMessage {
  jobId: string;
  runId: string | null;
  agent: AgentId;
  task: string;
  payload: Record<string, unknown>;
}

/** An intent an agent wants to carry out. Always logged before it is applied. */
export interface Decision {
  agent: AgentId;
  action: string;
  targetType?: string;
  targetId?: string;
  channel?: Channel;
  rationale: string;
  evidence?: Record<string, unknown>;
  proposed?: Record<string, unknown>;
  /** high-risk decisions always need a human, even when auto-approve is on */
  risk?: 'low' | 'normal' | 'high';
}

export interface AgentResult {
  ok: boolean;
  summary: string;
  decisions?: number;
  enqueued?: number;
  data?: Record<string, unknown>;
}
