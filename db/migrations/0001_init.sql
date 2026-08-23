-- BBA Network Growth OS -- core schema.
-- SQLite/D1. All timestamps are ISO-8601 UTC strings. All money is integer
-- minor units (cents) plus a currency code; never store money as a float.

-- ---------------------------------------------------------------------------
-- Connected accounts
-- ---------------------------------------------------------------------------

CREATE TABLE accounts (
  id                TEXT PRIMARY KEY,
  channel           TEXT NOT NULL,          -- tiktok | instagram | threads | facebook | x | youtube | pinterest | linkedin | reddit
  surface           TEXT NOT NULL,          -- organic | ads
  handle            TEXT,                   -- @bbanetwork
  external_id       TEXT NOT NULL,          -- platform-side id (page id, advertiser id, ...)
  display_name      TEXT,
  timezone          TEXT NOT NULL DEFAULT 'UTC',
  currency          TEXT NOT NULL DEFAULT 'USD',
  -- Name of the Worker secret holding this account's credentials. The secret
  -- value never touches the database.
  secret_ref        TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',   -- active | paused | revoked | needs_reauth
  scopes            TEXT,                   -- JSON array of granted OAuth scopes
  token_expires_at  TEXT,
  meta              TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (channel, surface, external_id)
);
CREATE INDEX idx_accounts_channel ON accounts (channel, status);

-- ---------------------------------------------------------------------------
-- Offers: what we actually sell. Ties ad spend to Stripe revenue.
-- ---------------------------------------------------------------------------

CREATE TABLE offers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,
  description       TEXT,
  landing_url       TEXT NOT NULL,
  price_cents       INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'USD',
  stripe_product_id TEXT,
  stripe_price_id   TEXT,
  -- Break-even and target economics the optimizer bids against.
  target_cac_cents  INTEGER,
  gross_margin_bps  INTEGER NOT NULL DEFAULT 10000,  -- 100.00%
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Campaigns and their per-channel mirrors
-- ---------------------------------------------------------------------------

