// Cost-vs-return charts for the ticket-size sweep.
//
// The sweep answers "how big does a ticket have to be before swing trading
// survives its own costs?". The tables in the report already carry the numbers;
// these charts make the shape of the answer visible:
//
//   1. Net return vs ticket size — one line per cost scale. Small tickets sit
//      below zero because the fixed commission minimum dominates; the lines
//      rise and separate as tickets grow.
//   2. Breakeven cost curve vs ticket size — the all-in round-trip cost (bps)
//      at which the strategy stops making money, plotted against the actual
//      baseline cost of that ticket. Where the baseline line drops below the
//      breakeven curve, the ticket is viable.
//
// Pure and deterministic: takes sweep cells in, returns SVG strings out. No
// network, no clock, no DOM — so the whole thing is unit-testable.

import {
  findBreakevenScale,
  roundTripCostBps,
  ticketValue,
  type SweepCell,
  type TicketSpec,
} from "./cost-sweep";
import type { Frictions } from "./broker-simulator";
import type { ReportPanel } from "./backtest-report-chart";

const PAD = { top: 18, right: 16, bottom: 34, left: 56 };
const DEFAULT_SIZE = { width: 620, height: 280 };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "0.00");

/** Tick values that land on human-friendly round numbers. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-9) {
    return [min, max].filter(Number.isFinite);
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) ticks.push(t);
  return ticks;
}

export type XYPoint = {
  x: number;
  y: number;
  /** Text shown in the hover tooltip for this point. */
  note?: string;
};

export type XYSeries = {
  label: string;
  colour: string;
  dashed?: boolean;
  points: XYPoint[];
};

export type XYChartOptions = {
  title: string;
  xLabel: string;
  yLabel: string;
  /** Formatter for x-axis tick labels. */
  xTick?: (v: number) => string;
  /** Formatter for y-axis tick labels. */
  yTick?: (v: number) => string;
  size?: { width: number; height: number };
};

/**
 * Scatter+line chart over an arbitrary numeric x axis (ticket notional here,
 * not bar index), with a marked point per observation so the discrete ticket
 * sizes we actually tested stay visible instead of being implied by a smooth
 * line.
 */
