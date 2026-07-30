// Per-day equity % change chart. Positive days render green, negative
// red. Deposits/withdrawals are netted out so cash flows never count
// as gains — same rule as computeModeSummary.

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CalendarDays } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  assertNoFlowLeakage,
  computeDailyEquityChanges,
  type DepositLite,
  type EquitySnapshotLite,
} from "@/lib/daily-equity-changes";
import { formatMoney } from "@/lib/format-money";
import { AXIS_TICK, CHART_ROLE } from "@/lib/chart-palette";

type Range = "7d" | "30d" | "90d" | "ytd" | "all";

const RANGE_DAYS: Record<Exclude<Range, "ytd" | "all">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

const RANGES: { key: Range; label: string }[] = [
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
  { key: "90d", label: "90D" },
  { key: "ytd", label: "YTD" },
  { key: "all", label: "All" },
];

// Okabe–Ito colour-blind-safe roles; positive/negative also carry a
// glyph in the sr-only summary so meaning is not colour-dependent.
const POS = CHART_ROLE.positive;
const NEG = CHART_ROLE.negative;

function sliceByRange(rows: EquitySnapshotLite[], range: Range): EquitySnapshotLite[] {
  if (range === "all" || rows.length === 0) return rows;
  if (range === "ytd") {
    const year = String(rows[rows.length - 1].snapshot_date).slice(0, 4);
    return rows.filter((r) => String(r.snapshot_date) >= `${year}-01-01`);
  }
  const days = RANGE_DAYS[range];
  const end = new Date(String(rows[rows.length - 1].snapshot_date) + "T00:00:00Z");
  end.setUTCDate(end.getUTCDate() - days);
  const cutoff = end.toISOString().slice(0, 10);
  const sliced = rows.filter((r) => String(r.snapshot_date) >= cutoff);
  return sliced.length >= 2 ? sliced : rows;
}

function fmtDateShort(iso: string): string {
  // Show DD MMM for a compact axis label.
  const d = new Date(iso + "T00:00:00Z");
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
}

