import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BacktestMetrics } from "@/lib/backtest-metrics";

export type BacktestEquityPoint = { snapshot_date: string; total_value: number };

export type BacktestRunRecord = {
  id: string;
  ranAt: string; // ISO
  portfolioId: string;
  riskLevel: string;
  days: number;
  metrics: BacktestMetrics;
  // Optional per-run equity series captured at save-time. Overlays in the
  // history card need this because there is no per-run entity server-side
  // to re-fetch from — each backtest recomputes over shared snapshots.
  equity?: BacktestEquityPoint[];
};

// Deterministic overlay colours so a given run keeps its colour across
// re-renders and toggles.
const OVERLAY_PALETTE = [
  "hsl(217 91% 60%)",
  "hsl(142 71% 45%)",
  "hsl(38 92% 50%)",
  "hsl(291 64% 55%)",
  "hsl(0 84% 60%)",
  "hsl(199 89% 48%)",
  "hsl(48 96% 53%)",
  "hsl(262 83% 58%)",
];


const STORAGE_PREFIX = "aegis.backtestRuns.";

export function loadRuns(portfolioId: string): BacktestRunRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + portfolioId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as BacktestRunRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRun(record: BacktestRunRecord) {
  if (typeof window === "undefined") return;
  const existing = loadRuns(record.portfolioId);
  const next = [record, ...existing].slice(0, 25);
  window.localStorage.setItem(
    STORAGE_PREFIX + record.portfolioId,
    JSON.stringify(next),
  );
  window.dispatchEvent(
    new CustomEvent("aegis:backtest-runs-updated", { detail: record.portfolioId }),
  );
}

