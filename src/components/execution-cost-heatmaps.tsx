import { useMemo, useState } from "react";
import type { ScenarioReport } from "@/lib/scenario-report";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

type Metric = "spread" | "latency" | "impact";

const METRIC_LABEL: Record<Metric, string> = {
  spread: "Half-spread",
  latency: "Latency slippage",
  impact: "Market impact",
};

// Fixed size buckets (in trade currency notional). Log-spaced so both
// tiny (<$1k) and institutional-sized fills fall in useful bins.
const SIZE_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "<1k", min: 0, max: 1_000 },
  { label: "1–5k", min: 1_000, max: 5_000 },
  { label: "5–25k", min: 5_000, max: 25_000 },
  { label: "25–100k", min: 25_000, max: 100_000 },
  { label: "100k–500k", min: 100_000, max: 500_000 },
  { label: "≥500k", min: 500_000, max: Infinity },
];

function bucketFor(notional: number): number {
  for (let i = 0; i < SIZE_BUCKETS.length; i += 1) {
    const b = SIZE_BUCKETS[i];
    if (notional >= b.min && notional < b.max) return i;
  }
  return SIZE_BUCKETS.length - 1;
}

/** Continuous purple ramp — perceptually monotonic and safe under the
 *  three main forms of color vision deficiency. Deeper hue = more cost. */
