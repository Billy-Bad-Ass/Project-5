import { readFileSync } from 'node:fs';
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
