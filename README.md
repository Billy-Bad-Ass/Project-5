# BBA Network Growth OS

Agent-orchestrated paid ads and organic publishing for BBA Network, running
entirely on Cloudflare.

One Worker holds the whole system: an operator console, an admin API, ten
agents, adapters for nine social platforms and five ad platforms, Stripe
revenue attribution, and Databento market signals. Cron triggers drive it
without anyone pressing a button.

Two things are deliberately not automatic. **Nothing spends money and nothing
gets published until a human approves it**, and **no copy ships until it clears
a deterministic editorial gate**. Both are on by default and both can be turned
off, once you trust it.

## What it does

- **Publishes organic content** to TikTok, Instagram, Threads, Facebook, X,
  YouTube, Pinterest, LinkedIn and Reddit through their official APIs.
- **Buys and manages ads** on Meta (Facebook and Instagram placements), TikTok,
  Google (Search, Display, YouTube), Pinterest and Snapchat.
- **Reallocates budget on its own** every six hours using Thompson sampling
  over real conversion data, with a floor, a share ceiling, a per-cycle move
  limit, and a protected learning phase for new channels.
- **Joins Stripe revenue back to ad spend** so the number driving decisions is
  return on ad spend, not clicks.
- **Refuses to publish AI slop.** Every draft is scored against 29 deterministic
  rules before a human ever sees it.

## The anti-slop gate