CREATE TABLE campaigns (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  offer_id          TEXT REFERENCES offers (id),
  objective         TEXT NOT NULL,          -- conversions | traffic | awareness | leads | app_installs
  status            TEXT NOT NULL DEFAULT 'draft',  -- draft | pending_approval | active | paused | archived
  -- Budget the strategist is allowed to distribute across channels.
  daily_budget_cents INTEGER NOT NULL DEFAULT 0,
  total_budget_cents INTEGER,
  currency          TEXT NOT NULL DEFAULT 'USD',
  starts_at         TEXT,
  ends_at           TEXT,
  brief             TEXT NOT NULL DEFAULT '{}',   -- JSON: audience, angle, constraints
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_campaigns_status ON campaigns (status);

-- One row per channel a campaign runs on. external_id is filled in once the
-- channel adapter has actually created the campaign upstream.
CREATE TABLE campaign_channels (
  id                TEXT PRIMARY KEY,
  campaign_id       TEXT NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  account_id        TEXT NOT NULL REFERENCES accounts (id),
  channel           TEXT NOT NULL,
  external_id       TEXT,
  external_adset_id TEXT,
  status            TEXT NOT NULL DEFAULT 'draft',
  daily_budget_cents INTEGER NOT NULL DEFAULT 0,
  bid_strategy      TEXT,
  targeting         TEXT NOT NULL DEFAULT '{}',
  last_synced_at    TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (campaign_id, account_id)
);
CREATE INDEX idx_campaign_channels_campaign ON campaign_channels (campaign_id);

-- ---------------------------------------------------------------------------
-- Creatives: copy plus media, versioned, scored by the editorial gate
-- ---------------------------------------------------------------------------

CREATE TABLE creatives (
  id                TEXT PRIMARY KEY,
  campaign_id       TEXT REFERENCES campaigns (id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,          -- ad | organic_post | story | short
  channel           TEXT,                   -- null means channel-agnostic source copy
  version           INTEGER NOT NULL DEFAULT 1,
  parent_id         TEXT REFERENCES creatives (id),
  hook              TEXT,
  body              TEXT NOT NULL,
  cta               TEXT,
  hashtags          TEXT,                   -- JSON array
  media             TEXT NOT NULL DEFAULT '[]',  -- JSON array of media asset ids
  -- Editorial gate results. Nothing publishes below EDITORIAL_MIN_SCORE.
  editorial_score   INTEGER,
  editorial_report  TEXT,                   -- JSON: findings from the slop linter
  status            TEXT NOT NULL DEFAULT 'draft', -- draft | needs_revision | pending_approval | approved | rejected | live | retired
  authored_by       TEXT NOT NULL DEFAULT 'agent:creative',
  approved_by       TEXT,
  approved_at       TEXT,
  external_id       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_creatives_campaign ON creatives (campaign_id, status);
CREATE INDEX idx_creatives_status ON creatives (status);

CREATE TABLE media_assets (
  id                TEXT PRIMARY KEY,
  r2_key            TEXT NOT NULL UNIQUE,
  mime_type         TEXT NOT NULL,
  bytes             INTEGER,
  width             INTEGER,
  height            INTEGER,
  duration_ms       INTEGER,
  checksum_sha256   TEXT,
  source            TEXT NOT NULL DEFAULT 'upload',  -- upload | generated | remixed
  alt_text          TEXT,
  meta              TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Organic publishing
-- ---------------------------------------------------------------------------

CREATE TABLE posts (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts (id),
  creative_id       TEXT NOT NULL REFERENCES creatives (id),
  channel           TEXT NOT NULL,
  scheduled_for     TEXT NOT NULL,
  published_at      TEXT,
  external_id       TEXT,
  permalink         TEXT,
  status            TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | pending_approval | publishing | published | failed | cancelled
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  idempotency_key   TEXT NOT NULL UNIQUE,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_posts_due ON posts (status, scheduled_for);
CREATE INDEX idx_posts_account ON posts (account_id, published_at);

-- ---------------------------------------------------------------------------
-- Metrics: one row per (entity, channel, metric day). Upserted on sync.
-- ---------------------------------------------------------------------------

CREATE TABLE metrics (
  id                TEXT PRIMARY KEY,
  entity_type       TEXT NOT NULL,          -- campaign_channel | post | account | creative
  entity_id         TEXT NOT NULL,
  channel           TEXT NOT NULL,
  metric_date       TEXT NOT NULL,          -- YYYY-MM-DD in the account's timezone
  impressions       INTEGER NOT NULL DEFAULT 0,
  reach             INTEGER NOT NULL DEFAULT 0,
  clicks            INTEGER NOT NULL DEFAULT 0,
  video_views       INTEGER NOT NULL DEFAULT 0,
  engagements       INTEGER NOT NULL DEFAULT 0,
  follows           INTEGER NOT NULL DEFAULT 0,
  conversions       INTEGER NOT NULL DEFAULT 0,
  spend_cents       INTEGER NOT NULL DEFAULT 0,
  revenue_cents     INTEGER NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'USD',
  raw               TEXT NOT NULL DEFAULT '{}',
  synced_at         TEXT NOT NULL,
  UNIQUE (entity_type, entity_id, metric_date)
);
CREATE INDEX idx_metrics_date ON metrics (metric_date, channel);

-- ---------------------------------------------------------------------------
-- Revenue from Stripe, attributed back to a channel where possible
-- ---------------------------------------------------------------------------

CREATE TABLE revenue_events (
  id                TEXT PRIMARY KEY,
  stripe_event_id   TEXT UNIQUE,
  stripe_object_id  TEXT NOT NULL,
  kind              TEXT NOT NULL,          -- payment | refund | subscription_cycle | dispute
  amount_cents      INTEGER NOT NULL,       -- negative for refunds and disputes
  currency          TEXT NOT NULL,
  customer_id       TEXT,
  offer_id          TEXT REFERENCES offers (id),
  -- Attribution, best effort, from the checkout session's UTM metadata.
  attributed_channel TEXT,
  attributed_campaign_id TEXT REFERENCES campaigns (id),
  attribution_model TEXT,                   -- last_click | utm | manual | unattributed
  occurred_at       TEXT NOT NULL,
  raw               TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_revenue_occurred ON revenue_events (occurred_at);
CREATE INDEX idx_revenue_campaign ON revenue_events (attributed_campaign_id);

-- ---------------------------------------------------------------------------
-- Orchestration: runs, jobs, decisions, approvals
-- ---------------------------------------------------------------------------

CREATE TABLE runs (
  id                TEXT PRIMARY KEY,
  trigger           TEXT NOT NULL,          -- cron:tick | cron:daily | api | manual | queue
  cron              TEXT,
  status            TEXT NOT NULL DEFAULT 'running', -- running | ok | partial | failed
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  jobs_enqueued     INTEGER NOT NULL DEFAULT 0,
  summary           TEXT NOT NULL DEFAULT '{}',
  error             TEXT
);
CREATE INDEX idx_runs_started ON runs (started_at DESC);

CREATE TABLE jobs (
  id                TEXT PRIMARY KEY,
  run_id            TEXT REFERENCES runs (id),
  agent             TEXT NOT NULL,          -- strategist | creative | publisher | mediabuyer | ...
  task              TEXT NOT NULL,
  payload           TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | failed | cancelled | blocked
  priority          INTEGER NOT NULL DEFAULT 5,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  not_before        TEXT,
  idempotency_key   TEXT UNIQUE,
  result            TEXT,
  error             TEXT,
  started_at        TEXT,
  finished_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_jobs_status ON jobs (status, priority, created_at);
CREATE INDEX idx_jobs_run ON jobs (run_id);

-- Append-only. Every intent an agent forms is written here before it is acted
-- on, which is what makes DRY_RUN a real audit trail rather than a no-op.
CREATE TABLE decisions (
  id                TEXT PRIMARY KEY,
  run_id            TEXT REFERENCES runs (id),
  job_id            TEXT REFERENCES jobs (id),
  agent             TEXT NOT NULL,
  action            TEXT NOT NULL,          -- create_campaign | set_budget | publish_post | pause_ad | ...
  target_type       TEXT,
  target_id         TEXT,
  channel           TEXT,
  rationale         TEXT NOT NULL,
  evidence          TEXT NOT NULL DEFAULT '{}',
  proposed          TEXT NOT NULL DEFAULT '{}',
  outcome           TEXT NOT NULL DEFAULT 'proposed', -- proposed | approved | rejected | applied | dry_run | failed | expired
  applied_at        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_decisions_outcome ON decisions (outcome, created_at DESC);

CREATE TABLE approvals (
  id                TEXT PRIMARY KEY,
  decision_id       TEXT REFERENCES decisions (id),
  subject_type      TEXT NOT NULL,          -- creative | post | campaign | budget_change
  subject_id        TEXT NOT NULL,
  requested_by      TEXT NOT NULL,
  summary           TEXT NOT NULL,
  risk              TEXT NOT NULL DEFAULT 'normal', -- low | normal | high
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | expired
  decided_by        TEXT,
  decided_at        TEXT,
  note              TEXT,
  expires_at        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_approvals_status ON approvals (status, created_at);

-- ---------------------------------------------------------------------------
-- Guardrails and observability
-- ---------------------------------------------------------------------------

CREATE TABLE spend_ledger (
  id                TEXT PRIMARY KEY,
  ledger_date       TEXT NOT NULL,          -- YYYY-MM-DD UTC
  channel           TEXT NOT NULL,
  -- Empty string, never NULL: SQLite treats NULLs in a UNIQUE index as
  -- distinct, so a nullable column here would make the upsert below insert a
  -- new row on every sync and double count spend. No FK for the same reason.
  campaign_id       TEXT NOT NULL DEFAULT '',
  amount_cents      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'USD',
  source            TEXT NOT NULL,          -- platform_sync | projection
  created_at        TEXT NOT NULL,
  UNIQUE (ledger_date, channel, campaign_id, source)
);
CREATE INDEX idx_spend_date ON spend_ledger (ledger_date);

CREATE TABLE incidents (
  id                TEXT PRIMARY KEY,
  severity          TEXT NOT NULL,          -- info | warn | error | critical
  source            TEXT NOT NULL,
  code              TEXT NOT NULL,
  message           TEXT NOT NULL,
  context           TEXT NOT NULL DEFAULT '{}',
  resolved_at       TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_incidents_open ON incidents (resolved_at, created_at DESC);

-- Small typed key/value store for things that want transactional reads with
-- the rest of the data (KV is eventually consistent, this is not).
CREATE TABLE settings (
  key               TEXT PRIMARY KEY,
  value             TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Market data snapshots from Databento, used by the quant agent to time
-- campaigns for finance-adjacent offers.
CREATE TABLE market_signals (
  id                TEXT PRIMARY KEY,
  dataset           TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  signal            TEXT NOT NULL,          -- e.g. realized_vol_20d
  value             REAL NOT NULL,
  observed_at       TEXT NOT NULL,
  raw               TEXT NOT NULL DEFAULT '{}',
  UNIQUE (dataset, symbol, signal, observed_at)
);
CREATE INDEX idx_market_signals_symbol ON market_signals (symbol, observed_at DESC);
