import { all, first } from '../lib/db';
import { daysAgoUtc, utcDate } from '../lib/time';
import {
  dailyBars,
  realizedVolatility,
  storeSignal,
  volatilityPercentile,
} from '../integrations/databento';
import { type Agent, num, ok, strList } from './agent';

/**
 * The quant pulls market data from Databento and turns it into two plain
 * signals the rest of the system can act on.
 *
 * The reason this exists: demand for finance-adjacent offers is not flat. It
 * tracks volatility. Spending the same amount on a dead tape as on a violent
 * one wastes budget on the dead days. Nothing here places a trade or gives
 * financial advice, it only times spend.
 */
const DEFAULT_SYMBOLS = ['SPY', 'QQQ'];
const DEFAULT_DATASET = 'XNAS.ITCH';

export const quant: Agent = {
  id: 'quant',
  describe: 'Pulls Databento bars and derives volatility signals used to time spend.',

  tasks: {
    async refresh_signals(ctx, payload) {
      if (!ctx.env.DATABENTO_API_KEY) {
        return ok('skipped, DATABENTO_API_KEY is not set');
      }
      const symbols = strList(payload, 'symbols').length
        ? strList(payload, 'symbols')
        : DEFAULT_SYMBOLS;
      const lookbackDays = num(payload, 'lookbackDays') ?? 200;
      const dataset = DEFAULT_DATASET;

      let bars: Record<string, import('../integrations/databento').Bar[]>;
      try {
        bars = await dailyBars(ctx.env, {
          dataset,
          symbols,
          start: daysAgoUtc(lookbackDays),
          end: utcDate(),
        });
      } catch (err) {
        await ctx.incident({
          severity: 'warn',
          code: 'databento_fetch_failed',
          message: String(err).slice(0, 300),
          context: { symbols, dataset },
        });
        return ok(`databento fetch failed: ${String(err).slice(0, 150)}`);
      }

      const observedAt = `${utcDate()}T00:00:00.000Z`;
      const stored: Record<string, { vol: number | null; percentile: number | null }> = {};

      for (const [symbol, series] of Object.entries(bars)) {
        const vol = realizedVolatility(series, 20);
        const percentile = volatilityPercentile(series, 120, 20);
        stored[symbol] = { vol, percentile };

        if (vol !== null) {
          await storeSignal(ctx.env, {
            dataset,
            symbol,
            signal: 'realized_vol_20d',
            value: vol,
            observedAt,
            raw: { bars: series.length },
          });
        }
        if (percentile !== null) {
          await storeSignal(ctx.env, {
            dataset,
            symbol,
            signal: 'vol_percentile_120d',
            value: percentile,
            observedAt,
          });
        }
      }

      await ctx.decide({
        agent: 'quant',
        action: 'refresh_market_signals',
        rationale: `refreshed volatility signals for ${Object.keys(stored).join(', ')}`,
        evidence: stored,
      });

      return ok(`refreshed signals for ${Object.keys(stored).length} symbols`, {
        data: { signals: stored },
      });
    },

    /**
     * A multiplier the optimizer can apply to the day's budget. Deliberately
     * narrow: between 0.8 and 1.25, so a bad signal cannot do much damage.
     */
    async spend_bias(ctx, payload) {
      const symbol = strList(payload, 'symbols')[0] ?? DEFAULT_SYMBOLS[0]!;
      const row = await first<{ value: number; observed_at: string }>(
        ctx.env,
        `SELECT value, observed_at FROM market_signals
          WHERE symbol = ? AND signal = 'vol_percentile_120d'
          ORDER BY observed_at DESC LIMIT 1`,
        symbol,
      );
      if (!row) return ok('no volatility signal stored yet, bias is 1.0', { data: { bias: 1 } });

      const age = Date.now() - new Date(row.observed_at).getTime();
      if (age > 3 * 86_400_000) {
        return ok('signal is stale, bias is 1.0', { data: { bias: 1, stale: true } });
      }

      // Percentile 0.5 is neutral. Clamp hard: this nudges, it does not steer.
      const bias = Math.max(0.8, Math.min(1.25, 1 + (row.value - 0.5) * 0.5));
      return ok(`bias ${bias.toFixed(2)} from ${symbol} volatility percentile ${row.value}`, {
        data: { bias, symbol, percentile: row.value },
      });
    },

    /** Everything stored, for the console. */
    async signals(ctx) {
      const rows = await all<{ symbol: string; signal: string; value: number; observed_at: string }>(
        ctx.env,
        `SELECT symbol, signal, value, observed_at FROM market_signals
          ORDER BY observed_at DESC LIMIT 50`,
      );
      return ok(`${rows.length} signals`, { data: { signals: rows } });
    },
  },
};
