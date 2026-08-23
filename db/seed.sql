-- Optional starter data. Safe to run more than once.
-- Apply with: npm run seed:local  (or add --remote for the deployed database)

INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (
  'runtime',
  '{"dryRun":true,"requireHumanApproval":true,"dailySpendCapCents":20000,"editorialMinScore":78,"enabledChannels":[],"paused":false}',
  datetime('now')
);

-- The brand voice guide. Edit this from the console or with PUT /api/voice.
-- provenClaims is the list a writer may not exceed; the scout fills it in from
-- the real landing page.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (
  'voice_profile',
  json('{
    "brand": "BBA Network",
    "positioning": "BBA Network builds and runs software and media businesses. Copy should sound like an operator talking to another operator: specific, unbothered, and willing to name a number.",
    "audience": "People who buy tools and services to run a business or a trading operation. They have been sold to badly before and they can smell it.",
    "style": [
      "Short sentences. One idea each.",
      "Lead with the concrete thing, not the setup.",
      "Numbers over adjectives. If there is no number, use a specific noun.",
      "Straight quotes, no em dashes, no emoji as decoration.",
      "Never explain that you are about to say something. Say it."
    ],
    "bannedPhrases": ["game changer","level up","unlock","dive in","crush it","no-brainer","the future of"],
    "exemplars": [],
    "provenClaims": []
  }'),
  datetime('now')
);

-- Pages the scout is allowed to read. Add your own competitors here.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (
  'scout_sources',
  '[]',
  datetime('now')
);

-- An example offer so the strategist has something to plan against.
-- Replace the landing url and price with a real one before going live.
INSERT OR IGNORE INTO offers (
  id, name, slug, description, landing_url, price_cents, currency,
  target_cac_cents, gross_margin_bps, status, created_at, updated_at
) VALUES (
  'off_example',
  'BBA Network starter offer',
  'starter',
  'Replace this with the thing you actually sell.',
  'https://example.com/offer',
  9900,
  'USD',
  3000,
  8500,
  'active',
  datetime('now'),
  datetime('now')
);
