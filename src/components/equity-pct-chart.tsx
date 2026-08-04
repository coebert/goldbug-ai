import { ChartFrame } from "@/components/chart-frame";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AXIS_LINE, AXIS_TICK, GRID_PROPS, REFERENCE_LINE, TICK_LINE } from "@/lib/chart-palette";
import {
  formatUkAxisDay,
  formatUkAxisHour,
  formatUkAxisMonth,
  formatUkAxisTime,
  ukDayKey,
  ukZoneAbbr,
} from "@/lib/uk-time";
import { getIntradayEquity } from "@/lib/equity-intraday.functions";
import { backfillIntradayEquity } from "@/lib/equity-intraday-backfill.functions";

import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Resolution = "daily" | "hourly";

// All time labels and day bucketing go through the Europe/London helpers so
// the axis, the tooltip and the deposit/inception matching agree with each
// other and with the market clock, regardless of the viewer's own timezone.
function fmtDay(iso: string) {
  return formatUkAxisDay(iso);
}

function fmtHour(iso: string) {
  return formatUkAxisHour(iso);
}

/**
 * Days covered by a series, used to pick x-axis labels. Hourly data plotted
 * over months has no room for "02 Aug, 14:00" on every tick, so as the span
 * grows the labels get shorter while the points stay hourly.
 */
export function spanDays(rows: Array<{ at: string }>): number {
  if (rows.length < 2) return 0;
  const first = new Date(rows[0].at).getTime();
  const last = new Date(rows[rows.length - 1].at).getTime();
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
  return Math.max(0, (last - first) / 86_400_000);
}

export type TickStyle = "time" | "hour" | "day" | "month";

export type XAxisTicks = {
  /** Which label shape to render. */
  style: TickStyle;
  /** Minimum horizontal pixels recharts must leave between two rendered labels. */
  minTickGap: number;
  format: (iso: string) => string;
};

/** Widest label each style can produce, in approximate pixels at 11px type. */
const LABEL_WIDTH_PX: Record<TickStyle, number> = {
  time: 34, // "14:00"
  hour: 82, // "02 Aug, 14:00"
  day: 42, // "02 Aug"
  month: 44, // "Aug 26"
};

/**
 * Pick x-axis label shape and spacing from the span actually being plotted.
 *
 * Two failure modes this exists to prevent:
 *  - long-form labels ("02 Aug, 14:00") on a multi-month hourly series, which
 *    collide into an unreadable smear;
 *  - a fixed `minTickGap` that is narrower than the label it has to separate,
 *    so recharts happily renders touching ticks on dense series.
 *
 * The gap is always at least the widest label plus breathing room, then scaled
 * up further as point density rises so long spans thin their ticks out instead
 * of crowding them.
 */
export function xAxisTicks(
  resolution: Resolution,
  span: number,
  pointCount: number,
): XAxisTicks {
  const style: TickStyle =
    resolution === "hourly"
      ? span <= 1.5
        ? "time"
        : span <= 7
          ? "hour"
          : span <= 120
            ? "day"
            : "month"
      : span <= 120
        ? "day"
        : "month";

  const format =
    style === "time"
      ? formatUkAxisTime
      : style === "hour"
        ? formatUkAxisHour
        : style === "day"
          ? formatUkAxisDay
          : formatUkAxisMonth;

  // Density bonus: with hundreds of points crammed into one axis, neighbouring
  // candidate ticks sit a pixel apart, so widen the required gap.
  const densityBonus = Math.min(48, Math.floor(Math.max(0, pointCount - 60) / 40) * 8);
  const minTickGap = LABEL_WIDTH_PX[style] + 12 + densityBonus;

  return { style, minTickGap, format: (iso: string) => format(iso) };
}


