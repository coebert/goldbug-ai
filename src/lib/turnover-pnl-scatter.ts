// Turnover × re-entry-gap → net P&L scatter and drilldown.
//
// The optimizer already tells us which candidate won. It does not tell us
// *what kind of trading* wins once realistic frictions are paid. Two knobs
// govern that: how often a configuration trades (turnover) and how quickly it
// comes back after going flat (the re-entry gap distribution). Both cost money
// — turnover pays the per-ticket floor and the spread, and a short re-entry
// gap usually means the same name is being round-tripped through those costs
// repeatedly.
//
// This module relates both to the net outcome:
//
//   1. `scatterPoints`  — one dot per optimization run: x = measured
//      trades/yr, y = net CAGR after costs, radius = fee drag, colour = the
//      run's median re-entry gap band.
//   2. `buildDrilldownGrid` — the same population cross-tabulated into
//      turnover bands × gap bands, so a cell can be read as "runs that trade
//      this much and re-enter this fast earn this much net".
//   3. `describeScatter` / `explainDrilldown` — plain-language verdicts.
//
// Everything is pure: rows and trade logs in, numbers and SVG strings out. No
// clock, no randomness, no IO — so the whole surface is unit-testable.

import { niceTicks } from "./cost-return-chart";
import { reentryProfile, type ParamSet, type TradeLeg, type TurnoverRow } from "./turnover-attribution";
import type { ReportPanel } from "./backtest-report-chart";

// ------------------------------------------------------------- gap bands

export type GapBandKey = "none" | "immediate" | "fast" | "patient" | "slow";

export type GapBand = {
  key: GapBandKey;
  label: string;
  /** Inclusive lower bound in days. */
  minDays: number;
  /** Exclusive upper bound in days; Infinity for the open-ended band. */
  maxDays: number;
  colour: string;
};

/**
 * Gap bands are cost bands in disguise: an "immediate" re-buy pays a second
 * round trip within days of the exit, which is where the minimum-fee floor
 * does the most damage.
 */
export const GAP_BANDS: readonly GapBand[] = [
  { key: "immediate", label: "≤2d re-entry", minDays: 0, maxDays: 3, colour: "#e5484d" },
  { key: "fast", label: "3–5d re-entry", minDays: 3, maxDays: 6, colour: "#f5a623" },
  { key: "patient", label: "6–15d re-entry", minDays: 6, maxDays: 16, colour: "#4ea1ff" },
  { key: "slow", label: ">15d re-entry", minDays: 16, maxDays: Infinity, colour: "#39d98a" },
];

const NONE_BAND: GapBand = {
  key: "none",
  label: "no re-entry",
  minDays: NaN,
  maxDays: NaN,
  colour: "#9aa4b2",
};

/** Band a median gap falls into; runs that never re-entered get `none`. */
export function gapBandFor(medianGapDays: number | null): GapBand {
  if (medianGapDays === null || !Number.isFinite(medianGapDays)) return NONE_BAND;
  const g = Math.max(0, medianGapDays);
  return GAP_BANDS.find((b) => g >= b.minDays && g < b.maxDays) ?? GAP_BANDS[GAP_BANDS.length - 1]!;
}

/** All bands in display order, including the "never re-entered" bucket. */
export function allGapBands(): GapBand[] {
  return [...GAP_BANDS, NONE_BAND];
}

// ----------------------------------------------------------- scatter data

export type ScatterPoint = {
  /** Short human label for the run (usually the formatted param set). */
  label: string;
  params: ParamSet;
  /** Measured turnover, not the configured cap. */
  tradesPerYear: number;
  /** Net CAGR after commission, minimum fees and slippage. */
  netCagrPct: number;
  feeDragPct: number;
  maxDrawdownPct: number;
  feasible: boolean;
  /** Median flat→re-buy gap in days; null when the run never re-entered. */
  medianGapDays: number | null;
  /** 90th-percentile gap; null when the run never re-entered. */
  p90GapDays: number | null;
  /** Share of exits that were re-bought at all. */
  reentryRate: number;
  /** Share of re-entries inside the "fast" window. */
  fastReentryShare: number;
  reentries: number;
  band: GapBand;
};

