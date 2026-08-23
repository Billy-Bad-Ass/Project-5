import type { Env } from '../env';
import { ConfigError } from '../lib/errors';
import { insert } from '../lib/db';
import { id } from '../lib/ids';
import { nowIso } from '../lib/time';

/**
 * Databento market data.
 *
 * BBA runs finance-adjacent offers, and demand for those tracks volatility.
 * The quant agent pulls daily bars, derives a couple of plain signals, and the
 * optimizer uses them to bias budget toward the days when the audience is
 * actually paying attention. Nothing here places a trade.
 *
 * Docs: databento.com/docs/api-reference-historical
 */
const HIST = 'https://hist.databento.com/v0';

function auth(env: Env): string {
  const key = env.DATABENTO_API_KEY;
  if (!key) throw new ConfigError('DATABENTO_API_KEY is not set');
  // Databento uses HTTP Basic with the API key as the username.
  return `Basic ${btoa(`${key}:`)}`;
}

export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Daily OHLCV bars. The API streams newline-delimited JSON, which is why this
 * parses line by line rather than calling res.json().
 */
export async function dailyBars(
  env: Env,
  opts: { dataset: string; symbols: string[]; start: string; end: string },
): Promise<Record<string, Bar[]>> {
  const body = new URLSearchParams({
    dataset: opts.dataset,
    symbols: opts.symbols.join(','),
    schema: 'ohlcv-1d',
    start: opts.start,
    end: opts.end,
    encoding: 'json',
  });

  const res = await fetch(`${HIST}/timeseries.get_range`, {
    method: 'POST',
    headers: {
      authorization: auth(env),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    throw new ConfigError(`Databento request failed: ${res.status}`, {
      body: (await res.text()).slice(0, 500),
    });
  }

  const text = await res.text();
  const out: Record<string, Bar[]> = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: DatabentoBar;
    try {
      record = JSON.parse(line) as DatabentoBar;
    } catch {
      continue;
    }
    const symbol = record.symbol ?? String(record.hd?.instrument_id ?? 'unknown');
    // Prices arrive as fixed-point integers scaled by 1e9.
    const scale = 1e9;
    const bar: Bar = {
      date: tsToDate(record.hd?.ts_event ?? record.ts_event),
      open: Number(record.open ?? 0) / scale,
      high: Number(record.high ?? 0) / scale,
      low: Number(record.low ?? 0) / scale,
      close: Number(record.close ?? 0) / scale,
      volume: Number(record.volume ?? 0),
    };
    (out[symbol] ??= []).push(bar);
  }
  for (const bars of Object.values(out)) bars.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/** Annualised realised volatility from close-to-close log returns. */
export function realizedVolatility(bars: Bar[], window = 20): number | null {
  const closes = bars.map((b) => b.close).filter((c) => c > 0);
  if (closes.length < window + 1) return null;
  const recent = closes.slice(-(window + 1));
  const returns: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    returns.push(Math.log(recent[i]! / recent[i - 1]!));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

/** Where today's volatility sits in its own recent history, 0 to 1. */
export function volatilityPercentile(bars: Bar[], lookback = 120, window = 20): number | null {
  if (bars.length < lookback) return null;
  const series: number[] = [];
  for (let end = window + 1; end <= bars.length; end++) {
    const vol = realizedVolatility(bars.slice(0, end), window);
    if (vol !== null) series.push(vol);
  }
  const current = series[series.length - 1];
  if (current === undefined || series.length < 5) return null;
  const below = series.filter((v) => v <= current).length;
  return Math.round((below / series.length) * 100) / 100;
}

export async function storeSignal(
  env: Env,
  signal: { dataset: string; symbol: string; signal: string; value: number; observedAt: string; raw?: unknown },
): Promise<void> {
  await insert(
    env,
    'market_signals',
    {
      id: id('sig'),
      dataset: signal.dataset,
      symbol: signal.symbol,
      signal: signal.signal,
      value: signal.value,
      observed_at: signal.observedAt,
      raw: JSON.stringify(signal.raw ?? {}).slice(0, 4000),
    },
    { orIgnore: true },
  );
}

function tsToDate(ts: string | number | undefined): string {
  if (ts === undefined) return nowIso().slice(0, 10);
  // Databento timestamps are nanoseconds since the epoch.
  const ms = Number(ts) / 1e6;
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : nowIso().slice(0, 10);
}

interface DatabentoBar {
  hd?: { ts_event?: string | number; instrument_id?: number };
  ts_event?: string | number;
  symbol?: string;
  open?: string | number;
  high?: string | number;
  low?: string | number;
  close?: string | number;
  volume?: string | number;
}
