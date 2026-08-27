-- Real offers for the two businesses BBA Network actually sells.
--
-- Why this file exists
-- --------------------
-- db/seed.sql ships an *example* offer ("Replace this with the thing you
-- actually sell"). On the production database its INSERT never landed: the
-- settings rows are dated 2026-08-23 19:05:47 and the offers table is empty.
--
-- The consequence was not an error anywhere. It was three days of an
-- orchestrator running perfectly against nothing:
--
--   runs      1007, every one 'ok'
--   jobs      1206, every one 'done', none failed
--   offers    0
--   campaigns 0
--   creatives 0
--   accounts  0
--
-- Both agents that begin a campaign open with
--   SELECT * FROM offers WHERE status = 'active' LIMIT 1
-- (src/agents/strategist.ts:76, src/agents/scout.ts:54), so with no offer the
-- strategist returns 'no active offer to plan against' and the scout never
-- runs at all. Nothing downstream of them — creative, mediabuyer — has ever
-- been enqueued.
--
-- Safe to run more than once: every statement is INSERT OR IGNORE keyed on id.
--
-- This does NOT enable spending. DRY_RUN and REQUIRE_HUMAN_APPROVAL are both
-- true in wrangler.toml, and no ad-platform credential is set, so the effect of
-- seeding is that the agents start producing drafts for a human to approve.

-- ---------------------------------------------------------------------------
-- BBA Guides — printable reference guides, sold as PDF downloads.
--
-- Reachable today at guides.bbanetwork.org, which matters because the scout
-- fetches landing_url over the public internet to extract the claims a writer
-- is allowed to make. Priced from the live catalogue: catalog/generated.json in
-- network-store-2 lists all three guides at $9.45 USD.
--
-- gross_margin_bps 9400 — a digital download has no unit cost, so the only
-- deduction is Stripe's fee. On $9.45 that is 2.9% + $0.30 = $0.57, leaving
-- 94% of the price. It is not 100%.
--
-- target_cac_cents 400 — deliberately well inside the $8.88 that margin
-- allows, because this is a first-touch number with no conversion data behind
-- it yet. The optimizer bids against it, so a wrong-but-conservative value
-- costs less than a wrong-but-optimistic one. Raise it once real CAC exists.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO offers (
  id, name, slug, description, landing_url, price_cents, currency,
  stripe_product_id, stripe_price_id,
  target_cac_cents, gross_margin_bps, status, created_at, updated_at
) VALUES (
  'off_bba_guides',
  'BBA Guides',
  'guides',
  'Printable reference guides for the hobbies people actually get stuck in. One page, one problem: espresso dial-in troubleshooting and a keyboard sound and mod chart. A4 and US Letter PDFs, delivered instantly.',
  'https://guides.bbanetwork.org/',
  945,
  'USD',
  NULL,
  NULL,
  400,
  9400,
  'active',
  datetime('now'),
  datetime('now')
);

-- ---------------------------------------------------------------------------
-- Website Health Check — the audit service, $100 one-off.
--
-- Seeded as 'paused', not 'active', and that is the point.
--
-- The offer is real: a live Stripe product (prod_V7tZMsJQTM8AMG) and a live,
-- active Payment Link at $100.00 USD, which is where the money is actually
-- taken. What does not exist is audit.bbanetwork.org — web-6/docs/DOMAINS.md
-- records it as genuinely absent, and Project 1 is still 'building'.
--
-- landing_url is required and is fetched by the scout. Pointing it at a host
-- with no DNS record would make every scout run fail with 'could not read'.
-- Pointing it at buy.stripe.com instead would 'work' and be worse: the scout
-- would extract its claims from a checkout page rather than from the sales
-- copy, and the writers may not exceed what it records.
--
-- So: paused, with the destination it will have. The strategist selects on
-- status = 'active', so this sits inert until someone flips it — which is the
-- correct moment, i.e. when audit.bbanetwork.org answers.
--
-- gross_margin_bps 9000 — a $100 card payment costs $3.20 in Stripe fees; the
-- rest of the deduction is the human time in writing the report, which is real
-- but not a cash cost. Confirm this number before it drives a bid.
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO offers (
  id, name, slug, description, landing_url, price_cents, currency,
  stripe_product_id, stripe_price_id,
  target_cac_cents, gross_margin_bps, status, created_at, updated_at
) VALUES (
  'off_bba_audit',
  'Website Health Check',
  'audit',
  'A plain-English review of your website: what is broken, what each problem costs you in lost customers, and exactly how to fix it. Delivered within one working day.',
  'https://audit.bbanetwork.org/',
  10000,
  'USD',
  'prod_V7tZMsJQTM8AMG',
  'price_1U7dmlR7EyLACZsrOUWq6h4j',
  2500,
  9000,
  'paused',
  datetime('now'),
  datetime('now')
);

-- ---------------------------------------------------------------------------
-- Pages the scout may read.
--
-- Only hosts that answer today. audit.bbanetwork.org is deliberately absent
-- for the same reason its offer is paused. The scout checks robots.txt before
-- fetching (src/agents/scout.ts:57), so this list is a permission, not a
-- promise that a fetch will happen.
-- ---------------------------------------------------------------------------
UPDATE settings
   SET value = '["https://guides.bbanetwork.org/","https://bbanetwork.org/"]',
       updated_at = datetime('now')
 WHERE key = 'scout_sources'
   AND value IN ('[]', '');