const mean = (xs: readonly number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

/** Linear-interpolated percentile of an unsorted numeric sample. */
export function percentile(xs: readonly number[], p: number): number | null {
  const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length === 0) return null;
  if (s.length === 1) return s[0]!;
  const idx = Math.min(1, Math.max(0, p)) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
}

export function median(xs: readonly number[]): number | null {
  return percentile(xs, 0.5);
}

/** Pearson correlation; 0 when either series is flat or too short. */
export function correlation(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return 0;
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}

export type ScatterOptions = {
  /** Days that count as a "fast" re-entry when profiling the trade log. */
  fastDays?: number;
  /** Include candidates the constraint check disqualified. Default false. */
  includeDisqualified?: boolean;
  /** Label for a run; defaults to a compact param rendering. */
  labelOf?: (row: TurnoverRow) => string;
};

const defaultLabel = (row: TurnoverRow) =>
  Object.entries(row.params)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

/**
 * One point per optimization run, joining the run's measured metrics with the
 * re-entry gap distribution reconstructed from its own trade log.
 */
export function scatterPoints(
  rows: readonly TurnoverRow[],
  logFor: (row: TurnoverRow) => readonly TradeLeg[],
  opts: ScatterOptions = {},
): ScatterPoint[] {
  const fastDays = opts.fastDays ?? 5;
  const label = opts.labelOf ?? defaultLabel;
  return rows
    .filter((r) => opts.includeDisqualified || !r.check?.disqualified)
    .map((r) => {
      const profile = reentryProfile(logFor(r), { fastDays });
      const gaps = profile.events.map((e) => e.gapDays);
      const med = median(gaps);
      return {
        label: label(r),
        params: r.params,
        tradesPerYear: r.metrics.tradesPerYear,
        netCagrPct: r.metrics.cagrPct,
        feeDragPct: r.metrics.feeDragPct,
        maxDrawdownPct: r.metrics.maxDrawdownPct,
        feasible: r.check?.feasible ?? true,
        medianGapDays: med,
        p90GapDays: percentile(gaps, 0.9),
        reentryRate: profile.reentryRate,
        fastReentryShare: profile.fastReentryShare,
        reentries: profile.events.length,
        band: gapBandFor(med),
      };
    });
}

// -------------------------------------------------------------- drilldown

export type TurnoverBand = {
  label: string;
  /** Inclusive lower bound, trades/yr. */
  min: number;
  /** Exclusive upper bound, trades/yr (Infinity on the last band). */
  max: number;
};

/**
 * Quantile turnover bands over the observed population, so the drilldown has
 * roughly equal-sized buckets instead of arbitrary round numbers that might
 * all land in one cell.
 */
export function turnoverBands(
  points: readonly ScatterPoint[],
  count = 3,
): TurnoverBand[] {
  const xs = points.map((p) => p.tradesPerYear).filter(Number.isFinite);
  const n = Math.max(1, Math.floor(count));
  if (xs.length === 0) return [];
  const distinct = [...new Set(xs)].sort((a, b) => a - b);
  if (distinct.length === 1) {
    return [{ label: `${distinct[0]!.toFixed(0)}/yr`, min: distinct[0]!, max: Infinity }];
  }

  const cuts: number[] = [];
  for (let i = 1; i < n; i++) {
    const q = percentile(xs, i / n);
    if (q !== null && (cuts.length === 0 || q > cuts[cuts.length - 1]! + 1e-9)) cuts.push(q);
  }

  const edges = [Math.min(...xs), ...cuts, Infinity];
  const bands: TurnoverBand[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i]!;
    const hi = edges[i + 1]!;
    bands.push({
      label:
        hi === Infinity
          ? `≥${lo.toFixed(0)}/yr`
          : `${lo.toFixed(0)}–${hi.toFixed(0)}/yr`,
      min: lo,
      max: hi,
    });
  }
  return bands;
}

export function bandOf(bands: readonly TurnoverBand[], tradesPerYear: number): TurnoverBand | null {
  return (
    bands.find((b) => tradesPerYear >= b.min && tradesPerYear < b.max) ??
    (bands.length > 0 && tradesPerYear >= bands[bands.length - 1]!.min
      ? bands[bands.length - 1]!
      : null)
  );
}

