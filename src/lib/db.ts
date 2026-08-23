import type { Env } from '../env';
import { nowIso } from './time';

/**
 * Thin typed helpers over D1. Deliberately not an ORM: the queries in this
 * project are simple, and hand-written SQL keeps the indexes honest.
 */

export async function all<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  const res = await env.DB.prepare(sql).bind(...binds).all<T>();
  return res.results ?? [];
}

export async function first<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T | null> {
  return (await env.DB.prepare(sql).bind(...binds).first<T>()) ?? null;
}

export async function run(env: Env, sql: string, ...binds: unknown[]): Promise<D1Result> {
  return env.DB.prepare(sql).bind(...binds).run();
}

export async function batch(env: Env, statements: D1PreparedStatement[]): Promise<void> {
  if (statements.length === 0) return;
  await env.DB.batch(statements);
}

/** INSERT built from an object. Values are bound, never interpolated. */
export function insertStmt(
  env: Env,
  table: string,
  row: Record<string, unknown>,
  opts: { orIgnore?: boolean } = {},
): D1PreparedStatement {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const verb = opts.orIgnore ? 'INSERT OR IGNORE' : 'INSERT';
  const sql = `${verb} INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
  return env.DB.prepare(sql).bind(...cols.map((c) => normalize(row[c])));
}

export async function insert(
  env: Env,
  table: string,
  row: Record<string, unknown>,
  opts: { orIgnore?: boolean } = {},
): Promise<void> {
  await insertStmt(env, table, row, opts).run();
}

/** UPDATE ... WHERE id = ?, stamping updated_at when the table has one. */
export function updateStmt(
  env: Env,
  table: string,
  id: string,
  patch: Record<string, unknown>,
  opts: { touch?: boolean } = { touch: true },
): D1PreparedStatement {
  const body = opts.touch === false ? patch : { ...patch, updated_at: nowIso() };
  const cols = Object.keys(body);
  const sets = cols.map((c) => `${c} = ?`).join(', ');
  return env.DB.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`).bind(
    ...cols.map((c) => normalize(body[c])),
    id,
  );
}

export async function update(
  env: Env,
  table: string,
  id: string,
  patch: Record<string, unknown>,
  opts: { touch?: boolean } = { touch: true },
): Promise<void> {
  await updateStmt(env, table, id, patch, opts).run();
}

/** D1 binds only null, number, string, ArrayBuffer. Everything else is JSON. */
function normalize(value: unknown): string | number | null | ArrayBuffer {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return value;
  return JSON.stringify(value);
}

/** Parse a TEXT column that holds JSON, falling back rather than throwing. */
export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