export function renderXYChart(series: readonly XYSeries[], options: XYChartOptions): string {
  const size = options.size ?? DEFAULT_SIZE;
  const w = size.width - PAD.left - PAD.right;
  const h = size.height - PAD.top - PAD.bottom;
  const plotted = series.filter((s) => s.points.length > 0);

  if (plotted.length === 0) {
    return `<svg viewBox="0 0 ${size.width} ${size.height}" class="chart" role="img" aria-label="${esc(
      options.title,
    )} (no data)">
  <text x="${size.width / 2}" y="${size.height / 2}" class="empty" text-anchor="middle">no data</text>
</svg>`;
  }

  const xs = plotted.flatMap((s) => s.points.map((p) => p.x));
  const ys = plotted.flatMap((s) => s.points.map((p) => p.y));
  const xLo = Math.min(...xs);
  const xHi = Math.max(...xs);
  let yLo = Math.min(0, ...ys);
  let yHi = Math.max(0, ...ys);
  if (yHi - yLo < 0.5) {
    const mid = (yHi + yLo) / 2;
    yLo = mid - 0.25;
    yHi = mid + 0.25;
  }

  const xPix = (v: number) => PAD.left + (xHi - xLo < 1e-9 ? w / 2 : ((v - xLo) / (xHi - xLo)) * w);
  const yPix = (v: number) => PAD.top + h - ((v - yLo) / (yHi - yLo)) * h;

  const xTick = options.xTick ?? ((v: number) => v.toFixed(0));
  const yTick = options.yTick ?? ((v: number) => v.toFixed(1));

  const gridRows = niceTicks(yLo, yHi)
    .map(
      (t) =>
        `<line class="grid" x1="${PAD.left}" x2="${PAD.left + w}" y1="${fmt(yPix(t))}" y2="${fmt(
          yPix(t),
        )}"/>` +
        `<text class="axis" x="${PAD.left - 8}" y="${fmt(yPix(t) + 3.5)}" text-anchor="end">${esc(
          yTick(t),
        )}</text>`,
    )
    .join("\n  ");

  // One x tick per distinct tested value keeps the axis honest about how few
  // ticket sizes were actually simulated.
  const distinctX = [...new Set(xs)].sort((a, b) => a - b);
  const xTicks = distinctX
    .map(
      (v) =>
        `<line class="grid" x1="${fmt(xPix(v))}" x2="${fmt(xPix(v))}" y1="${PAD.top}" y2="${
          PAD.top + h
        }" opacity="0.35"/>` +
        `<text class="axis" x="${fmt(xPix(v))}" y="${PAD.top + h + 14}" text-anchor="middle">${esc(
          xTick(v),
        )}</text>`,
    )
    .join("\n  ");

  const zero =
    yLo < 0 && yHi > 0
      ? `<line class="zero" x1="${PAD.left}" x2="${PAD.left + w}" y1="${fmt(yPix(0))}" y2="${fmt(
          yPix(0),
        )}"/>`
      : "";

  const paths = plotted
    .map((s) => {
      const pts = [...s.points].sort((a, b) => a.x - b.x);
      const d = pts
        .map((p, i) => `${i === 0 ? "M" : "L"}${fmt(xPix(p.x))} ${fmt(yPix(p.y))}`)
        .join(" ");
      const dots = pts
        .map(
          (p) =>
            `<circle class="dot" cx="${fmt(xPix(p.x))}" cy="${fmt(yPix(p.y))}" r="3" fill="${
              s.colour
            }"><title>${esc(
              p.note ?? `${s.label}: ${xTick(p.x)} → ${yTick(p.y)}`,
            )}</title></circle>`,
        )
        .join("");
      return `<path class="line" stroke="${s.colour}"${
        s.dashed ? ' stroke-dasharray="5 4"' : ""
      } d="${d}"/>${dots}`;
    })
    .join("\n  ");

  return `<svg viewBox="0 0 ${size.width} ${size.height}" class="chart" role="img" aria-label="${esc(
    options.title,
  )}">
  <text class="chart-title" x="${PAD.left}" y="11">${esc(options.title)}</text>
  ${gridRows}
  ${xTicks}
  ${zero}
  ${paths}
  <text class="axis-label" x="${PAD.left}" y="${size.height - 4}">${esc(options.xLabel)}</text>
  <text class="axis-label" x="${size.width - PAD.right}" y="${size.height - 4}" text-anchor="end">${esc(
    options.yLabel,
  )}</text>
</svg>`;
}

export type CostReturnOptions = {
  /** Baseline (scale = 1) friction model the sweep multiplied. */
  baseFrictions: Frictions;
  /** Account size used to turn a sleeve weight into a ticket notional. */
  startingCash: number;
  /** Ticket axis, in the order they should appear. */
  tickets: readonly TicketSpec[];
  /** Style to chart — the breakeven question is asked of swing by default. */
  style?: string;
  /** Currency prefix for ticket labels. */
  currencySymbol?: string;
  colours?: readonly string[];
};

const DEFAULT_COLOURS = ["#39d98a", "#4ea1ff", "#f5a623", "#e5484d", "#a78bfa", "#9aa4b2"];

/** Distinct cost scales present in the cells, ascending. */
export function costScales(cells: readonly SweepCell[]): number[] {
  return [...new Set(cells.map((c) => c.scenario.scale))].sort((a, b) => a - b);
}

/**
 * Net return as a function of ticket notional, one line per cost scale, plus
 * the buy & hold reference. This is the "cost vs return" view: vertical spread
 * between the lines at a given ticket is exactly what costs are taking.
 */