export type DrilldownCell = {
  turnover: TurnoverBand;
  gap: GapBand;
  runs: number;
  medianNetCagrPct: number;
  bestNetCagrPct: number;
  worstNetCagrPct: number;
  meanFeeDragPct: number;
  meanTradesPerYear: number;
  feasibleShare: number;
  /** Share of runs in the cell that made money net of costs. */
  profitableShare: number;
  /** Labels of the runs in the cell, best net CAGR first. */
  members: string[];
};

export type DrilldownGrid = {
  turnoverBands: TurnoverBand[];
  gapBands: GapBand[];
  cells: DrilldownCell[];
  /** Populated cells only, best median net CAGR first. */
  ranked: DrilldownCell[];
  runs: number;
  /** Correlation of turnover with net CAGR across all points. */
  turnoverPnlCorr: number;
  /** Correlation of the median re-entry gap with net CAGR (re-entering runs). */
  gapPnlCorr: number;
  /** Correlation of turnover with fee drag — the cost channel. */
  turnoverFeeCorr: number;
};

export type DrilldownOptions = {
  /** Number of turnover quantile bands. Default 3. */
  turnoverBandCount?: number;
  /** Cap on the run labels stored per cell. Default 4. */
  maxMembers?: number;
};

/** Cross-tabulate the scatter population into turnover × gap cells. */
export function buildDrilldownGrid(
  points: readonly ScatterPoint[],
  opts: DrilldownOptions = {},
): DrilldownGrid {
  const tBands = turnoverBands(points, opts.turnoverBandCount ?? 3);
  const maxMembers = opts.maxMembers ?? 4;
  const usedGapKeys = new Set(points.map((p) => p.band.key));
  const gBands = allGapBands().filter((b) => usedGapKeys.has(b.key));

  const cells: DrilldownCell[] = [];
  for (const t of tBands) {
    for (const g of gBands) {
      const pool = points.filter(
        (p) => bandOf(tBands, p.tradesPerYear)?.label === t.label && p.band.key === g.key,
      );
      const nets = pool.map((p) => p.netCagrPct);
      cells.push({
        turnover: t,
        gap: g,
        runs: pool.length,
        medianNetCagrPct: median(nets) ?? 0,
        bestNetCagrPct: nets.length ? Math.max(...nets) : 0,
        worstNetCagrPct: nets.length ? Math.min(...nets) : 0,
        meanFeeDragPct: mean(pool.map((p) => p.feeDragPct)),
        meanTradesPerYear: mean(pool.map((p) => p.tradesPerYear)),
        feasibleShare: pool.length ? pool.filter((p) => p.feasible).length / pool.length : 0,
        profitableShare: pool.length ? pool.filter((p) => p.netCagrPct > 0).length / pool.length : 0,
        members: [...pool]
          .sort((a, b) => b.netCagrPct - a.netCagrPct)
          .slice(0, maxMembers)
          .map((p) => p.label),
      });
    }
  }

  const withGap = points.filter((p) => p.medianGapDays !== null);
  return {
    turnoverBands: tBands,
    gapBands: gBands,
    cells,
    ranked: cells
      .filter((c) => c.runs > 0)
      .sort((a, b) => b.medianNetCagrPct - a.medianNetCagrPct),
    runs: points.length,
    turnoverPnlCorr: correlation(
      points.map((p) => p.tradesPerYear),
      points.map((p) => p.netCagrPct),
    ),
    gapPnlCorr: correlation(
      withGap.map((p) => p.medianGapDays!),
      withGap.map((p) => p.netCagrPct),
    ),
    turnoverFeeCorr: correlation(
      points.map((p) => p.tradesPerYear),
      points.map((p) => p.feeDragPct),
    ),
  };
}

export const DRILLDOWN_COLUMNS = [
  "turnover band",
  "re-entry band",
  "runs",
  "median net CAGR %",
  "best %",
  "worst %",
  "fees %",
  "trades/yr",
  "profitable",
  "feasible",
  "example configs",
] as const;

export function drilldownTableRows(grid: DrilldownGrid): string[][] {
  return grid.ranked.map((c) => [
    c.turnover.label,
    c.gap.label,
    String(c.runs),
    c.medianNetCagrPct.toFixed(2),
    c.bestNetCagrPct.toFixed(2),
    c.worstNetCagrPct.toFixed(2),
    c.meanFeeDragPct.toFixed(2),
    c.meanTradesPerYear.toFixed(0),
    `${(c.profitableShare * 100).toFixed(0)}%`,
    `${(c.feasibleShare * 100).toFixed(0)}%`,
    c.members.join("; "),
  ]);
}

