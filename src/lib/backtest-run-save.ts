// Standalone helper for persisting a completed backtest run to the
// server-side history table. Extracted out of
// `backtest-run-history-card.tsx` so imperative callers (like the
// portfolio route) can trigger a save without pulling the heavy
// history-card bundle (recharts, table rendering, etc.) into the main
// route chunk. The card component subscribes to the same dispatched
// window event to refresh its list.

import { saveBacktestRun as saveBacktestRunFn } from "@/lib/backtest-runs.functions";
import type { BacktestMetrics } from "@/lib/backtest-metrics";

export type BacktestEquityPoint = { snapshot_date: string; total_value: number };

export async function saveRun(record: {
  portfolioId: string;
  riskLevel?: string;
  days: number;
  ranAt?: string;
  metrics: BacktestMetrics;
  equity?: BacktestEquityPoint[];
}) {
  await saveBacktestRunFn({
    data: {
      portfolioId: record.portfolioId,
      riskLevel: record.riskLevel ?? null,
      days: record.days,
      ranAt: record.ranAt,
      metrics: record.metrics as unknown as Parameters<typeof saveBacktestRunFn>[0]["data"]["metrics"],
      equity: (record.equity ?? null) as unknown as Parameters<typeof saveBacktestRunFn>[0]["data"]["equity"],
    },
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("aegis:backtest-runs-updated", { detail: record.portfolioId }),
    );
  }
}