The rules come from Wikipedia's [Signs of AI
writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), by way
of the [humanizer](https://github.com/blader/humanizer) skill, encoded as
regular expressions in `src/editorial/patterns.ts`.

The loop in `src/agents/creative.ts` is: draft, lint, revise, lint again. A
revision is only kept if it scores better than what it replaced. Copy that
still cannot clear the bar is parked as `needs_revision` with the findings
attached, rather than pushed through at a lower threshold.

Some findings block outright regardless of score: a vague source
("studies show"), chatbot residue ("I hope this helps"), an unfilled
placeholder, an income claim on an ad. Those are not style problems, they are
things that get an account banned or a business sued.

No model grades its own work anywhere in that loop. The gate is arithmetic, so
the same draft always gets the same verdict and the reviser gets a specific list
of what to change.

The other half is `src/agents/scout.ts`, which reads your actual landing page
and records what it factually claims. Writers may not exceed that list. Slop
usually comes from having nothing real to say.

## Architecture

```
Cron triggers ──> orchestrator ──> Queue ──> agents ──> platform adapters
                       │                        │
                       │                        ├─> guardrails (spend caps, circuit breaker)
                       │                        ├─> editorial gate (deterministic)
                       │                        └─> approvals (human)
                       └─> D1 (campaigns, creatives, posts, metrics, decisions)
                           KV (config, token cache)  R2 (media)  DO (per-campaign locks)
```

| Agent | Job |
|---|---|
| `strategist` | Plans what to run and where. Produces drafts, never live campaigns. |
| `scout` | Reads the offer page, records the claims writers may use. |
| `creative` | Writes copy, holds it against the editorial gate. |
| `producer` | Files media into R2 and attaches it to the right creative. |
| `publisher` | Publishes approved posts on schedule. Never edits them. |
| `mediabuyer` | Creates and edits ad entities. Everything starts paused. |
| `optimizer` | Reallocates budget, pauses proven losers. No model involved. |
| `analyst` | Syncs metrics, joins Stripe revenue, writes the daily note. |
| `guardian` | Checks credentials and spend. The agent that says no. |
| `quant` | Databento volatility signals used to time spend. |

Cron schedule (all UTC, defined in `wrangler.toml` and mapped in
`src/orchestrator/schedule.ts`):

| Cron | What runs |
|---|---|
| `*/5 * * * *` | Publish anything due, drain delayed jobs |
| `15 * * * *` | Sync platform metrics and Stripe revenue, audit |
| `30 */6 * * *` | Reallocate budget, pause losers |
| `0 13 * * *` | Health check, report, refill the creative pipeline |
| `0 14 * * 1` | Portfolio review, refresh voice exemplars |

A test in `tests/lib.test.ts` fails the build if a cron has no plan behind it,
or a plan references an agent task that does not exist.

## Quickstart

Requires the Workers Paid plan ($5/month) for Queues, Durable Objects and cron
triggers.

```bash
npm install
bash scripts/setup.sh          # creates D1, KV, R2, Queues; prints the ids
# paste the printed ids into wrangler.toml
npm run db:migrate
npm run seed:local             # optional starter offer and voice profile
bash scripts/push-secrets.sh   # reads each value from your terminal, never a file
npm run deploy
```

Then open <https://ops.bbanetwork.org>, paste your `ADMIN_TOKEN`, and connect
accounts on the Accounts tab. Put each credential in a Worker secret first; the
console only stores the *name* of the secret, never the token.

### Domains

Two custom domains on `bbanetwork.org`, both created automatically on deploy:

| Host | Serves |
|---|---|
| `ops.bbanetwork.org` | Console, admin API, media, Stripe webhook |
| `go.bbanetwork.org` | Tracked ad links (`/go/<offer-slug>`) |

The apex is left alone for the marketing site. Media has to be served from a
real origin because platforms fetch creative themselves rather than accepting
bytes, which is what `PUBLIC_BASE_URL` is for.

Ads point at `go.` rather than at the landing page directly, so the click
carries the channel, campaign and creative through to the Stripe checkout
session. That is the whole basis of attribution, and without it the optimizer
allocates on clicks instead of money. See
[docs/connecting-accounts.md](docs/connecting-accounts.md#stripe-attribution).

There is one environment, not a dev/prod split. Wrangler does not inherit
bindings into a named `[env.x]`, so a second environment means repeating every
D1, KV, R2, queue, Durable Object and cron block or watching them silently
disappear. `tests/config.test.ts` fails the build if that is ever reintroduced.

Because Wrangler creates the DNS records and certificates itself, the API token
used by CI needs more than the default Workers scope:

| Permission | Why |
|---|---|
| Account / Workers Scripts / Edit | Deploy the Worker |
| Account / Workers KV Storage / Edit | Bind the namespaces |
| Account / Workers R2 Storage / Edit | Bind the bucket |
| Account / D1 / Edit | Run migrations |
| Account / Queues / Edit | Create and bind the job queue |
| Zone / Workers Routes / Edit | Attach `ops.` and `go.` |
| Zone / DNS / Edit | Create the two records |

Scope the zone permissions to `bbanetwork.org`, and store the token as the
`CLOUDFLARE_API_TOKEN` repository secret alongside `CLOUDFLARE_ACCOUNT_ID`. A
token missing the last two rows deploys the Worker fine and then fails on the
route, which reads like a broken deploy but is only a permissions gap.

See [docs/connecting-accounts.md](docs/connecting-accounts.md) for what each
platform needs, including which ones require app review before they will let
you post.

## Safety model

| Control | Default | Where |
|---|---|---|
| `DRY_RUN` | on | Every mutation is logged, nothing is sent |
| `REQUIRE_HUMAN_APPROVAL` | on | Campaigns, budget rises and copy all need a person |
| `DAILY_SPEND_CAP_CENTS` | 20000 ($200) | Hard ceiling across every channel |
| Spend circuit breaker | always | Trips when actual spend reaches the cap |
| Spend anomaly detection | always | Trips at 2.5x the trailing median pace |
| Everything created upstream | paused | Activation is a separate approved step |
| Editorial gate | 78/100 | Copy below the bar cannot be scheduled |
| Budget changes per campaign per day | 8 | Enforced by a Durable Object |

Approval is checked against the database at the moment of action, not passed in
a job payload, so a replayed queue message cannot claim an approval it never
got.

Going live means flipping two switches on the Overview tab: turn off dry run,
then turn off approval-required only once you have watched it for a while.
Leave the approval gate on for anything that speaks in public.

## Repository layout

```
src/
  editorial/     the anti-slop gate: patterns, scorer, brand voice
  platforms/     one adapter per channel, behind a shared contract
  integrations/  Stripe, Anthropic, Databento
  agents/        the ten agents
  orchestrator/  context, guardrails, allocator, schedule, dispatch, DO
  api/           routes, auth, approval flow, tracked ad links
  ui/            the operator console, one self-contained page
db/migrations/   D1 schema
docs/            architecture, account setup, operations runbook
```

## Cost

- Cloudflare Workers Paid: $5/month, covers Workers, Queues, DO, cron, D1 and
  KV at this volume. R2 is billed on storage and is a few cents at this size.
- Anthropic API: pay per token. Only the strategist, creative and the daily
  narrative call a model. Allocation, guardrails and the editorial gate do not.
- Databento: pay per query. Optional. Skip the key and the quant agent
  no-ops.
- Ad spend: whatever you set `DAILY_SPEND_CAP_CENTS` to, and not a cent more.
- Custom domains and the DNS in front of them are included with the zone.

## Development

```bash
npm run typecheck
npm test          # 52 tests, no network
npm run dev
npm run check     # both
```

## Credit

Built with reference to these repositories, named in the original brief:
[public-apis](https://github.com/public-apis/public-apis),
[Scrapling](https://github.com/D4Vinci/Scrapling),
[Agent-Reach](https://github.com/Panniantong/Agent-Reach),
[claude-video](https://github.com/bradautomates/claude-video),
[humanizer](https://github.com/blader/humanizer),
[MoneyPrinterV2](https://github.com/FujiwaraChoki/MoneyPrinterV2),
[awesome-scalability](https://github.com/binhnguyennus/awesome-scalability),
[twenty](https://github.com/twentyhq/twenty),
[claude-ads](https://github.com/AgriciDaniel/claude-ads).

The editorial gate is a direct port of humanizer's pattern list. The
"everything stays a draft until the mutation gate passes" posture is borrowed
from claude-ads.
