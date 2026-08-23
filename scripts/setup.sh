#!/usr/bin/env bash
# Creates the Cloudflare resources this Worker binds to and prints the ids to
# paste into wrangler.toml. Safe to re-run: existing resources are reported
# rather than duplicated.
set -uo pipefail

NAME="bba-growth-os"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "D1 database"
npx wrangler d1 create "$NAME" 2>&1 | tail -20

step "KV namespaces"
npx wrangler kv namespace create CONFIG 2>&1 | tail -10
npx wrangler kv namespace create CACHE 2>&1 | tail -10

step "R2 bucket"
npx wrangler r2 bucket create "$NAME-media" 2>&1 | tail -5

step "Queues"
npx wrangler queues create "$NAME-jobs" 2>&1 | tail -5
npx wrangler queues create "$NAME-jobs-dlq" 2>&1 | tail -5

cat <<'NOTE'

Next:
  1. Paste the ids printed above into wrangler.toml (database_id and the two kv ids).
  2. npm run db:migrate
  3. bash scripts/push-secrets.sh
  4. npm run deploy

Queues and Durable Objects need the Workers Paid plan ($5/month), which is
what the crons, the job bus and the per-campaign locks all run on.
NOTE
