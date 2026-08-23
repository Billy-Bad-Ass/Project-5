# Architecture

## Why this shape

The system has to do two things that pull in opposite directions: run
continuously without supervision, and never do anything expensive or public
that a person did not sanction. Most of the design follows from holding both.

The resolution is that **agents propose and guardrails dispose**. An agent
never calls a platform API directly. It forms an intent, that intent is written
to an append-only `decisions` table, gates run, and only then does an adapter
make a call. `DRY_RUN` is therefore not a stub: the full reasoning path runs and
produces a real audit trail, only the final network call is withheld.

## The pieces

**One Worker, three entry points.** `fetch` serves the console, the admin API,
media and the Stripe webhook. `scheduled` handles cron. `queue` runs agent
jobs. Keeping them in one Worker means one deployment, one set of bindings, and
no cross-service auth to get wrong.

**D1 is the source of truth.** Campaigns, creatives, posts, metrics, decisions,
approvals, spend. Money is stored as integer cents with a currency code and
never as a float. Timestamps are ISO-8601 UTC strings, which sort correctly as
text in SQLite.

**KV is for things that can be stale.** Runtime config (with a D1 override that
wins, so a tripped guardrail is visible immediately rather than eventually) and
OAuth access tokens cached until just before expiry.

**R2 holds media.** Platforms fetch creative over the public internet rather
than accepting bytes, so objects are served back out through the Worker's
`/media` route. Keys are content hashes, which makes re-uploading the same file
free and makes keys unguessable.

**Queues are the agent bus.** Cron enqueues, the consumer runs one job per
message. Retries are the queue's job. Jobs carry an idempotency key derived
from their inputs, so a redelivery cannot double-post or double-spend.

**A Durable Object per campaign** serialises budget changes. D1 has no row
locks, so two optimizer passes landing together could both read the old budget
and both apply a raise. The object also caps changes per campaign per day,
which is the cheapest defence against an optimizer that oscillates.

## Request and job flow

```
cron ──> startRun ──> jobs table + Queue
                            │
                            v
                    handleQueue (one message = one job)
                            │
                     createContext(env, config, agent)
                            │
                            v
                       agent.tasks[task]
                            │
        ┌───────────────────┼───────────────────┐
        v                   v                   v
   ctx.decide()      ctx.requestApproval()   ctx.enqueue()
   (audit trail)     (blocks on a human)     (follow-on work)
                            │
                            v
                    guardrails: channel gate,
                    circuit breaker, budget gate,
                    anomaly detection, approval gate
                            │
                            v
                    platform adapter (or dry run)
```

## Why the optimizer has no model in it

Budget allocation is a multi-armed bandit. Thompson sampling has a closed-form
answer, and it handles the actual hard part: a channel with little data samples
from a wide posterior, so it occasionally wins and gets a chance to prove
itself, instead of being starved by a "pause anything under target ROAS" rule
before it has enough data to judge.

A language model asked to reallocate a budget would produce something plausible
and different every time. `allocate()` in `src/orchestrator/allocator.ts` is a
pure function seeded from the date, so the same numbers always produce the same
plan and any decision in the log can be reproduced.

The same reasoning applies to the editorial gate. Both are arithmetic, both are
unit-tested, and neither needs an API key.

Models are used for three things only: planning a campaign, writing copy, and
the daily narrative. All three are places where the output is language and a
human reviews it.

## Failure behaviour

| Failure | What happens |
|---|---|
| A platform returns 429 or 5xx | `apiFetch` retries with backoff, honours `Retry-After`, gives up after 3 |
| A platform returns 4xx | No retry. Retrying a malformed request only burns rate limit |
| A job throws | Requeued with exponential delay, up to `max_attempts`, then an incident |
| A credential fails | Account marked `needs_reauth`, incident opened, that channel stops |
| Spend reaches the cap | Circuit breaker refuses every spend action for the rest of the UTC day |
| Spend paces above 2.5x median | Anomaly incident, spend actions on that channel refused |
| A creative fails the gate twice | Parked as `needs_revision` with the findings, never published |
| An approval goes unanswered | Expires after 72 hours, the guardian records it |
| The orchestrator is paused | Runs skip, in-flight jobs defer 15 minutes and retry |

## What is deliberately not here

**Video rendering.** A Worker has no ffmpeg and a hard CPU budget. Pretending
otherwise would produce a pipeline that silently does not work. The producer
agent records a render request instead, an external worker polls
`GET /api/render-queue`, does the work, and uploads the result to
`POST /api/media`. The referenced `claude-video` and `MoneyPrinterV2` projects
are the right shape for that external worker.

**Platform scraping.** Everything here uses official APIs. Scraping a platform
you are also advertising on is how accounts get banned. The scout fetches only
pages it is pointed at, and honours robots.txt.

**Multi-tenant anything.** This runs one business. Adding tenancy would mean a
tenant column on every table and a much more careful auth story, and would buy
nothing today.
