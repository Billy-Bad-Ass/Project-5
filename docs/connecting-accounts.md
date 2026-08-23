# Connecting accounts

Every credential lives in a Cloudflare Worker secret. The database stores only
the *name* of the secret, so a database dump never contains a token.

Two steps per account:

```bash
npx wrangler secret put TIKTOK_ACCESS_TOKEN     # paste the value when prompted
```

then, on the console's Accounts tab (or via the API):

```bash
curl -X POST https://ops.bbanetwork.org/api/accounts \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"channel":"tiktok","surface":"organic","externalId":"<open_id>","secretRef":"TIKTOK_ACCESS_TOKEN","handle":"@bbanetwork"}'
```

The account is verified immediately on creation, so a bad credential surfaces
now rather than at 3am. `surface` is `organic` for posting and `ads` for buying.

A secret may be a bare token or a JSON object. Use JSON when the platform needs
more than one value:

```json
{"access_token":"...","refresh_token":"...","client_id":"...","client_secret":"..."}
```

## What each platform needs

### Meta: Facebook Pages, Instagram, Threads, Meta Ads

One app covers all four. Create it at developers.facebook.com, add a System
User in Business Manager, and grant it the assets (Page, Instagram account, ad
account).

- Secret: `META_SYSTEM_USER_TOKEN`, a long-lived System User token.
- Facebook: `externalId` is the Page id. Scopes: `pages_manage_posts`,
  `pages_read_engagement`.
- Instagram: `externalId` is the Instagram Business account id (not the
  username). Scopes: `instagram_basic`, `instagram_content_publish`. The account
  must be a Business or Creator account linked to the Page.
- Threads: separate token, `THREADS_ACCESS_TOKEN`, from the Threads API app.
  `externalId` is the Threads user id. Scopes: `threads_basic`,
  `threads_content_publish`, `threads_manage_insights`.
- Meta Ads: `surface: "ads"`, `externalId` is the ad account id (`act_123...`
  or just the digits). Scope: `ads_management`. Set `meta` on the account to
  `{"page_id":"<page id>"}`, which the ad creative needs.

Instagram content publishing has a rate limit of 50 posts per 24 hours per
account. The publisher's spacing keeps you well under it.

### TikTok

Two separate APIs, two separate apps.

- Organic: `TIKTOK_ACCESS_TOKEN` from the TikTok for Developers Content Posting
  API. `externalId` is the `open_id`. Scopes: `video.publish`, `video.list`,
  `user.info.basic`.

  Until your app passes audit, the Content Posting API can only send drafts to
  the account's inbox for the owner to publish by hand. Direct Post needs the
  audited scope. Everything else works before audit.

- Ads: `surface: "ads"`, `TIKTOK_ACCESS_TOKEN` from the TikTok Business API,
  `externalId` is the advertiser id. Set `meta` to
  `{"identity_id":"...","identity_type":"CUSTOMIZED_USER"}` so ad creation has
  an identity to post as.

### X

OAuth 1.0a, so the secret must be JSON with four values:

```json
{
  "consumer_key": "...",
  "consumer_secret": "...",
  "access_token": "...",
  "token_secret": "..."
}
```

Store it as `X_ACCESS_TOKEN`. `externalId` is your numeric user id. Posting
needs at least the Basic tier; the Free tier caps writes very low. Non-public
metrics (impressions, link clicks) need the account that owns the post.

### YouTube

Google OAuth with a refresh token. Secret `YOUTUBE_REFRESH_TOKEN` as JSON:

```json
{"access_token":"","refresh_token":"...","client_id":"...","client_secret":"..."}
```

`externalId` is the channel id. Scope: `https://www.googleapis.com/auth/youtube.upload`.
Uploads from an unverified project are locked to private, so verify the project
before expecting public Shorts.

### Google Ads

Same OAuth shape plus two extras:

```json
{
  "access_token": "",
  "refresh_token": "...",
  "client_id": "...",
  "client_secret": "...",
  "developer_token": "...",
  "login_customer_id": "1234567890"
}
```

Store as `GOOGLE_ADS_REFRESH_TOKEN`, `surface: "ads"`, `externalId` is the
customer id (hyphens are stripped automatically). `login_customer_id` is only
needed when the account sits under a manager account.

A developer token starts with Test Account access. You need Basic access before
it will touch a real account, which is an application to Google.