export function buildCostReturnChart(
  cells: readonly SweepCell[],
  opts: CostReturnOptions,
): string {
  const ccy = opts.currencySymbol ?? "£";
  const colours = opts.colours ?? DEFAULT_COLOURS;
  const scales = costScales(cells);

  const series: XYSeries[] = scales.map((scale, i) => ({
    label: scale === 1 ? "baseline cost" : `${(scale * 100).toFixed(0)}% cost`,
    colour: colours[i % colours.length]!,
    points: opts.tickets
      .map((t) => {
        const cell = cells.find(
          (c) => c.ticket.label === t.label && c.scenario.scale === scale,
        );
        if (!cell) return null;
        const tv = ticketValue(opts.startingCash, t);
        return {
          x: tv,
          y: cell.totalReturnPct,
          note: `${t.label} · ticket ${ccy}${tv.toFixed(0)} · ${(scale * 100).toFixed(
            0,
          )}% cost → ${cell.totalReturnPct.toFixed(1)}% net (fees ${cell.feeDragPct.toFixed(
            1,
          )}%, ${cell.trades} trades)`,
        } satisfies XYPoint;
      })
      .filter((p): p is XYPoint => p !== null),
  }));

  const bench = cells[0]?.benchmarkReturnPct;
  if (bench !== undefined && Number.isFinite(bench)) {
    series.push({
      label: "buy & hold",
      colour: "#9aa4b2",
      dashed: true,
      points: opts.tickets.map((t) => {
        const tv = ticketValue(opts.startingCash, t);
        return { x: tv, y: bench, note: `buy & hold ${bench.toFixed(1)}%` };
      }),
    });
  }

  return renderXYChart(series, {
    title: "Net return vs ticket size",
    xLabel: `ticket notional (${ccy})`,
    yLabel: "net return %",
    xTick: (v) => `${ccy}${Math.round(v).toLocaleString("en-GB")}`,
    yTick: (v) => `${v.toFixed(0)}%`,
  });
}

export type BreakevenPoint = {
  ticket: TicketSpec;
  ticketNotional: number;
  /** Actual all-in round-trip cost of this ticket at baseline frictions. */
  baselineBps: number;
  /** Cost (bps) at which net return crosses zero. Null = never crosses. */
  breakevenZeroBps: number | null;
  /** Cost (bps) at which net return crosses buy & hold. */
  breakevenBenchBps: number | null;
  /** True when the ticket is viable at today's real costs. */
  viableAtBaseline: boolean;
};

/**
 * The breakeven curve itself: for each ticket size, the cost level where the
 * strategy stops paying, expressed in round-trip bps so it is comparable with
 * the baseline cost of that same ticket.
 */
export function buildBreakevenCurve(
  cells: readonly SweepCell[],
  opts: CostReturnOptions,
): BreakevenPoint[] {
  return opts.tickets.map((t) => {
    const series = cells.filter((c) => c.ticket.label === t.label);
    const tv = ticketValue(opts.startingCash, t);
    const shared = { baseFrictions: opts.baseFrictions, ticketValue: tv };
    const zero = findBreakevenScale(series as SweepCell[], shared);
    const bench = findBreakevenScale(series as SweepCell[], { ...shared, target: "benchmark" });
    const baselineBps = roundTripCostBps(opts.baseFrictions, tv);
    // "always" means viable even at the highest cost swept, so the breakeven
    // sits at or above that point rather than being unknown.
    const zeroBps = zero.verdict === "never" ? null : zero.roundTripBps;
    return {
      ticket: t,
      ticketNotional: tv,
      baselineBps,
      breakevenZeroBps: zeroBps,
      breakevenBenchBps: bench.verdict === "never" ? null : bench.roundTripBps,
      viableAtBaseline: zeroBps !== null && zeroBps >= baselineBps,
    };
  });
}

/**
 * Breakeven cost curve chart. Two curves (vs zero, vs buy & hold) against the
 * actual baseline cost line: any ticket whose baseline sits under a breakeven
 * curve clears that bar.
 */
