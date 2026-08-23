#!/usr/bin/env bash
# Interactive secret upload. Reads each value from your terminal and sends it
# straight to Cloudflare, so nothing lands in a file or in shell history.
#
# Every secret is optional except ADMIN_TOKEN. A channel with no secret simply
# stays disconnected, and the guardian reports it on the next health check.
set -uo pipefail

REQUIRED=(
  ADMIN_TOKEN
)

OPTIONAL=(
  ANTHROPIC_API_KEY
  STRIPE_SECRET_KEY
  STRIPE_WEBHOOK_SECRET
  DATABENTO_API_KEY

  META_APP_ID
  META_APP_SECRET
  META_SYSTEM_USER_TOKEN
  META_AD_ACCOUNT_ID
  THREADS_ACCESS_TOKEN

  TIKTOK_APP_ID
  TIKTOK_APP_SECRET
  TIKTOK_ACCESS_TOKEN
  TIKTOK_ADVERTISER_ID

  X_API_KEY
  X_API_SECRET
  X_ACCESS_TOKEN
  X_ACCESS_TOKEN_SECRET

  YOUTUBE_CLIENT_ID
  YOUTUBE_CLIENT_SECRET
  YOUTUBE_REFRESH_TOKEN

  PINTEREST_ACCESS_TOKEN
  PINTEREST_AD_ACCOUNT_ID

  LINKEDIN_ACCESS_TOKEN
  LINKEDIN_ORG_URN

  REDDIT_CLIENT_ID
  REDDIT_CLIENT_SECRET
  REDDIT_REFRESH_TOKEN

  SNAPCHAT_CLIENT_ID
  SNAPCHAT_CLIENT_SECRET
  SNAPCHAT_REFRESH_TOKEN
  SNAPCHAT_AD_ACCOUNT_ID

  GOOGLE_ADS_DEVELOPER_TOKEN
  GOOGLE_ADS_CLIENT_ID
  GOOGLE_ADS_CLIENT_SECRET
  GOOGLE_ADS_REFRESH_TOKEN
  GOOGLE_ADS_CUSTOMER_ID
)

put_secret() {
  local name="$1" required="$2" value
  printf '\n%s%s\n' "$name" "$([ "$required" = "yes" ] && echo ' (required)' || echo ' (enter to skip)')"
  read -r -s -p '  value: ' value
  echo
  if [ -z "$value" ]; then
    if [ "$required" = "yes" ]; then
      echo "  required, try again"
      put_secret "$name" "$required"
    else
      echo "  skipped"
    fi
    return
  fi
  printf '%s' "$value" | npx wrangler secret put "$name" >/dev/null 2>&1 \
    && echo "  stored" || echo "  FAILED"
}

echo "Uploading secrets to Cloudflare."
echo "Values are never written to disk."

for name in "${REQUIRED[@]}"; do put_secret "$name" yes; done
for name in "${OPTIONAL[@]}"; do put_secret "$name" no; done

echo
echo "Done. Check what is connected with:"
echo '  curl -H "authorization: Bearer $ADMIN_TOKEN" https://ops.bbanetwork.org/api/status'