export const SCATTER_COLUMNS = [
  "config",
  "trades/yr",
  "net CAGR %",
  "fees %",
  "DD %",
  "median gap (d)",
  "p90 gap (d)",
  "exits re-bought",
  "re-entry band",
  "status",
] as const;

/** Row-level drilldown: every plotted dot, best net outcome first. */
export function scatterTableRows(points: readonly ScatterPoint[]): string[][] {
  return [...points]
    .sort((a, b) => b.netCagrPct - a.netCagrPct)
    .map((p) => [
      p.label,
      p.tradesPerYear.toFixed(0),
      p.netCagrPct.toFixed(2),
      p.feeDragPct.toFixed(2),
      p.maxDrawdownPct.toFixed(1),
      p.medianGapDays === null ? "—" : p.medianGapDays.toFixed(0),
      p.p90GapDays === null ? "—" : p.p90GapDays.toFixed(0),
      `${(p.reentryRate * 100).toFixed(0)}%`,
      p.band.label,
      p.feasible ? "feasible" : "infeasible",
    ]);
}

// ------------------------------------------------------------- rendering

const PAD = { top: 20, right: 18, bottom: 36, left: 58 };
const DEFAULT_SIZE = { width: 640, height: 320 };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "0.00");

export type ScatterChartOptions = {
  title?: string;
  xLabel?: string;
  yLabel?: string;
  /** Vertical marker, e.g. the fitted breakeven turnover. */
  markerX?: { value: number; label: string } | null;
  size?: { width: number; height: number };
};

/**
 * Turnover (x) against net CAGR (y), one dot per run. Dot radius grows with
 * fee drag and colour encodes the re-entry band, so a cluster of large red
 * dots below the zero line is the visual signature of "churn paid for by the
 * account".
 */
