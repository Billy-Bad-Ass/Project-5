import type { Env } from '../env';
import { first, run } from './db';
import { nowIso } from './time';

/** Runtime settings, resolvable in this order: D1 override, KV, env var. */
export interface RuntimeConfig {
  dryRun: boolean;
  requireHumanApproval: boolean;
  dailySpendCapCents: number;
  editorialMinScore: number;
  /** Channels the orchestrator is allowed to touch this cycle. */
  enabledChannels: string[];
  /** Pause everything without redeploying. */
  paused: boolean;
}

const CONFIG_KEY = 'runtime';

export async function loadConfig(env: Env): Promise<RuntimeConfig> {
  const overrides = await readOverrides(env);
  return {
    dryRun: pickBool(overrides.dryRun, env.DRY_RUN, true),
    requireHumanApproval: pickBool(
      overrides.requireHumanApproval,
      env.REQUIRE_HUMAN_APPROVAL,
      true,
    ),
    dailySpendCapCents: pickNum(
      overrides.dailySpendCapCents,
      env.DAILY_SPEND_CAP_CENTS,
      20_000,
    ),
    editorialMinScore: pickNum(overrides.editorialMinScore, env.EDITORIAL_MIN_SCORE, 78),
    enabledChannels: Array.isArray(overrides.enabledChannels)
      ? (overrides.enabledChannels as string[])
      : [],
    paused: pickBool(overrides.paused, undefined, false),
  };
}

async function readOverrides(env: Env): Promise<Record<string, unknown>> {
  // D1 wins so a guardrail trip inside a transaction is visible immediately.
  const row = await first<{ value: string }>(
    env,
    'SELECT value FROM settings WHERE key = ?',
    CONFIG_KEY,
  );
  if (row) {
    try {
      return JSON.parse(row.value) as Record<string, unknown>;
    } catch {
      /* fall through to KV */
    }
  }
  const kv = await env.CONFIG.get(CONFIG_KEY, 'json');
  return (kv as Record<string, unknown>) ?? {};
}

export async function saveConfig(
  env: Env,
  patch: Partial<RuntimeConfig>,
): Promise<RuntimeConfig> {
  const current = await readOverrides(env);
  const next = { ...current, ...patch };
  const value = JSON.stringify(next);
  await run(
    env,
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    CONFIG_KEY,
    value,
    nowIso(),
  );
  await env.CONFIG.put(CONFIG_KEY, value);
  return loadConfig(env);
}

function pickBool(override: unknown, envVar: string | undefined, fallback: boolean): boolean {
  if (typeof override === 'boolean') return override;
  if (envVar !== undefined) return envVar === 'true' || envVar === '1';
  return fallback;
}

function pickNum(override: unknown, envVar: string | undefined, fallback: number): number {
  if (typeof override === 'number' && Number.isFinite(override)) return override;
  const parsed = Number(envVar);
  return Number.isFinite(parsed) && envVar !== undefined ? parsed : fallback;
}
