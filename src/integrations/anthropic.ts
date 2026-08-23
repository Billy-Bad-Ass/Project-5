import type { Env } from '../env';
import { apiFetch } from '../lib/http';
import { ConfigError } from '../lib/errors';

/**
 * Claude, used by the agents that have to write or judge language: the
 * strategist, the creative and the analyst's narrative summary.
 *
 * Everything that can be decided arithmetically (budget allocation, guardrails,
 * the editorial score) is decided in code instead. A model is only asked for
 * the parts that genuinely need one.
 */
const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

export const MODELS = {
  /** Copywriting and strategy, where quality is the point. */
  writer: 'claude-opus-5',
  /** Classification, extraction, summarising. Cheaper and fast enough. */
  worker: 'claude-sonnet-5',
} as const;

export interface CompleteOptions {
  system: string;
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** JSON schema the reply must satisfy, enforced via a forced tool call. */
  schema?: Record<string, unknown>;
}

interface AnthropicResponse {
  content?: ({ type: 'text'; text: string } | { type: 'tool_use'; input: unknown })[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export async function complete(env: Env, opts: CompleteOptions): Promise<string> {
  const body = baseBody(opts);
  const res = await request(env, body);
  const text = res.content?.find((c) => c.type === 'text');
  return text && text.type === 'text' ? text.text : '';
}

/**
 * Ask for structured output. The schema is passed as a tool and the model is
 * forced to call it, so the reply parses or the call fails loudly.
 */
export async function completeJson<T>(env: Env, opts: CompleteOptions): Promise<T> {
  if (!opts.schema) throw new ConfigError('completeJson needs a schema');
  const body = {
    ...baseBody(opts),
    tools: [
      {
        name: 'respond',
        description: 'Return the result in the required shape.',
        input_schema: opts.schema,
      },
    ],
    tool_choice: { type: 'tool', name: 'respond' },
  };
  const res = await request(env, body);
  const call = res.content?.find((c) => c.type === 'tool_use');
  if (!call || call.type !== 'tool_use') {
    throw new ConfigError('model did not return structured output');
  }
  return call.input as T;
}

function baseBody(opts: CompleteOptions): Record<string, unknown> {
  return {
    model: opts.model ?? MODELS.writer,
    max_tokens: opts.maxTokens ?? 2048,
    temperature: opts.temperature ?? 1,
    system: opts.system,
    messages: [{ role: 'user', content: opts.prompt }],
  };
}

async function request(env: Env, body: Record<string, unknown>): Promise<AnthropicResponse> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new ConfigError('ANTHROPIC_API_KEY is not set: run wrangler secret put ANTHROPIC_API_KEY');
  }
  return apiFetch<AnthropicResponse>(API, {
    channel: 'anthropic',
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    timeoutMs: 90_000,
    attempts: 2,
  });
}

/** True when a model is reachable at all. Used by the health endpoint. */
export function hasModelAccess(env: Env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}