export function renderTurnoverPnlScatter(
  points: readonly ScatterPoint[],
  options: ScatterChartOptions = {},
): string {
  const size = options.size ?? DEFAULT_SIZE;
  const title = options.title ?? "Net CAGR vs measured turnover";
  const w = size.width - PAD.left - PAD.right;
  const h = size.height - PAD.top - PAD.bottom;

  if (points.length === 0) {
    return `<svg viewBox="0 0 ${size.width} ${size.height}" class="chart" role="img" aria-label="${esc(
      title,
    )} (no data)">
  <text x="${size.width / 2}" y="${size.height / 2}" class="empty" text-anchor="middle">no data</text>
</svg>`;
  }

  const xs = points.map((p) => p.tradesPerYear);
  const ys = points.map((p) => p.netCagrPct);
  let xLo = Math.min(0, ...xs);
  let xHi = Math.max(...xs);
  if (xHi - xLo < 1e-9) xHi = xLo + 1;
  let yLo = Math.min(0, ...ys);
  let yHi = Math.max(0, ...ys);
  if (yHi - yLo < 0.5) {
    const mid = (yHi + yLo) / 2;
    yLo = mid - 0.25;
    yHi = mid + 0.25;
  }

  const xPix = (v: number) => PAD.left + ((v - xLo) / (xHi - xLo)) * w;
  const yPix = (v: number) => PAD.top + h - ((v - yLo) / (yHi - yLo)) * h;

  const maxFee = Math.max(...points.map((p) => Math.abs(p.feeDragPct)), 1e-9);
  const radius = (feePct: number) => 3 + 5 * Math.sqrt(Math.max(0, feePct) / maxFee);

  const grid = niceTicks(yLo, yHi)
    .map(
      (t) =>
        `<line class="grid" x1="${PAD.left}" x2="${PAD.left + w}" y1="${f2(yPix(t))}" y2="${f2(
          yPix(t),
        )}"/>` +
        `<text class="axis" x="${PAD.left - 8}" y="${f2(yPix(t) + 3.5)}" text-anchor="end">${esc(
          t.toFixed(1),
        )}</text>`,
    )
    .join("\n  ");

  const xTicks = niceTicks(xLo, xHi)
    .map(
      (t) =>
        `<line class="grid" x1="${f2(xPix(t))}" x2="${f2(xPix(t))}" y1="${PAD.top}" y2="${
          PAD.top + h
        }" opacity="0.3"/>` +
        `<text class="axis" x="${f2(xPix(t))}" y="${PAD.top + h + 14}" text-anchor="middle">${esc(
          t.toFixed(0),
        )}</text>`,
    )
    .join("\n  ");

  const zero =
    yLo < 0 && yHi > 0
      ? `<line class="zero" x1="${PAD.left}" x2="${PAD.left + w}" y1="${f2(yPix(0))}" y2="${f2(
          yPix(0),
        )}"/>`
      : "";

  const marker =
    options.markerX && Number.isFinite(options.markerX.value)
      ? `<line class="zero" stroke-dasharray="4 4" x1="${f2(xPix(options.markerX.value))}" x2="${f2(
          xPix(options.markerX.value),
        )}" y1="${PAD.top}" y2="${PAD.top + h}"><title>${esc(
          options.markerX.label,
        )}</title></line>`
      : "";

  const dots = points
    .map((p) => {
      const tip =
        `${p.label} · ${p.tradesPerYear.toFixed(0)} trades/yr → ${p.netCagrPct.toFixed(2)}% net ` +
        `(fees ${p.feeDragPct.toFixed(2)}%, DD ${p.maxDrawdownPct.toFixed(1)}%) · ` +
        `${p.band.label}${
          p.medianGapDays === null ? "" : ` · median gap ${p.medianGapDays.toFixed(0)}d`
        } · ${(p.reentryRate * 100).toFixed(0)}% of exits re-bought`;
      return `<circle class="dot" cx="${f2(xPix(p.tradesPerYear))}" cy="${f2(
        yPix(p.netCagrPct),
      )}" r="${f2(radius(p.feeDragPct))}" fill="${p.band.colour}" fill-opacity="${
        p.feasible ? "0.85" : "0.35"
      }" stroke="${p.band.colour}"><title>${esc(tip)}</title></circle>`;
    })
    .join("\n  ");

  return `<svg viewBox="0 0 ${size.width} ${size.height}" class="chart" role="img" aria-label="${esc(
    title,
  )}">
  <text class="chart-title" x="${PAD.left}" y="12">${esc(title)}</text>
  ${grid}
  ${xTicks}
  ${zero}
  ${marker}
  ${dots}
  <text class="axis-label" x="${PAD.left}" y="${size.height - 4}">${esc(
    options.xLabel ?? "measured turnover (trades/yr)",
  )}</text>
  <text class="axis-label" x="${size.width - PAD.right}" y="${
    size.height - 4
  }" text-anchor="end">${esc(options.yLabel ?? "net CAGR % after costs")}</text>
</svg>`;
}

/**
 * The second view: median re-entry gap (x) against net CAGR (y). Runs that
 * never re-entered are dropped — they have no gap to plot.
 */
export function renderGapPnlScatter(
  points: readonly ScatterPoint[],
  options: ScatterChartOptions = {},
): string {
  const plotted = points.filter((p) => p.medianGapDays !== null);
  return renderTurnoverPnlScatter(
    plotted.map((p) => ({ ...p, tradesPerYear: p.medianGapDays! })),
    {
      title: options.title ?? "Net CAGR vs median re-entry gap",
      xLabel: options.xLabel ?? "median flat→re-buy gap (days)",
      yLabel: options.yLabel ?? "net CAGR % after costs",
      markerX: options.markerX ?? null,
      ...(options.size ? { size: options.size } : {}),
    },
  );
}

/** Legend entries matching the bands actually present in the population. */
export function scatterLegend(
  points: readonly ScatterPoint[],
): { label: string; colour: string }[] {
  const used = new Set(points.map((p) => p.band.key));
  return allGapBands()
    .filter((b) => used.has(b.key))
    .map((b) => ({ label: b.label, colour: b.colour }));
}

// ----------------------------------------------------------- explanations

const strength = (r: number) => {
  const a = Math.abs(r);
  if (a < 0.15) return "no";
  if (a < 0.35) return "a weak";
  if (a < 0.6) return "a moderate";
  return "a strong";
};

