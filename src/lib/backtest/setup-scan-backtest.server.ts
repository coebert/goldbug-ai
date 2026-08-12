import { getDailyCandles } from "@/lib/market-data.server";
import { scanCandidates } from "@/lib/setup-scan.server";
import {
  DEFAULT_BACKTEST_CONFIG,
  runSetupBacktest,
  type BacktestConfig,
  type SetupBacktestReport,
} from "@/lib/backtest/setup-scan-backtest";
import type { ScanCandle } from "@/lib/setup-scan";

/** Load candle history for the study, tolerating symbols with thin coverage. */
async function loadHistories(symbols: string[], days: number) {
  const out: { symbol: string; candles: ScanCandle[] }[] = [];
  const errors: string[] = [];
  const batchSize = 5;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (symbol) => {
        try {
          const candles = await getDailyCandles(symbol, days);
          out.push({
            symbol,
            candles: candles.map((k) => ({
              date: k.date,
              close: Number(k.close),
              high: Number(k.high ?? k.close),
              low: Number(k.low ?? k.close),
              volume: Number(k.volume ?? 0),
            })),
          });
        } catch (err) {
          errors.push(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
  }
  return { histories: out, errors };
}

export type SetupBacktestRun = SetupBacktestReport & {
  errors: string[];
  lookbackDays: number;
};

/**
 * Replay the post-reclaim archetype across historical tickers to measure how
 * often it produced profitable entries versus froth.
 */
export async function runSetupBacktestAcrossMarket(opts: {
  limit?: number;
  lookbackDays?: number;
  config?: Partial<BacktestConfig>;
} = {}): Promise<SetupBacktestRun> {
  const limit = Math.min(Math.max(opts.limit ?? 24, 4), 60);
  const lookbackDays = Math.min(Math.max(opts.lookbackDays ?? 1500, 400), 3000);
  const cfg: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, ...opts.config };

  const symbols = scanCandidates().slice(0, limit).map((c) => c.symbol);
  const { histories, errors } = await loadHistories(symbols, lookbackDays);
  const report = runSetupBacktest(histories, cfg);

  return { ...report, errors: errors.slice(0, 5), lookbackDays };
}
