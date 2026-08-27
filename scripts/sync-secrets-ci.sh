#!/usr/bin/env bash
#
# Push runtime secrets onto the Worker from CI.
#
# The counterpart to scripts/push-secrets.sh, which reads values from a TTY.
# That is correct on a laptop and unusable here: this project is operated from
# a browser and an iPad, so there is no terminal to type into. The consequence
# was not hypothetical — ANTHROPIC_API_KEY was still unset on the live Worker
# three days after launch, and the agents that need a model (scout, creative,
# and the daily report's narrative) could not run.
#
# Values arrive as SECRET_<NAME> environment variables, set from GitHub Actions
# secrets by .github/workflows/deploy.yml. Nothing is read from a file and
# nothing is echoed: the only thing printed is the *name* of each secret and
# whether it was pushed.
#
# Absent means "leave alone", not "blank". A name with no value in GitHub keeps
# whatever the Worker already has, so this can never wipe a secret that was set
# another way. A name that IS present overwrites, which makes this the rotation
# path as well as the setup path.

set -uo pipefail

NAMES=(
  ANTHROPIC_API_KEY
  ADMIN_TOKEN
  STRIPE_SECRET_KEY
  STRIPE_WEBHOOK_SECRET
  DATABENTO_API_KEY
)

synced=""
skipped=""
failed=""

for name in "${NAMES[@]}"; do
  source_var="SECRET_${name}"
  value="${!source_var:-}"

  if [ -z "$value" ]; then
    skipped="$skipped $name"
    continue
  fi

  # printf, not echo: wrangler takes stdin verbatim, and a trailing newline
  # would silently become part of the secret. A signing key with an extra byte
  # fails only at runtime, on a real request.
  if printf '%s' "$value" | npx wrangler secret put "$name" > /dev/null 2>&1; then
    synced="$synced $name"
  else
    failed="$failed $name"
  fi
done

summary() {
  echo "### Runtime secrets"
  echo
  [ -n "$synced" ]  && echo "- Pushed to the Worker:$synced"
  [ -n "$skipped" ] && echo "- Not set in GitHub, left as-is on the Worker:$skipped"
  [ -n "$failed" ]  && echo "- **Failed to push:$failed**"
  echo
  echo "Add or change one under **Settings → Secrets and variables → Actions**,"
  echo "then re-run this workflow. No terminal needed."
}

summary
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  summary >> "$GITHUB_STEP_SUMMARY"
fi

# A secret that was offered and would not go on is a real failure: the deploy
# would otherwise report success while the Worker keeps running on an old or
# missing value.
if [ -n "$failed" ]; then
  echo "::error::could not set:$failed"
  exit 1
fi
