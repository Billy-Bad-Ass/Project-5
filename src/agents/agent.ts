import type { AgentContext } from '../orchestrator/context';
import type { AgentId, AgentResult } from '../types';

export type TaskHandler = (
  ctx: AgentContext,
  payload: Record<string, unknown>,
) => Promise<AgentResult>;

export interface Agent {
  id: AgentId;
  /** One line, shown in the console and in the orchestrator's run summary. */
  describe: string;
  tasks: Record<string, TaskHandler>;
}

export function ok(summary: string, extra: Partial<AgentResult> = {}): AgentResult {
  return { ok: true, summary, ...extra };
}

export function failed(summary: string, extra: Partial<AgentResult> = {}): AgentResult {
  return { ok: false, summary, ...extra };
}

/** Read a payload field with a type check rather than a cast. */
export function str(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function num(payload: Record<string, unknown>, key: string): number | undefined {
  const v = payload[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const parsed = Number(v);
  return Number.isFinite(parsed) && v !== undefined && v !== null && v !== '' ? parsed : undefined;
}

export function strList(payload: Record<string, unknown>, key: string): string[] {
  const v = payload[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}