/** Whole days from `inception` (or the first snapshot) to now, for the fetch window. */
export function historyDays(inception: string | null | undefined, now = new Date()): number {
  if (!inception) return 3650;
  const start = new Date(`${String(inception).slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(start)) return 3650;
  const days = Math.ceil((now.getTime() - start) / 86_400_000) + 1;
  return Math.min(3650, Math.max(1, days));
}

/**
 * Invested capital at each point in time: the baseline starting pot plus every
 * deposit made on or before that date.
 *
 * This is the crux of the chart's correctness. Measuring against the *final*
 * `starting_cash` is wrong whenever capital was added later: a £300 portfolio
 * that is topped up to £10,300 in month two reads as −97% for its whole first
 * month, as if the money had been lost rather than not yet deposited. Netting
 * the deposit out of the baseline as well as the equity keeps the line at the
 * portfolio's real performance and makes −100% (total loss) the true floor.
 */
export function capitalAt(
  baseline: number,
  deposits: Array<{ date: string; amount: number }>,
  onOrBefore: string,
): number {
  const day = ukDayKey(onOrBefore);
  let capital = baseline;
  for (const d of deposits) {
    const amt = Number(d?.amount);
    if (!Number.isFinite(amt)) continue;
    if (ukDayKey(String(d.date)) <= day) capital += amt;
  }
  return capital;
}

/** Symmetric-free, data-driven y domain that always contains zero. */
export function pctDomain(values: number[]): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [-1, 1];
  const lo = Math.min(0, ...finite);
  const hi = Math.max(0, ...finite);
  const pad = Math.max(0.25, (hi - lo) * 0.15);
  // Equity can never fall below −100% of contributed capital.
  return [Math.max(-100, lo - pad), hi + pad];
}

export type DeltaPoint = {
  at: string;
  value: number;
  pct: number;
  /** Percentage-point move versus the previous plotted point. */
  deltaPct: number;
  /** Money change versus the previous point, net of deposits made in between. */
  deltaValue: number;
};

/**
 * Period-over-period change for each plotted point. Deposits landing between
 * two points are netted out so a top-up never shows up as a "gain".
 */
export function addDeltas(
  rows: Array<{ at: string; value: number; pct: number }>,
  deposits: Array<{ date: string; amount: number }> = [],
): DeltaPoint[] {
  return rows.map((r, i) => {
    if (i === 0) return { ...r, deltaPct: 0, deltaValue: 0 };
    const prev = rows[i - 1];
    const prevDay = ukDayKey(String(prev.at));
    const day = ukDayKey(String(r.at));
    const flows = deposits.reduce((sum, d) => {
      const amt = Number(d?.amount);
      const dd = ukDayKey(String(d?.date ?? ""));
      return Number.isFinite(amt) && dd > prevDay && dd <= day ? sum + amt : sum;
    }, 0);
    return {
      ...r,
      deltaPct: r.pct - prev.pct,
      deltaValue: r.value - prev.value - flows,
    };
  });
}

/** Symmetric domain for the delta bars so zero sits on the mid-line. */
export function deltaDomainFor(values: number[]): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v)).map(Math.abs);
  const max = finite.length ? Math.max(...finite) : 0;
  const span = Math.max(0.1, max * 1.15);
  return [-span, span];
}

/**
 * Percentage change in equity versus the capital invested at the time.
 * Zero on the y-axis is the money put in, so the line only goes negative when
 * the portfolio is actually worth less than what was contributed.
 */
export function EquityPctChart({
  portfolioId,
  equity,
  startingCash,
  deposits = [],
  inceptionDate = null,
  seriesStartDate = null,
  currency = "GBP",
  className,
}: {
  portfolioId?: string;
  equity: Array<{
    snapshot_date: string;
    total_value: number | string;
    /** `equity_snapshots.source`, when available — drives the settled/provisional split. */
    source?: string | null;
  }>;
  /** Baseline pot with later deposits stripped out (`baselineStartingCash`). */
  startingCash: number;
  deposits?: Array<{ date: string; amount: number }>;
  /** `YYYY-MM-DD` the portfolio went live; earlier points are not plotted. */
  inceptionDate?: string | null;
  /** `YYYY-MM-DD` the series is labelled as starting: first real holdings day. */
  seriesStartDate?: string | null;
  currency?: string;
  className?: string;
}) {
  const [resolution, setResolution] = useState<Resolution>("daily");
  const intradayFn = useServerFn(getIntradayEquity);
  // Ask for the portfolio's whole life, not a rolling month: the Hourly view
  // should be a higher-resolution version of the all-time chart, not a
  // shorter one.
  const lookbackDays = useMemo(
    () => historyDays(inceptionDate ?? equity[0]?.snapshot_date ?? null),
    [inceptionDate, equity],
  );
  const intradayQ = useQuery({
    queryKey: ["equity-intraday", portfolioId, lookbackDays],
    queryFn: () => intradayFn({ data: { portfolio_id: portfolioId!, days: lookbackDays } }),
    enabled: resolution === "hourly" && !!portfolioId,
    staleTime: 60_000,
  });

  const hourlyPoints = intradayQ.data?.points ?? [];

  // Hourly recording only started when the feature shipped, so portfolios with
  // months of daily history would open on an almost-empty Hourly view. The
  // first time Hourly is opened with fewer points than daily snapshots, seed
  // the missing hours from the daily series (one anchor per day). Runs at most
  // once per mount and never overwrites genuinely recorded hours.
  const backfillFn = useServerFn(backfillIntradayEquity);
  const backfilled = useRef(false);
  const [backfilling, setBackfilling] = useState(false);
  useEffect(() => {
    if (resolution !== "hourly" || !portfolioId) return;
    if (backfilled.current || intradayQ.isLoading || !intradayQ.data) return;
    if (hourlyPoints.length >= equity.length) return;
    backfilled.current = true;
    setBackfilling(true);
    void backfillFn({ data: { portfolioId, days: 365 } })
      .then(() => intradayQ.refetch())
      .catch(() => undefined)
      .finally(() => setBackfilling(false));
  }, [
    resolution,
    portfolioId,
    intradayQ.isLoading,
    intradayQ.data,
    hourlyPoints.length,
    equity.length,
    backfillFn,
    intradayQ,
  ]);


  const { data, domain, deltaDomain, last, settlement, lastSettledPct } = useMemo(() => {
    const base = Number(startingCash);
    const stateByDay = new Map<string, SettlementState>();
    for (const e of equity) {
      stateByDay.set(
        ukDayKey(`${String(e.snapshot_date).slice(0, 10)}T12:00:00Z`),
        classifySnapshot({ snapshot_date: String(e.snapshot_date), source: e.source ?? null }),
      );
    }
    const raw: Array<{ at: string; value: number }> =
      resolution === "hourly"
        ? hourlyPoints.map((p) => ({ at: p.at, value: Number(p.total_value) }))
        : equity.map((e) => ({ at: String(e.snapshot_date), value: Number(e.total_value) }));
    // Never plot points from before the portfolio went live.
    const source = inceptionDate
      ? raw.filter((r) => ukDayKey(String(r.at)) >= ukDayKey(inceptionDate))
      : raw;

    const rows =
      base > 0
        ? source
            .map((r) => {
              const capital = capitalAt(base, deposits, r.at);
              return {
                at: r.at,
                value: r.value,
                pct: capital > 0 ? ((r.value - capital) / capital) * 100 : NaN,
              };
            })
            // Equity of exactly 0 usually means "not yet synced" rather than a
            // wipeout; a placeholder row must not print as −100%.
            .filter((r) => Number.isFinite(r.pct) && r.pct > -100)
        : [];

    const withDelta = addDeltas(rows, deposits);
    // Hourly points are all intraday marks by construction; the settled/
    // provisional split only means something on the daily close series.
    const states: SettlementState[] =
      resolution === "hourly"
        ? withDelta.map(() => "intraday" as const)
        : withDelta.map(
            (r) => stateByDay.get(ukDayKey(String(r.at))) ?? ("settled" as SettlementState),
          );
    const split = splitSettledSeries(withDelta, states);
    const vals = withDelta.map((r) => r.pct);
    const lastSettledIdx = states.lastIndexOf("settled");
    return {
      data: split,
      domain: pctDomain(vals),
      deltaDomain: deltaDomainFor(withDelta.map((r) => r.deltaPct)),
      last: vals.length ? vals[vals.length - 1] : 0,
      lastSettledPct: lastSettledIdx >= 0 ? vals[lastSettledIdx] : null,
      settlement: summariseSettlement(
        equity.map((e) => ({
          snapshot_date: String(e.snapshot_date),
          source: e.source ?? null,
        })),
      ),
    };
  }, [equity, hourlyPoints, deposits, startingCash, resolution, inceptionDate]);

  const hasDaily = equity.length >= 2;
  if (!hasDaily) return null;

  const up = last >= 0;
  const color = up ? "var(--success)" : "var(--destructive)";
  // Label shape and spacing follow the span actually plotted, so an all-time
  // hourly series thins to month labels instead of colliding.
  const ticks = xAxisTicks(resolution, spanDays(data), data.length);
  const money = (v: number) =>
    `${v < 0 ? "−" : "+"}${new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: currency || "GBP",
      maximumFractionDigits: 2,
    }).format(Math.abs(v))}`;

  return (
    <div className={className}>
      <div className="rounded-lg border bg-card p-3">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            Equity change vs invested capital
            {resolution === "hourly" ? ` · times ${ukZoneAbbr()}` : ""}
            {seriesStartDate ? ` · from ${formatUkAxisDay(`${seriesStartDate}T00:00:00Z`)}` : ""}
          </span>
          <div className="flex items-center gap-2">
            {portfolioId && (
              <div className="flex overflow-hidden rounded-md border text-[11px]">
                {(["daily", "hourly"] as Resolution[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setResolution(r)}
                    className={`px-2 py-0.5 capitalize transition-colors ${
                      resolution === r
                        ? "bg-secondary text-secondary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            )}
            <span
              className={`text-sm font-semibold tabular-nums ${up ? "text-primary" : "text-destructive"}`}
            >
              {up ? "+" : ""}
              {last.toFixed(2)}%
            </span>
          </div>
        </div>
        <ChartFrame className="h-[160px] landscape:h-[200px] md:h-[240px]">
          {data.length < 2 ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {resolution === "hourly"
                ? intradayQ.isLoading || backfilling
                  ? "Loading hourly points…"
                  : "No hourly points recorded yet — they accumulate as runs complete."
                : "Not enough history yet."}

            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 6, right: 12, bottom: 6, left: 4 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis
                  dataKey="at"
                  tick={AXIS_TICK}
                  minTickGap={ticks.minTickGap}
                  tickMargin={6}
                  interval="preserveStartEnd"
                  tickFormatter={(v) => ticks.format(String(v))}
                  axisLine={AXIS_LINE}
                  tickLine={TICK_LINE}
                />
                <YAxis
                  yAxisId="pct"
                  width={64}
                  tickMargin={4}
                  domain={domain}
                  tick={AXIS_TICK}
                  tickFormatter={(v) => `${Number(v).toFixed(1)}%`}
                  axisLine={AXIS_LINE}
                  tickLine={TICK_LINE}
                />
                <YAxis yAxisId="delta" orientation="right" domain={deltaDomain} hide />
                <ReferenceLine yAxisId="pct" {...REFERENCE_LINE} y={0} />
                <Tooltip
                  contentStyle={{
                    fontSize: 12,
                    background: "var(--popover)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    color: "var(--popover-foreground)",
                  }}
                  labelStyle={{ color: "var(--muted-foreground)" }}
                  labelFormatter={(l) => (resolution === "hourly" ? fmtHour(String(l)) : fmtDay(String(l)))}
                  formatter={(v, name, item) => {
                    if (name === "delta") {
                      const d = Number(v);
                      const money_ = money(Number(item?.payload?.deltaValue ?? 0));
                      return [
                        `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(2)} pp · ${money_}`,
                        resolution === "hourly" ? "vs prev hour" : "vs prev day",
                      ];
                    }
                    return [`${Number(v).toFixed(2)}%`, "vs capital"];
                  }}
                />
                <Bar
                  yAxisId="delta"
                  dataKey="deltaPct"
                  name="delta"
                  barSize={resolution === "hourly" ? Math.max(1, Math.min(3, Math.floor(600 / Math.max(1, data.length)))) : 6}
                  isAnimationActive={false}
                  radius={[1, 1, 1, 1]}
                >
                  {data.map((d, i) => (
                    <Cell
                      key={i}
                      fill={
                        d.deltaPct >= 0
                          ? "color-mix(in oklab, var(--success) 45%, transparent)"
                          : "color-mix(in oklab, var(--destructive) 45%, transparent)"
                      }
                    />
                  ))}
                </Bar>
                <Line
                  yAxisId="pct"
                  type="monotone"
                  dataKey="pct"
                  stroke={color}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </ChartFrame>
      </div>
    </div>
  );
}