/** Headline read of the scatter: does churn help or hurt, and does gap matter? */
export function describeScatter(grid: DrilldownGrid): string {
  if (grid.runs === 0) return "No runs to plot — nothing to relate to net P&L.";
  const churn =
    `Turnover shows ${strength(grid.turnoverPnlCorr)} ` +
    `${grid.turnoverPnlCorr < 0 ? "negative" : "positive"} relationship with net CAGR ` +
    `(r=${grid.turnoverPnlCorr.toFixed(2)}) across ${grid.runs} runs, while it ` +
    `${grid.turnoverFeeCorr > 0.15 ? "clearly drives" : "barely moves"} fee drag ` +
    `(r=${grid.turnoverFeeCorr.toFixed(2)}).`;
  const gap =
    Math.abs(grid.gapPnlCorr) < 0.15
      ? "Re-entry speed is not the deciding factor here."
      : grid.gapPnlCorr > 0
        ? `Waiting longer before re-entering helps (r=${grid.gapPnlCorr.toFixed(2)} of gap vs net CAGR).`
        : `Faster re-entries score better (r=${grid.gapPnlCorr.toFixed(2)} of gap vs net CAGR) — the exits are firing too early.`;
  return `${churn} ${gap}`;
}

/** Cell-level verdict: the best and worst turnover × gap combinations. */
export function explainDrilldown(grid: DrilldownGrid): string {
  if (grid.ranked.length === 0) return "No populated cells — widen the search grid.";
  const best = grid.ranked[0]!;
  const worst = grid.ranked[grid.ranked.length - 1]!;
  const bestTxt =
    `Best combination: ${best.turnover.label} with ${best.gap.label} — ` +
    `median ${best.medianNetCagrPct.toFixed(2)}% net across ${best.runs} run${
      best.runs === 1 ? "" : "s"
    } (fees ${best.meanFeeDragPct.toFixed(2)}%).`;
  if (grid.ranked.length === 1) return bestTxt;
  return (
    `${bestTxt} Worst: ${worst.turnover.label} with ${worst.gap.label} at ` +
    `${worst.medianNetCagrPct.toFixed(2)}% net (fees ${worst.meanFeeDragPct.toFixed(2)}%), ` +
    `a ${(best.medianNetCagrPct - worst.medianNetCagrPct).toFixed(2)}pp spread that costs, not signal, explains.`
  );
}

// ---------------------------------------------------------------- panels

export type PanelOptions = {
  /** Friction description for the subtitle, e.g. "8bps + $3, 5bps slippage". */
  frictionNote?: string;
  /** Fitted breakeven turnover to mark on the scatter. */
  breakevenTradesPerYear?: number | null;
  turnoverBandCount?: number;
};

/**
 * Report panels: the two scatters with their legend, the cross-tab drilldown,
 * and the per-run table that backs both.
 */
export function buildTurnoverPnlPanels(
  points: readonly ScatterPoint[],
  opts: PanelOptions = {},
): ReportPanel[] {
  const grid = buildDrilldownGrid(points, {
    ...(opts.turnoverBandCount === undefined ? {} : { turnoverBandCount: opts.turnoverBandCount }),
  });
  const friction = opts.frictionNote ? ` after ${opts.frictionNote}` : " after realistic costs";
  const marker =
    opts.breakevenTradesPerYear != null && Number.isFinite(opts.breakevenTradesPerYear)
      ? { value: opts.breakevenTradesPerYear, label: "fitted breakeven turnover" }
      : null;

  return [
    {
      heading: "Turnover & re-entry vs net P&L",
      subtitle: `${describeScatter(grid)} Dot size is fee drag; faded dots are infeasible runs${friction}.`,
      series: [],
      charts: [
        renderTurnoverPnlScatter(points, { markerX: marker }),
        renderGapPnlScatter(points),
      ],
      legend: scatterLegend(points),
    },
    {
      heading: "Drilldown — turnover band × re-entry band",
      subtitle: explainDrilldown(grid),
      series: [],
      table: { columns: [...DRILLDOWN_COLUMNS], rows: drilldownTableRows(grid) },
    },
    {
      heading: "Per-run turnover, re-entry gaps and net outcome",
      subtitle: `every optimization run plotted above, best net CAGR first${friction}`,
      series: [],
      table: { columns: [...SCATTER_COLUMNS], rows: scatterTableRows(points) },
    },
  ];
}