### Pinterest

Secret `PINTEREST_ACCESS_TOKEN`. Scopes: `pins:write`, `boards:read`,
`user_accounts:read`, plus `ads:write` for the ads surface.

- Organic: `externalId` is your user id. Set `meta` to
  `{"board_id":"<board id>"}` so pins have somewhere to go.
- Ads: `externalId` is the ad account id. Pinterest ads promote an existing
  pin, so publish the pin organically first; the mediabuyer passes its id
  through as `sourcePostId`.

### LinkedIn

Secret `LINKEDIN_ACCESS_TOKEN`, an organization access token. `externalId` is
the organization URN (`urn:li:organization:12345678`) or just the digits.
Products needed: Community Management API, plus Advertising API for the ads
surface. Both require LinkedIn's approval.

### Reddit

Secret `REDDIT_REFRESH_TOKEN` as JSON with `client_id` and `client_secret`.
`externalId` is your username. Scopes: `submit`, `read`, `identity`.

Reddit posts need a target subreddit, and the publisher fails loudly rather
than guessing one. Only schedule these for communities BBA actually
participates in. Most subreddits remove promotional posts quickly and some
will ban the account.

### Snapchat Ads

Secret `SNAPCHAT_REFRESH_TOKEN` as JSON with `client_id` and `client_secret`.
`surface: "ads"`, `externalId` is the ad account id. Snapchat ads reference an
uploaded creative id, passed through as `sourcePostId`.

## Non-platform secrets

| Secret | Needed for | Without it |
|---|---|---|
| `ADMIN_TOKEN` | The console and the whole admin API | The admin surface refuses every request |
| `ANTHROPIC_API_KEY` | strategist, creative, daily narrative | Those agents report they are offline; everything else runs |
| `STRIPE_SECRET_KEY` | Revenue attribution, ROAS | The optimizer allocates on clicks alone, which is much worse |
| `STRIPE_WEBHOOK_SECRET` | Live revenue events | Falls back to hourly charge polling |
| `DATABENTO_API_KEY` | quant agent | The quant agent no-ops |

## Stripe attribution

Attribution is what turns "we got clicks" into "this channel made money", and
it is the input the optimizer allocates on. It works in two hops.

**Hop one: the ad link.** Ads and posts do not point at the landing page
directly. The mediabuyer points them at `go.bbanetwork.org`, which redirects to
the landing page with the channel, campaign and creative appended:

```
https://go.bbanetwork.org/go/starter?ch=tiktok&c=cmp_abc&m=paid&v=crv_9
            |
            v  302
https://bbanetwork.org/starter?utm_source=tiktok&utm_medium=paid
    &utm_campaign=spring+push&utm_content=crv_9
    &bba_channel=tiktok&bba_campaign_id=cmp_abc
```

The destination always comes from the `offers` table, never from the request,
so the redirect cannot be pointed anywhere else. Nothing is written on that
path; click counts come from the platforms during the metrics sync, which is
more accurate than anything measured here and cannot be inflated by a crawler.

You can hand-build a link for a channel the system does not manage:
`https://go.bbanetwork.org/go/<offer-slug>?ch=newsletter&m=email`.

**Hop two: the checkout session.** The landing page copies those parameters
onto the Stripe checkout session metadata:

```js
const params = new URLSearchParams(location.search);
const session = await stripe.checkout.sessions.create({
  // ...
  metadata: {
    bba_campaign_id: params.get('bba_campaign_id') ?? '',
    utm_source: params.get('utm_source') ?? '',
    utm_campaign: params.get('utm_campaign') ?? '',
  },
});
```

Persist those values (session storage, or a hidden field) if the visitor
browses before buying, otherwise a second page view loses them.

Without hop two, revenue is recorded as `unattributed` rather than guessed at,
and the analyst raises an incident once more than 60% of revenue has no
channel. The optimizer then falls back to allocating on clicks, which is much
worse: clicks are cheap on the channels that convert worst.

## Stripe webhook

Point the webhook at `https://ops.bbanetwork.org/webhooks/stripe` and subscribe
to `checkout.session.completed`, `charge.refunded`, `invoice.paid` and
`charge.dispute.created`.

Signatures are verified with HMAC-SHA256 in constant time, and anything more
than five minutes old is rejected so a captured request cannot be replayed.
