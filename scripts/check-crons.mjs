#!/usr/bin/env node
/**
 * Assert the deployed Worker's cron triggers match wrangler.toml.
 *
 * A deployed Worker is not a running one. Every agent cycle in this system
 * starts from a cron trigger, and a deploy that silently loses them — the
 * classic way being a named [env.x] that does not repeat [triggers] — leaves a
 * Worker that returns 200 on /health while doing nothing at all, forever.
 * This script makes that failure loud: it reads the crons wrangler.toml
 * declares, reads the schedules Cloudflare actually has registered for the
 * script, and exits non-zero unless they are the same set.
 *
 * Read-only: one GET against the Workers schedules API. Needs
 * CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, exactly like the deploy
 * that precedes it.
 */
import { readFileSync } from 'node:fs';

const SCRIPT_NAME = 'bba-growth-os';

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required.');
  process.exit(1);
}

// The declared crons, from the same file the deploy read. Comments stripped so
// prose about a cron is never mistaken for one, matching tests/config.test.ts.
const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
  .split('\n')
  .map((line) => line.replace(/#.*$/, ''))
  .join('\n');
const triggersBlock = toml.match(/\[triggers\][^[]*/)?.[0] ?? '';
const declared = [...triggersBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
if (declared.length === 0) {
  console.error('wrangler.toml declares no cron triggers — nothing would ever run.');
  process.exit(1);
}

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${SCRIPT_NAME}/schedules`,
  { headers: { Authorization: `Bearer ${token}` } },
);
const body = await res.json();
if (!res.ok || !body.success) {
  console.error(`Could not read schedules for ${SCRIPT_NAME}:`, JSON.stringify(body.errors ?? body));
  process.exit(1);
}

const registered = (body.result?.schedules ?? []).map((s) => s.cron).sort();

const missing = declared.filter((c) => !registered.includes(c));
const extra = registered.filter((c) => !declared.includes(c));

console.log(`declared:   ${declared.join('  ') || '(none)'}`);
console.log(`registered: ${registered.join('  ') || '(none)'}`);

if (missing.length > 0 || extra.length > 0) {
  if (missing.length > 0) console.error(`MISSING from Cloudflare: ${missing.join('  ')}`);
  if (extra.length > 0) console.error(`registered but not declared: ${extra.join('  ')}`);
  console.error('The deployed Worker will not run the schedule the repo describes.');
  process.exit(1);
}

console.log(`All ${declared.length} cron triggers are registered.`);