export function DailyEquityChangesCard({
  equity,
  deposits,
  currency,
}: {
  equity: EquitySnapshotLite[];
  deposits: DepositLite[];
  currency: string;
}) {
  const [range, setRange] = useState<Range>("30d");

  const rows = useMemo(
    () => computeDailyEquityChanges(sliceByRange(equity, range), deposits),
    [equity, deposits, range],
  );

  const stats = useMemo(() => {
    if (rows.length === 0) return null;
    let up = 0;
    let down = 0;
    let flat = 0;
    let best = rows[0];
    let worst = rows[0];
    for (const r of rows) {
      if (r.pct > 0) up++;
      else if (r.pct < 0) down++;
      else flat++;
      if (r.pct > best.pct) best = r;
      if (r.pct < worst.pct) worst = r;
    }
    return {
      up,
      down,
      flat,
      best,
      worst,
      total: rows.length,
      winRate: rows.length > 0 ? (up / rows.length) * 100 : 0,
    };
  }, [rows]);

  const chartData = useMemo(() => {
    const data = rows.map((r) => ({
      date: r.date,
      label: fmtDateShort(r.date),
      pct: Number(r.pct.toFixed(4)),
      pnl: r.pnl,
      equity: r.equity,
      prevEquity: r.prevEquity,
      netFlow: r.netFlow,
      basisReset: r.basisReset,
      // rawDelta is reconstructed so the assertion can verify pnl fully
      // accounts for netFlow (identity by construction is fine — the
      // real check is the pure-flow-day and pct-derivation branches).
      rawDelta: r.pnl + r.netFlow,
    }));
    // 4-dp rounding on pct means ~5e-5 pp of slack vs the exact
    // pnl/prev ratio; give the assertion matching tolerance.
    assertNoFlowLeakage(data, "DailyEquityChangesCard.chartData", {
      pctTolerance: 1e-4,
    });
    return data;
  }, [rows]);

  return (
    <Card data-testid="daily-equity-changes-card">
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarDays className="h-4 w-4" /> Daily equity change
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Trading-only day-over-day % change. Deposits, withdrawals and
            account re-baselining days are excluded.
          </p>
        </div>
        <div
          role="group"
          aria-label="Time range"
          className="inline-flex shrink-0 overflow-hidden rounded-md border border-border/60 bg-background text-[11px]"
        >
          {RANGES.map((r) => (
            <Button
              key={r.key}
              type="button"
              size="sm"
              variant={range === r.key ? "secondary" : "ghost"}
              aria-pressed={range === r.key}
              onClick={() => setRange(r.key)}
              className="h-8 rounded-none px-2 text-[11px]"
            >
              {r.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Not enough equity history yet — needs at least two daily snapshots.
          </p>
        ) : (
          <>
            <div className="mb-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <Stat label="Up days" value={`${stats!.up}`} tone="pos" />
              <Stat label="Down days" value={`${stats!.down}`} tone="neg" />
              <Stat
                label="Best"
                value={`${stats!.best.pct >= 0 ? "+" : ""}${stats!.best.pct.toFixed(2)}%`}
                sub={fmtDateShort(stats!.best.date)}
                tone="pos"
              />
              <Stat
                label="Worst"
                value={`${stats!.worst.pct >= 0 ? "+" : ""}${stats!.worst.pct.toFixed(2)}%`}
                sub={fmtDateShort(stats!.worst.date)}
                tone="neg"
              />
            </div>
            <div
              className="h-56 w-full"
              role="img"
              aria-label={`Daily equity change bar chart, ${range} range, ${stats!.up} up days and ${stats!.down} down days`}
            >
              <span className="sr-only" aria-live="polite">
                {`Daily trading-only percentage change over ${stats!.total} days: ${stats!.up} up, ${stats!.down} down, ${stats!.flat} flat. `}
                {`Best day ${stats!.best.pct >= 0 ? "up" : "down"} ${Math.abs(stats!.best.pct).toFixed(2)} percent on ${fmtDateShort(stats!.best.date)}. `}
                {`Worst day ${stats!.worst.pct >= 0 ? "up" : "down"} ${Math.abs(stats!.worst.pct).toFixed(2)} percent on ${fmtDateShort(stats!.worst.date)}. `}
                Deposits and withdrawals are excluded.
              </span>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 8, right: 8, left: -16, bottom: 4 }}
                >
                  <XAxis
                    dataKey="label"
                    tick={AXIS_TICK}
                    interval="preserveStartEnd"
                    minTickGap={16}
                  />
                  <YAxis
                    tick={AXIS_TICK}
                    tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                    width={44}
                  />
                  <ReferenceLine y={0} stroke="hsl(var(--foreground))" strokeOpacity={0.4} />
                  <Tooltip
                    cursor={{ fill: "hsl(var(--muted) / 0.3)" }}
                    content={({ active, payload }) => {
                      if (!active || !payload || payload.length === 0) return null;
                      const d = payload[0].payload as (typeof chartData)[number];
                      const pos = d.pct >= 0;
                      return (
                        <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
                          <div className="font-medium">{d.label}</div>
                          <div
                            className={`mt-1 font-semibold tabular-nums ${pos ? "text-success" : "text-destructive"}`}
                          >
                            {pos ? "▲ +" : "▼ "}
                            {d.pct.toFixed(2)}%
                          </div>
                          <div className="mt-1 text-muted-foreground tabular-nums">
                            P&amp;L {formatMoney(d.pnl, currency, 2)}
                          </div>
                          <div className="text-muted-foreground tabular-nums">
                            {formatMoney(d.prevEquity, currency, 2)} →{" "}
                            {formatMoney(d.equity, currency, 2)}
                          </div>
                          {d.netFlow !== 0 ? (
                            <div className="text-muted-foreground tabular-nums">
                              Flow {formatMoney(d.netFlow, currency, 2)} (excluded)
                            </div>
                          ) : null}
                          {d.basisReset ? (
                            <div className="mt-1 text-muted-foreground">
                              Account re-baselined by a cash transfer — trading P&amp;L
                              isn't measurable for this day.
                            </div>
                          ) : null}
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="pct" radius={[3, 3, 0, 0]}>
                    {chartData.map((d) => (
                      <Cell key={d.date} fill={d.pct >= 0 ? POS : NEG} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "pos" | "neg" | "neutral";
}) {
  const toneCls =
    tone === "pos" ? "text-success" : tone === "neg" ? "text-destructive" : "text-foreground";
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`font-display text-sm font-semibold tabular-nums ${toneCls}`}>{value}</div>
      {sub ? <div className="text-[10px] tabular-nums text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
