# Operations runbook

## Going live

The system ships with two safeties on. Take them off in this order, not at once.

1. **Watch it in dry run for a few days.** Everything runs: agents plan, copy
   gets written and scored, the optimizer produces allocations. Nothing is sent
   anywhere. Read the Decisions tab. If the decisions look wrong, they would
   have been wrong live.
2. **Turn off dry run.** Overview tab, "Toggle dry run". Approval-required is
   still on, so nothing happens without you clicking Approve. This is the state
   to run in for the first few weeks.
3. **Optionally turn off approval-required.** Only after you have seen enough
   approvals to know what it proposes. Even then, high-risk decisions
   (activating spend, a budget rise over 1.5x, a new campaign) still require a
   human, because `approvalGate` treats `risk: 'high'` as non-negotiable.

`DAILY_SPEND_CAP_CENTS` is the real backstop. Set it to a number you would not
mind losing in a day, and raise it slowly.

## Daily

The daily cron does this for you at 13:00 UTC. Check the Overview tab for:

- **Waiting on you.** The approvals queue is the only thing that blocks the
  system from working.
- **Open incidents.** An account in `needs_reauth` stops that channel entirely.
- **Today's note.** A short written read from the analyst, generated from
  computed figures it is not allowed to invent.

## When something goes wrong

### An account stops working

The guardian marks it `needs_reauth` and opens an incident. Tokens expire:
Instagram long-lived tokens last 60 days, Threads 60 days, most OAuth refresh
tokens last until revoked.

```bash
npx wrangler secret put <SECRET_NAME>       # paste the new token
curl -X POST https://ops.bbanetwork.org/api/agents/guardian/health_check \
  -H "authorization: Bearer $ADMIN_TOKEN"
```

A successful verify flips the account back to `active` on its own.

### Spend is higher than expected

The circuit breaker trips at the cap and every spend action is refused from
that point in the UTC day. To stop everything immediately:

```bash
curl -X POST https://ops.bbanetwork.org/api/config \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"paused":true}'
```

That halts new work at the orchestrator and defers in-flight jobs. It does not
pause live ad sets on the platforms, because that needs API calls that the
pause switch itself blocks. To actually stop delivery, pause the ad sets in the
platform UI, or unpause, set the cap to zero, and let the optimizer's prune
pass take them down.

### A post failed

Posts retry twice with a 15 minute gap, then go to `failed` and open an
incident. Check `last_error` on the Content tab. Common causes: media still
processing (Instagram Reels, X video), an expired token, a missing subreddit on
Reddit, or copy over a channel's character limit that was edited by hand after
it passed the gate.

To retry a failed post, set it back to `scheduled`:

```bash
curl -X PATCH https://ops.bbanetwork.org/api/creatives/<creative id> \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"status":"approved"}'
```

The `PATCH` re-runs the editorial gate automatically, so a hand edit cannot
sneak past it.

### Copy keeps getting parked

`needs_revision` after two revision rounds usually means one of three things:

- The `provenClaims` list is empty, so the writer has no facts and reaches for
  adjectives. Run the scout: `POST /api/agents/scout/research_offer`.
- The banned phrase list is too aggressive for the channel. Edit it at
  `GET/POST /api/voice`.
- `editorialMinScore` is set too high for a 280-character channel, where a
  single finding is a large share of the score. 78 is a reasonable bar; above
  85 gets hard on short copy.

### The optimizer is not moving anything

It only acts on moves of at least 10% or 100 cents, whichever is larger, and it
holds any channel inside its 3-day learning phase. With no conversion data it
splits evenly and says so in the reason field. Check with a dry preview:

```bash
curl -X POST https://ops.bbanetwork.org/api/agents/optimizer/preview \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{}'
```

### Revenue is not attributed

Check that the landing page writes `bba_campaign_id` or `utm_source` onto the
Stripe checkout session metadata. Without it every sale is `unattributed` and
the optimizer is allocating on clicks, not money. See
[connecting-accounts.md](connecting-accounts.md).

## Useful calls

```bash
export A="authorization: Bearer $ADMIN_TOKEN"
W=https://ops.bbanetwork.org

curl -H "$A" $W/api/status                       # everything at a glance
curl -H "$A" $W/api/approvals                    # the queue
curl -H "$A" $W/api/performance?days=14          # ROAS by channel
curl -H "$A" $W/api/decisions?days=3             # what the agents decided and why
curl -H "$A" $W/api/jobs                         # recent job outcomes
curl -H "$A" -X POST $W/api/run                  # run a full cycle now
curl -H "$A" -X POST $W/api/agents/analyst/sync_metrics \
     -H 'content-type: application/json' -d '{"days":7}'
```

Any agent task can be run on demand at
`POST /api/agents/<agent>/<task>`. `GET /api/agents` lists them all.

## Logs

`[observability] enabled = true` in `wrangler.toml` sends structured logs to
Workers Logs. Every line is JSON with `run_id`, `job_id`, `agent` and `channel`
where they apply, so filtering by a single run is straightforward:

```bash
npx wrangler tail --format=pretty
```

## Backups

D1 holds everything that is not a secret or a media file.

```bash
npx wrangler d1 export bba-growth-os --remote --output backup-$(date +%F).sql
```

Worth doing before a schema migration, and worth putting on a schedule once
there is real history in there. Media in R2 is content-addressed, so re-uploading
the same file is a no-op.