function fmt(n: number | null | undefined, digits = 2, suffix = "") {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}${suffix}`;
}

function toneClass(v: number | null | undefined, invert = false) {
  if (v == null || !Number.isFinite(v)) return "text-muted-foreground";
  const good = invert ? v <= 0 : v >= 0;
  return good ? "text-emerald-500" : "text-red-500";
}

export function BacktestRunHistoryCard({ portfolioId }: { portfolioId: string }) {
  const [runs, setRuns] = useState<BacktestRunRecord[]>(() => loadRuns(portfolioId));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupByRisk, setGroupByRisk] = useState(true);

  useEffect(() => {
    const refresh = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (!detail || detail === portfolioId) setRuns(loadRuns(portfolioId));
    };
    window.addEventListener("aegis:backtest-runs-updated", refresh);
    return () => window.removeEventListener("aegis:backtest-runs-updated", refresh);
  }, [portfolioId]);

  const clearAll = () => {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(STORAGE_PREFIX + portfolioId);
    setRuns([]);
    setSelected(new Set());
  };

  const removeOne = (id: string) => {
    const next = runs.filter((r) => r.id !== id);
    window.localStorage.setItem(
      STORAGE_PREFIX + portfolioId,
      JSON.stringify(next),
    );
    setRuns(next);
    setSelected((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // Group by risk for the side-by-side comparison
  const compareRuns = selected.size > 0 ? runs.filter((r) => selected.has(r.id)) : runs;
  const grouped = new Map<string, BacktestRunRecord[]>();
  for (const r of compareRuns) {
    const key = groupByRisk ? r.riskLevel || "unknown" : r.id;
    const list = grouped.get(key) ?? [];
    list.push(r);
    grouped.set(key, list);
  }
  // Aggregate per group (avg + best/worst latest)
  const aggregates = Array.from(grouped.entries()).map(([key, list]) => {
    const avg = (fn: (r: BacktestRunRecord) => number | null | undefined) => {
      const vals = list.map(fn).filter((v): v is number => v != null && Number.isFinite(v));
      if (!vals.length) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    return {
      key,
      count: list.length,
      latest: list[0],
      avgReturn: avg((r) => r.metrics.totalReturnPct),
      avgMDD: avg((r) => r.metrics.maxDrawdownPct),
      avgSharpe: avg((r) => r.metrics.sharpe),
      avgWin: avg((r) => r.metrics.winRatePct ?? null),
    };
  });

  // Overlay data for the equity + drawdown charts.
  // Runs are aligned by day-index (t = 0..N) because they may span different
  // absolute date ranges; comparing them at the same *elapsed day* is the
  // apples-to-apples view. Equity is normalized to % change vs the run's own
  // starting equity; drawdown is (v / running-peak - 1) * 100.
  const overlayRuns = useMemo(
    () =>
      compareRuns.filter(
        (r): r is BacktestRunRecord & { equity: BacktestEquityPoint[] } =>
          Array.isArray(r.equity) && r.equity.length >= 2,
      ),
    [compareRuns],
  );

  const overlaySeries = useMemo(() => {
    return overlayRuns.map((r, idx) => {
      const start = r.equity[0].total_value;
      const safeStart = start !== 0 && Number.isFinite(start) ? start : 1;
      let peak = start;
      const points = r.equity.map((p, i) => {
        peak = Math.max(peak, p.total_value);
        const equityPct = ((p.total_value - safeStart) / Math.abs(safeStart)) * 100;
        const ddPct = peak > 0 ? (p.total_value / peak - 1) * 100 : 0;
        return { t: i, date: p.snapshot_date, equity: equityPct, drawdown: ddPct };
      });
      const label = `${new Date(r.ranAt).toLocaleDateString()} · ${r.riskLevel} · ${r.days}d`;
      return {
        id: r.id,
        label,
        color: OVERLAY_PALETTE[idx % OVERLAY_PALETTE.length],
        points,
      };
    });
  }, [overlayRuns]);

  // Recharts wants a single dataset when overlaying series that share an
  // x-axis; key each run's series by its id so multiple lines coexist.
  const mergedOverlay = useMemo(() => {
    const maxLen = overlaySeries.reduce((m, s) => Math.max(m, s.points.length), 0);
    const rows: Array<Record<string, number | string>> = [];
    for (let t = 0; t < maxLen; t++) {
      const row: Record<string, number | string> = { t };
      for (const s of overlaySeries) {
        const p = s.points[t];
        if (p) {
          row[`eq_${s.id}`] = p.equity;
          row[`dd_${s.id}`] = p.drawdown;
        }
      }
      rows.push(row);
    }
    return rows;
  }, [overlaySeries]);



  return (
    <Card className="mb-4">
      <CardHeader className="pb-2 flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-sm">Backtest run history</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Compare metrics across risk levels. Runs are stored locally in this browser.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={groupByRisk ? "default" : "outline"}
            onClick={() => setGroupByRisk((g) => !g)}
          >
            {groupByRisk ? "Grouped by risk" : "Per run"}
          </Button>
          {runs.length > 0 && (
            <Button size="sm" variant="ghost" onClick={clearAll}>
              Clear
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No runs recorded yet. Run a backtest and its metrics will appear here.
          </p>
        ) : (
          <>
            {groupByRisk && aggregates.length > 0 && (
              <div className="mb-4 overflow-x-auto">
                <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Side-by-side by risk level
                  {selected.size > 0 ? ` (${selected.size} selected)` : ` (all ${runs.length} runs)`}
                </div>
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3">Risk level</th>
                      <th className="py-2 pr-3">Runs</th>
                      <th className="py-2 pr-3">Avg return</th>
                      <th className="py-2 pr-3">Avg MDD</th>
                      <th className="py-2 pr-3">Avg Sharpe</th>
                      <th className="py-2 pr-3">Avg win rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aggregates
                      .sort((a, b) => a.key.localeCompare(b.key))
                      .map((g) => (
                        <tr key={g.key} className="border-b border-border/50">
                          <td className="py-2 pr-3">
                            <Badge variant="secondary" className="uppercase">{g.key}</Badge>
                          </td>
                          <td className="py-2 pr-3 text-muted-foreground">{g.count}</td>
                          <td className={`py-2 pr-3 tabular-nums ${toneClass(g.avgReturn)}`}>
                            {fmt(g.avgReturn, 2, "%")}
                          </td>
                          <td className={`py-2 pr-3 tabular-nums ${toneClass(g.avgMDD, true)}`}>
                            {fmt(g.avgMDD, 2, "%")}
                          </td>
                          <td className={`py-2 pr-3 tabular-nums ${toneClass(g.avgSharpe)}`}>
                            {fmt(g.avgSharpe, 2)}
                          </td>
                          <td className="py-2 pr-3 tabular-nums">{fmt(g.avgWin, 0, "%")}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="overflow-x-auto">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                All runs (select rows to narrow the comparison above)
              </div>
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-2 w-8"></th>
                    <th className="py-2 pr-3">When</th>
                    <th className="py-2 pr-3">Risk</th>
                    <th className="py-2 pr-3">Days</th>
                    <th className="py-2 pr-3">Return</th>
                    <th className="py-2 pr-3">MDD</th>
                    <th className="py-2 pr-3">Sharpe</th>
                    <th className="py-2 pr-3">Win rate</th>
                    <th className="py-2 pr-3">Trades</th>
                    <th className="py-2 pr-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => {
                    const m = r.metrics;
                    return (
                      <tr key={r.id} className="border-b border-border/50">
                        <td className="py-2 pr-2">
                          <input
                            type="checkbox"
                            aria-label="Select run for comparison"
                            checked={selected.has(r.id)}
                            onChange={() => toggle(r.id)}
                          />
                        </td>
                        <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">
                          {new Date(r.ranAt).toLocaleString()}
                        </td>
                        <td className="py-2 pr-3">
                          <Badge variant="secondary" className="uppercase">{r.riskLevel}</Badge>
                        </td>
                        <td className="py-2 pr-3 tabular-nums">{r.days}</td>
                        <td className={`py-2 pr-3 tabular-nums ${toneClass(m.totalReturnPct)}`}>
                          {fmt(m.totalReturnPct, 2, "%")}
                        </td>
                        <td className={`py-2 pr-3 tabular-nums ${toneClass(m.maxDrawdownPct, true)}`}>
                          {fmt(m.maxDrawdownPct, 2, "%")}
                        </td>
                        <td className={`py-2 pr-3 tabular-nums ${toneClass(m.sharpe)}`}>
                          {fmt(m.sharpe, 2)}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">
                          {fmt(m.winRatePct ?? null, 0, "%")}
                        </td>
                        <td className="py-2 pr-3 tabular-nums text-muted-foreground">
                          {m.wins}W / {m.losses}L / {m.trades}
                        </td>
                        <td className="py-2 pr-2">
                          <Button size="sm" variant="ghost" onClick={() => removeOne(r.id)}>
                            ×
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
