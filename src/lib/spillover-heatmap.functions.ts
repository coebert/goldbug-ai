// Server function behind the interactive cluster × cluster spillover heatmap.
//
// The CLI (`--spillover`) prints an ASCII version of this matrix from a freshly
// fetched tape. In the app the same estimator runs against `price_cache`, so the
// heatmap describes the history the engine itself trades on.
//
// Auth: requireSupabaseAuth. `price_cache` is shared public reference data, read
// through the caller's RLS-scoped client — no admin client is needed.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  clusterSpilloverMatrix,
  type SpilloverCell,
} from "@/lib/execution-cluster-spillover";
import { marketVolZScores } from "@/lib/execution-correlated-shocks";
import { defaultCluster } from "@/lib/execution-correlation-structures";

/** Wide enough to show block structure, small enough to load quickly. */
export const DEFAULT_SPILLOVER_SYMBOLS = [
  "SPY", "QQQ", "IWM",
  "AAPL", "MSFT", "NVDA",
  "JPM", "XOM", "JNJ", "KO", "PG",
  "GLD", "TLT",
] as const;

const InputSchema = z.object({
  symbols: z.array(z.string().min(1).max(24)).min(2).max(40).optional(),
  lookbackDays: z.number().int().min(120).max(4000).default(1500),
  window: z.number().int().min(10).max(400).default(60),
  step: z.number().int().min(1).max(60).default(5),
  basis: z.enum(["returns", "absReturns"]).default("absReturns"),
  stressZ: z.number().min(0).max(6).default(1.5),
  minStressShare: z.number().min(0).max(1).default(0.25),
});

export type SpilloverHeatmapInput = z.input<typeof InputSchema>;

/** Transport shape: `Map` and `NaN` do not survive JSON, so both are flattened. */
export type SpilloverHeatmapCell = {
  calm: number | null;
  stress: number | null;
  delta: number | null;
  pairs: number;
  calmWindows: number;
  stressWindows: number;
};

export type SpilloverHeatmapResponse = {
  clusters: string[];
  cells: SpilloverHeatmapCell[][];
  members: { cluster: string; symbols: string[] }[];
  windows: number;
  stressWindows: number;
  window: number;
  step: number;
  basis: "returns" | "absReturns";
  /** Bars actually used, and the date span they cover. */
  bars: number;
  from: string | null;
  to: string | null;
  usableSymbols: string[];
  skippedSymbols: string[];
};

const clean = (v: number): number | null => (Number.isFinite(v) ? v : null);

const toCell = (c: SpilloverCell): SpilloverHeatmapCell => ({
  calm: clean(c.calm),
  stress: clean(c.stress),
  delta: clean(c.delta),
  pairs: c.pairs,
  calmWindows: c.calmWindows,
  stressWindows: c.stressWindows,
});

export const getClusterSpilloverHeatmap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => InputSchema.parse(data ?? {}))
  .handler(async ({ data, context }): Promise<SpilloverHeatmapResponse> => {
    const symbols = (data.symbols?.length
      ? data.symbols
      : [...DEFAULT_SPILLOVER_SYMBOLS]).map((s) => s.toUpperCase());

    const since = new Date(Date.now() - data.lookbackDays * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const { data: rows, error } = await context.supabase
      .from("price_cache")
      .select("symbol, price_date, close")
      .in("symbol", symbols)
      .gte("price_date", since)
      .order("price_date", { ascending: true });
    if (error) throw new Error(`price_cache read failed: ${error.message}`);

    // Align on the trading days every symbol has, so each rolling window
    // compares the same bars for every pair.
    const bySymbol = new Map<string, Map<string, number>>();
    const dateCount = new Map<string, number>();
    for (const r of rows ?? []) {
      const close = Number(r.close);
      if (!Number.isFinite(close) || close <= 0) continue;
      const sym = String(r.symbol).toUpperCase();
      const day = String(r.price_date);
      const m = bySymbol.get(sym) ?? new Map<string, number>();
      if (!m.has(day)) dateCount.set(day, (dateCount.get(day) ?? 0) + 1);
      m.set(day, close);
      bySymbol.set(sym, m);
    }

    const usableSymbols = symbols.filter((s) => (bySymbol.get(s)?.size ?? 0) >= data.window + 10);
    const skippedSymbols = symbols.filter((s) => !usableSymbols.includes(s));
    const dates = [...dateCount.entries()]
      .filter(([, n]) => n >= usableSymbols.length)
      .map(([d]) => d)
      .sort();

    const seriesBySymbol = new Map<string, number[]>();
    for (const sym of usableSymbols) {
      const m = bySymbol.get(sym)!;
      seriesBySymbol.set(sym, dates.map((d) => m.get(d)!));
    }

    const empty: SpilloverHeatmapResponse = {
      clusters: [],
      cells: [],
      members: [],
      windows: 0,
      stressWindows: 0,
      window: data.window,
      step: data.step,
      basis: data.basis,
      bars: dates.length,
      from: dates[0] ?? null,
      to: dates[dates.length - 1] ?? null,
      usableSymbols,
      skippedSymbols,
    };
    if (seriesBySymbol.size < 2 || dates.length < data.window + 5) return empty;

    const groups = new Map(usableSymbols.map((s) => [s, defaultCluster(s)]));
    const volZ = marketVolZScores(seriesBySymbol, 20);
    const matrix = clusterSpilloverMatrix(seriesBySymbol, {
      groups,
      volZ,
      window: data.window,
      step: data.step,
      basis: data.basis,
      stressZ: data.stressZ,
      minStressShare: data.minStressShare,
    });

    return {
      ...empty,
      clusters: matrix.clusters,
      cells: matrix.cells.map((row) => row.map(toCell)),
      members: matrix.clusters.map((c) => ({
        cluster: c,
        symbols: matrix.members.get(c) ?? [],
      })),
      windows: matrix.windows,
      stressWindows: matrix.stressWindows,
    };
  });
