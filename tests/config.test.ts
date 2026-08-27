import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Guards a failure mode that looks like success.
 *
 * Wrangler does not inherit bindings into a named [env.x]: d1_databases,
 * kv_namespaces, r2_buckets, queues, durable_objects and triggers all have to
 * be repeated or they silently disappear. A Worker deployed that way returns
 * 200 on /health right up until the first request that touches a binding, and
 * never fires a single cron.
 *
 * These assertions fail the build rather than letting that ship again.
 */
const raw = readFileSync('wrangler.toml', 'utf8');
// Strip comments so prose about a setting is never mistaken for the setting.
const toml = raw
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

describe('wrangler configuration', () => {
  it('declares every binding the Worker code reads off Env', () => {
    for (const binding of ['DB', 'CONFIG', 'CACHE', 'MEDIA', 'JOBS']) {
      expect(toml, `binding ${binding} is missing`).toMatch(
        new RegExp(`binding\\s*=\\s*"${binding}"`),
      );
    }
    expect(toml).toMatch(/name\s*=\s*"CAMPAIGN_ROOM"/);
    expect(toml).toMatch(/class_name\s*=\s*"CampaignRoom"/);
  });

  it('has a queue consumer, not just a producer', () => {
    // Without a consumer, jobs are enqueued and nothing ever runs them.
    expect(toml).toMatch(/\[\[queues\.producers\]\]/);
    expect(toml).toMatch(/\[\[queues\.consumers\]\]/);
    expect(toml).toMatch(/dead_letter_queue\s*=/);
  });

  it('has cron triggers', () => {
    expect(toml).toMatch(/\[triggers\]/);
    expect(toml).toMatch(/crons\s*=\s*\[/);
  });

  it('uses no named environment, so bindings cannot go missing', () => {
    // If a named environment is ever added, every binding block above has to be
    // repeated inside it. Until then, keep the surface at one environment.
    expect(toml).not.toMatch(/^\[env\./m);
  });

  it('carries no unreplaced resource ids', () => {
    // A placeholder here deploys a Worker bound to a database that does not
    // exist, which fails at the first query rather than at deploy time.
    expect(toml, 'setup.sh placeholder still in wrangler.toml').not.toMatch(/REPLACE_WITH_/);
    expect(toml).toMatch(/database_id\s*=\s*"[0-9a-f-]{36}"/);
    expect(toml.match(/^id\s*=\s*"[0-9a-f]{32}"$/gm)?.length, 'expected two KV namespace ids').toBe(2);
  });

  it('points PUBLIC_BASE_URL at a real reachable origin', () => {
    const value = toml.match(/PUBLIC_BASE_URL\s*=\s*"([^"]+)"/)?.[1];
    expect(value).toBeTruthy();
    expect(() => new URL(value!)).not.toThrow();
    expect(value, 'placeholder left in PUBLIC_BASE_URL').not.toMatch(/REPLACE|example\.com/i);
  });

  it('serves the console and the ad links from the custom domains', () => {
    expect(toml).toMatch(/pattern\s*=\s*"ops\.bbanetwork\.org"/);
    expect(toml).toMatch(/pattern\s*=\s*"go\.bbanetwork\.org"/);
    expect(toml.match(/custom_domain\s*=\s*true/g)?.length).toBe(2);
  });

  it('ships safe by default', () => {
    expect(toml).toMatch(/DRY_RUN\s*=\s*"true"/);
    expect(toml).toMatch(/REQUIRE_HUMAN_APPROVAL\s*=\s*"true"/);
  });

  it('caps daily spend at $25, and the cap only ever moves down', () => {
    // 2500 cents. The cap was cut from 20000 on 2026-08-24 and is a hard
    // ceiling, not a tuning knob: raising it is a human decision made in a
    // commit, where it shows up in review — never in a runtime override.
    const cap = Number(toml.match(/DAILY_SPEND_CAP_CENTS\s*=\s*"(\d+)"/)?.[1]);
    expect(cap).toBe(2500);
  });

  it('keeps the in-code fallback cap at or below the configured one', () => {
    // loadConfig falls back to a literal when the env var is missing. A
    // fallback above the configured cap would mean a half-configured deploy
    // spends MORE than a fully configured one.
    const source = readFileSync('src/lib/config.ts', 'utf8');
    const fallback = Number(source.match(/env\.DAILY_SPEND_CAP_CENTS,\s*([\d_]+),/)?.[1]?.replace(/_/g, ''));
    expect(fallback).toBeLessThanOrEqual(2500);
  });

  it('parses the declared crons out of wrangler.toml correctly', () => {
    // The first version of check-crons.mjs stopped parsing at the opening
    // bracket of `crons = [` and read five schedules as zero, failing the
    // deploy verify step against a Worker whose crons were all registered.
    // This runs the real script's parser against the real file, offline.
    const out = execFileSync('node', ['scripts/check-crons.mjs', '--print-declared'], {
      encoding: 'utf8',
    });
    const declared = JSON.parse(out) as string[];
    expect(declared).toHaveLength(5);
    expect(declared).toContain('*/5 * * * *');
    expect(declared).toContain('0 14 * * 1');
  });

  it('verifies cron registration after every deploy', () => {
    // scripts/check-crons.mjs compares wrangler.toml against the schedules
    // Cloudflare actually holds. If this step goes missing, a deploy that
    // silently dropped its triggers goes back to looking like success.
    const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
    expect(workflow).toContain('scripts/check-crons.mjs');
  });

  it('deploys the same environment the config describes', () => {
    const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
    expect(workflow).not.toContain('--env production');
  });
});

/**
 * Which plan a task sits in is a reliability decision, not a tidiness one.
 *
 * Every cron declared in wrangler.toml is registered with Cloudflare — the
 * suite above proves that — and four of the five have fired on time since
 * 2026-08-23. The weekly one has never fired at all, including on the Monday
 * it was first due.
 *
 * scout.research_offer is what records the claims a writer may not exceed, so
 * nothing in creative.ts can produce a line of copy until it has run. Holding
 * that behind the one trigger with no successful run on record is the bet these
 * tests exist to prevent someone quietly re-placing.
 */
describe('the plan that unblocks copy', () => {
  const now = '2026-08-27T13:00:00.000Z';

  it('researches the offer on the daily pass, not only the weekly one', async () => {
    const { planFor } = await import('../src/orchestrator/schedule');
    const daily = planFor('0 13 * * *', now);
    expect(daily).toBeDefined();
    expect(
      daily!.tasks.some((t) => t.agent === 'scout' && t.task === 'research_offer'),
    ).toBe(true);
  });

  it('still researches it weekly, so the wider refresh keeps its pair', async () => {
    const { planFor } = await import('../src/orchestrator/schedule');
    const weekly = planFor('0 14 * * 1', now);
    expect(weekly).toBeDefined();
    expect(
      weekly!.tasks.some((t) => t.agent === 'scout' && t.task === 'research_offer'),
    ).toBe(true);
  });

  it('deduplicates the daily research so a re-run costs one model call a day', async () => {
    const { planFor } = await import('../src/orchestrator/schedule');
    const daily = planFor('0 13 * * *', now);
    const scout = daily!.tasks.find((t) => t.agent === 'scout');
    expect(scout?.dedupe).toBeDefined();
    expect(scout!.dedupe!.length).toBeGreaterThan(0);
  });

  it('gives every cron in wrangler.toml a plan to run', async () => {
    // An expression registered with Cloudflare but absent from CRON_PLANS logs
    // "no plan for cron" and returns — a trigger that fires into nothing, which
    // reads in the console as an agent that simply never ran.
    const { CRON_PLANS } = await import('../src/orchestrator/schedule');
    const out = execFileSync('node', ['scripts/check-crons.mjs', '--print-declared'], {
      encoding: 'utf8',
    });
    for (const cron of JSON.parse(out) as string[]) {
      expect(Object.keys(CRON_PLANS)).toContain(cron);
    }
  });
});