function heatColor(intensity: number): string {
  // intensity in [0, 1]
  const t = Math.max(0, Math.min(1, intensity));
  // interpolate between very-light and deep purple (Okabe–Ito reddish purple)
  const light = { r: 245, g: 240, b: 250 };
  const deep = { r: 108, g: 33, b: 122 };
  const r = Math.round(light.r + (deep.r - light.r) * t);
  const g = Math.round(light.g + (deep.g - light.g) * t);
  const b = Math.round(light.b + (deep.b - light.b) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Notional-weighted heatmap: rows = symbols, columns = trade-size buckets.
 * A cell shows the weighted-average cost in bps for fills of that symbol
 * that landed in that size bucket. Empty cells are muted.
 */
export function ExecutionCostHeatmaps({
  reports,
  visible,
}: {
  reports: ScenarioReport[];
  visible: Record<string, boolean>;
}) {
  const shown = reports.filter((r) => visible[r.id]);
  const anyBreakdown = shown.some((r) =>
    r.executionSeries.some((p) => p.costBreakdownBps != null),
  );
  if (!anyBreakdown) return null;

  return (
    <section>
      <h3 className="mb-2 text-sm font-medium text-muted-foreground">
        Cost heatmaps — spread / latency / impact by asset × trade size
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Each cell is the notional-weighted average cost (bps of mid) for fills
        of that symbol in that size bucket. Deeper shade means higher cost;
        blank means no fills in that bucket.
      </p>
      <div className="space-y-6">
        {shown.map((r) => (
          <HeatmapScenario key={r.id} report={r} />
        ))}
      </div>
    </section>
  );
}

function HeatmapScenario({ report }: { report: ScenarioReport }) {
  const [metric, setMetric] = useState<Metric>("spread");

  const grid = useMemo(() => buildGrid(report), [report]);
  const cells = grid.cells;
  const symbols = grid.symbols;
  if (symbols.length === 0) return null;

  const pickValue = (c: (typeof cells)[number][number]) => {
    if (!c) return null;
    if (metric === "spread") return c.halfSpreadBps;
    if (metric === "latency") return c.latencyBps;
    return c.impactBps;
  };

  // Global max for the chosen metric drives the color ramp — keeps cells
  // comparable across the whole heatmap.
  let maxVal = 0;
  for (const row of cells) {
    for (const c of row) {
      const v = pickValue(c);
      if (v != null && v > maxVal) maxVal = v;
    }
  }

  return (
    <div className="rounded-md border border-foreground/10">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-foreground/10 px-3 py-2">
        <div className="text-sm font-medium">{report.label}</div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px] font-normal">
            {symbols.length} symbol{symbols.length === 1 ? "" : "s"} · max {maxVal.toFixed(1)} bps
          </Badge>
          <Tabs value={metric} onValueChange={(v) => setMetric(v as Metric)}>
            <TabsList className="h-8">
              <TabsTrigger value="spread" className="h-6 text-xs px-2">Spread</TabsTrigger>
              <TabsTrigger value="latency" className="h-6 text-xs px-2">Latency</TabsTrigger>
              <TabsTrigger value="impact" className="h-6 text-xs px-2">Impact</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      <Tabs value={metric}>
        {(["spread", "latency", "impact"] as Metric[]).map((m) => (
          <TabsContent key={m} value={m} className="p-3">
            <div className="overflow-x-auto">
              <table
                className="min-w-full border-separate"
                style={{ borderSpacing: 2 }}
                role="img"
                aria-label={`${METRIC_LABEL[m]} heatmap for ${report.label}. Rows are symbols, columns are trade-size buckets. Values in basis points of mid, weighted by filled notional.`}
              >
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 bg-background px-2 py-1 text-left text-xs font-medium text-muted-foreground">
                      Symbol
                    </th>
                    {SIZE_BUCKETS.map((b) => (
                      <th
                        key={b.label}
                        className="px-2 py-1 text-center text-xs font-medium text-muted-foreground"
                      >
                        {b.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {symbols.map((sym, rowIdx) => (
                    <tr key={sym}>
                      <th
                        scope="row"
                        className="sticky left-0 z-10 bg-background px-2 py-1 text-left text-xs font-medium"
                      >
                        {sym}
                      </th>
                      {SIZE_BUCKETS.map((_, colIdx) => {
                        const c = cells[rowIdx][colIdx];
                        const v = pickValue(c);
                        if (c == null || v == null) {
                          return (
                            <td
                              key={colIdx}
                              className="px-2 py-1 text-center text-[10px] text-muted-foreground/60"
                              title="No fills in this bucket"
                            >
                              ·
                            </td>
                          );
                        }
                        const intensity = maxVal > 0 ? v / maxVal : 0;
                        const bg = heatColor(intensity);
                        const textColor = intensity > 0.55 ? "#fff" : "#1a1a1a";
                        return (
                          <td
                            key={colIdx}
                            className="px-2 py-1 text-center text-xs font-mono tabular-nums"
                            style={{ backgroundColor: bg, color: textColor }}
                            title={`${sym} · ${SIZE_BUCKETS[colIdx].label} · ${c.fills} fill${c.fills === 1 ? "" : "s"} · spread ${c.halfSpreadBps.toFixed(1)}bps · latency ${c.latencyBps.toFixed(1)}bps · impact ${c.impactBps.toFixed(1)}bps`}
                          >
                            {v.toFixed(1)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ColorRampLegend maxVal={maxVal} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function ColorRampLegend({ maxVal }: { maxVal: number }) {
  const stops = 6;
  return (
    <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
      <span>0 bps</span>
      <div className="flex overflow-hidden rounded border border-foreground/10">
        {Array.from({ length: stops }).map((_, i) => (
          <span
            key={i}
            className="inline-block h-3 w-6"
            style={{ backgroundColor: heatColor(i / (stops - 1)) }}
          />
        ))}
      </div>
      <span>{maxVal.toFixed(1)} bps</span>
    </div>
  );
}

// -------- pure aggregation --------

type Cell = {
  fills: number;
  filledNotional: number;
  halfSpreadBps: number;
  latencyBps: number;
  impactBps: number;
};

function buildGrid(report: ScenarioReport): {
  symbols: string[];
  cells: (Cell | null)[][];
} {
  const rows = report.executionSeries.filter(
    (p) => p.costBreakdownBps != null && p.filledNotional > 0,
  );
  const bySymbol = new Map<string, { totalNotional: number; buckets: (Cell | null)[] }>();

  for (const p of rows) {
    const sym = p.symbol;
    const entry = bySymbol.get(sym) ?? {
      totalNotional: 0,
      buckets: Array<Cell | null>(SIZE_BUCKETS.length).fill(null),
    };
    entry.totalNotional += p.filledNotional;
    const bi = bucketFor(p.filledNotional);
    const cur = entry.buckets[bi];
    const b = p.costBreakdownBps!;
    const w = p.filledNotional;
    if (cur == null) {
      entry.buckets[bi] = {
        fills: 1,
        filledNotional: w,
        halfSpreadBps: b.halfSpreadBps,
        latencyBps: b.latencyBps,
        impactBps: b.impactBps,
      };
    } else {
      const newN = cur.filledNotional + w;
      entry.buckets[bi] = {
        fills: cur.fills + 1,
        filledNotional: newN,
        // rolling notional-weighted mean
        halfSpreadBps: (cur.halfSpreadBps * cur.filledNotional + b.halfSpreadBps * w) / newN,
        latencyBps: (cur.latencyBps * cur.filledNotional + b.latencyBps * w) / newN,
        impactBps: (cur.impactBps * cur.filledNotional + b.impactBps * w) / newN,
      };
    }
    bySymbol.set(sym, entry);
  }

  // Rank symbols by total filled notional so heaviest names surface first.
  const sortedSymbols = [...bySymbol.entries()]
    .sort((a, b) => b[1].totalNotional - a[1].totalNotional)
    .map(([s]) => s);
  return {
    symbols: sortedSymbols,
    cells: sortedSymbols.map((s) => bySymbol.get(s)!.buckets),
  };
}