export function buildBreakevenChart(
  points: readonly BreakevenPoint[],
  opts: Pick<CostReturnOptions, "currencySymbol">,
): string {
  const ccy = opts.currencySymbol ?? "£";
  const series: XYSeries[] = [
    {
      label: "breakeven vs zero",
      colour: "#39d98a",
      points: points
        .filter((p) => p.breakevenZeroBps !== null)
        .map((p) => ({
          x: p.ticketNotional,
          y: p.breakevenZeroBps!,
          note: `${p.ticket.label}: breaks even at ${p.breakevenZeroBps!.toFixed(
            0,
          )} bps round trip (actual ${p.baselineBps.toFixed(0)} bps)`,
        })),
    },
    {
      label: "breakeven vs buy & hold",
      colour: "#4ea1ff",
      points: points
        .filter((p) => p.breakevenBenchBps !== null)
        .map((p) => ({
          x: p.ticketNotional,
          y: p.breakevenBenchBps!,
          note: `${p.ticket.label}: beats buy & hold below ${p.breakevenBenchBps!.toFixed(0)} bps`,
        })),
    },
    {
      label: "actual cost at baseline",
      colour: "#e5484d",
      dashed: true,
      points: points.map((p) => ({
        x: p.ticketNotional,
        y: p.baselineBps,
        note: `${p.ticket.label}: ${p.baselineBps.toFixed(0)} bps round trip on a ${ccy}${p.ticketNotional.toFixed(
          0,
        )} ticket`,
      })),
    },
  ];

  return renderXYChart(series, {
    title: "Breakeven cost vs ticket size (above the red line = viable)",
    xLabel: `ticket notional (${ccy})`,
    yLabel: "round-trip cost (bps)",
    xTick: (v) => `${ccy}${Math.round(v).toLocaleString("en-GB")}`,
    yTick: (v) => `${v.toFixed(0)}`,
  });
}

/**
 * One report panel per risk level: the cost-vs-return chart, the breakeven
 * curve, and a table naming the smallest viable ticket.
 */
export function buildCostReturnPanels(
  cells: readonly SweepCell[],
  opts: CostReturnOptions,
): ReportPanel[] {
  const style = opts.style ?? "swing";
  const ccy = opts.currencySymbol ?? "£";
  const styleCells = cells.filter((c) => c.style === style);
  const riskLevels = [...new Set(styleCells.map((c) => c.riskLevel))];

  return riskLevels.map((riskLevel) => {
    const scoped = styleCells.filter((c) => c.riskLevel === riskLevel);
    const points = buildBreakevenCurve(scoped, opts);
    const firstViable = points.find((p) => p.viableAtBaseline);

    return {
      heading: `${riskLevel} risk · ${style} · cost vs return`,
      subtitle: firstViable
        ? `viable from a ${ccy}${firstViable.ticketNotional.toFixed(0)} ticket (${
            firstViable.ticket.label
          }) at today's costs`
        : `no swept ticket size clears today's costs`,
      series: [],
      charts: [
        buildCostReturnChart(scoped, opts),
        buildBreakevenChart(points, { currencySymbol: ccy }),
      ],
      legend: [
        { label: "breakeven vs zero", colour: "#39d98a" },
        { label: "breakeven vs buy & hold", colour: "#4ea1ff" },
        { label: "actual cost at baseline", colour: "#e5484d", dashed: true },
      ],
      table: {
        columns: [
          "ticket",
          "notional",
          "actual bps",
          "breakeven bps (zero)",
          "breakeven bps (B&H)",
          "viable now",
        ],
        rows: points.map((p) => [
          p.ticket.label,
          `${ccy}${p.ticketNotional.toFixed(0)}`,
          p.baselineBps.toFixed(0),
          p.breakevenZeroBps === null ? "never" : p.breakevenZeroBps.toFixed(0),
          p.breakevenBenchBps === null ? "never" : p.breakevenBenchBps.toFixed(0),
          p.viableAtBaseline ? "yes" : "no",
        ]),
      },
    } satisfies ReportPanel;
  });
}
