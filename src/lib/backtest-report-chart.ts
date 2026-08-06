/**
 * Pure SVG renderers for the swing-vs-position backtest report.
 *
 * Kept dependency-free (string output only) so the comparison script can write
 * a self-contained HTML file from Bun with no browser or chart library.
 */
import type { EquityPoint } from "@/lib/backtest-metrics";

export type ChartSeries = {
  label: string;
  colour: string;
  /** Dashed rendering — used to distinguish the control (heuristic) layer. */
  dashed?: boolean;
  curve: readonly EquityPoint[];
};

export type ChartSize = { width: number; height: number };

const PAD = { top: 16, right: 14, bottom: 26, left: 52 };
const DEFAULT_SIZE: ChartSize = { width: 620, height: 260 };

/** Percent change from the first point of the curve. */
export function toReturnPct(curve: readonly EquityPoint[]): number[] {
  const base = curve[0]?.total_value ?? 0;
  if (base <= 0) return curve.map(() => 0);
  return curve.map((p) => (p.total_value / base - 1) * 100);
}

/** Percent below the running high-water mark at each point (<= 0). */
export function toDrawdownPct(curve: readonly EquityPoint[]): number[] {
  let peak = -Infinity;
  return curve.map((p) => {
    peak = Math.max(peak, p.total_value);
    return peak > 0 ? (p.total_value / peak - 1) * 100 : 0;
  });
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "0.00");

function niceTicks(min: number, max: number, count = 4): number[] {
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

type PlotOptions = {
  title: string;
  yLabel: string;
  /** Fill the area between the line and zero (used for drawdown). */
  fillToZero?: boolean;
  size?: ChartSize;
  /** Disable the hover crosshair/tooltip scaffolding. */
  interactive?: boolean;
};

/** One hoverable x position, shared by every series in a chart. */
export type HoverPayload = {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  xs: number[];
  labels: string[];
  unit: string;
  series: {
    label: string;
    colour: string;
    /** Pixel y of the plotted metric, per index. */
    px: (number | null)[];
    equity: (number | null)[];
    drawdown: (number | null)[];
  }[];
};

const at = (arr: number[], i: number): number | null =>
  i < arr.length && Number.isFinite(arr[i] as number) ? (arr[i] as number) : null;


/**
 * Line chart of one value per bar for each series. Series may have different
 * lengths; the x-axis spans the longest one.
 */
export function renderLineChart(
  series: readonly ChartSeries[],
  values: (s: ChartSeries) => number[],
  options: PlotOptions,
): string {
  const size = options.size ?? DEFAULT_SIZE;
  const plotted = series
    .map((s) => ({ s, ys: values(s) }))
    .filter((p) => p.ys.length > 1);
  const w = size.width - PAD.left - PAD.right;
  const h = size.height - PAD.top - PAD.bottom;

  if (plotted.length === 0) {
    return `<svg viewBox="0 0 ${size.width} ${size.height}" class="chart" role="img" aria-label="${esc(options.title)} (no data)">
  <text x="${size.width / 2}" y="${size.height / 2}" class="empty" text-anchor="middle">no data</text>
</svg>`;
  }

  const maxLen = Math.max(...plotted.map((p) => p.ys.length));
  const all = plotted.flatMap((p) => p.ys);
  let lo = Math.min(0, ...all);
  let hi = Math.max(0, ...all);
  if (hi - lo < 0.5) {
    // Keep flat curves readable instead of collapsing onto the axis.
    const mid = (hi + lo) / 2;
    lo = mid - 0.25;
    hi = mid + 0.25;
  }
  const x = (i: number) => PAD.left + (maxLen > 1 ? (i / (maxLen - 1)) * w : w / 2);
  const y = (v: number) => PAD.top + h - ((v - lo) / (hi - lo)) * h;

  const gridRows = niceTicks(lo, hi)
    .map(
      (t) =>
        `<line class="grid" x1="${PAD.left}" x2="${PAD.left + w}" y1="${fmt(y(t))}" y2="${fmt(y(t))}"/>` +
        `<text class="axis" x="${PAD.left - 8}" y="${fmt(y(t) + 3.5)}" text-anchor="end">${t.toFixed(1)}</text>`,
    )
    .join("\n  ");

  const zero =
    lo < 0 && hi > 0
      ? `<line class="zero" x1="${PAD.left}" x2="${PAD.left + w}" y1="${fmt(y(0))}" y2="${fmt(y(0))}"/>`
      : "";

  const paths = plotted
    .map(({ s, ys }, idx) => {
      const d = ys.map((v, i) => `${i === 0 ? "M" : "L"}${fmt(x(i))} ${fmt(y(v))}`).join(" ");
      const area = options.fillToZero
        ? `<path class="area" fill="${s.colour}" fill-opacity="0.12" d="${d} L${fmt(x(ys.length - 1))} ${fmt(y(0))} L${fmt(x(0))} ${fmt(y(0))} Z"/>`
        : "";
      return `${area}<path class="line" data-series="${idx}" stroke="${s.colour}"${s.dashed ? ' stroke-dasharray="5 4"' : ""} d="${d}"/>`;
    })
    .join("\n  ");

  const labels = Array.from({ length: maxLen }, (_, i) => {
    const date = plotted.map((p) => p.s.curve[i]?.snapshot_date).find(Boolean);
    return date ? `bar ${i} · ${date}` : `bar ${i}`;
  });

  const xTicks = [0, Math.floor((maxLen - 1) / 2), maxLen - 1]
    .map(
      (i) =>
        `<text class="axis" x="${fmt(x(i))}" y="${size.height - 8}" text-anchor="middle">bar ${i}</text>`,
    )
    .join("\n  ");

  const interactive = options.interactive !== false;
  const hover: HoverPayload = {
    x0: PAD.left,
    x1: PAD.left + w,
    top: PAD.top,
    bottom: PAD.top + h,
    xs: Array.from({ length: maxLen }, (_, i) => Number(fmt(x(i)))),
    labels,
    unit: options.yLabel,
    series: plotted.map(({ s, ys }) => ({
      label: s.label,
      colour: s.colour,
      px: Array.from({ length: maxLen }, (_, i) => {
        const v = at(ys, i);
        return v === null ? null : Number(fmt(y(v)));
      }),
      equity: (() => {
        const e = toReturnPct(s.curve);
        return Array.from({ length: maxLen }, (_, i) => at(e, i));
      })(),
      drawdown: (() => {
        const d = toDrawdownPct(s.curve);
        return Array.from({ length: maxLen }, (_, i) => at(d, i));
      })(),
    })),
  };

  const hoverLayer = interactive
    ? `<g class="hover" style="display:none">
    <line class="cross" y1="${PAD.top}" y2="${PAD.top + h}" x1="0" x2="0"/>
    ${hover.series
      .map((s) => `<circle class="dot" r="3.5" fill="${s.colour}" cx="-99" cy="-99"/>`)
      .join("\n    ")}
  </g>
  <rect class="hit" x="${PAD.left}" y="${PAD.top}" width="${w}" height="${h}" fill="transparent"/>`
    : "";

  return `<svg viewBox="0 0 ${size.width} ${size.height}" class="chart"${
    interactive ? ` data-hover="${esc(JSON.stringify(hover))}"` : ""
  } role="img" aria-label="${esc(options.title)}">
  <text class="chart-title" x="${PAD.left}" y="11">${esc(options.title)}</text>
  <text class="axis-label" x="${PAD.left - 8}" y="11" text-anchor="end">${esc(options.yLabel)}</text>
  ${gridRows}
  ${zero}
  ${paths}
  ${xTicks}
  ${hoverLayer}
</svg>`;

}

export const renderEquityChart = (series: readonly ChartSeries[], title: string, size?: ChartSize) =>
  renderLineChart(series, (s) => toReturnPct(s.curve), {
    title,
    yLabel: "%",
    ...(size ? { size } : {}),
  });

export const renderDrawdownChart = (series: readonly ChartSeries[], title: string, size?: ChartSize) =>
  renderLineChart(series, (s) => toDrawdownPct(s.curve), {
    title,
    yLabel: "%",
    fillToZero: true,
    ...(size ? { size } : {}),
  });

export function renderLegend(series: readonly ChartSeries[]): string {
  return `<ul class="legend">${series
    .map(
      (s) =>
        `<li><span class="swatch${s.dashed ? " dashed" : ""}" style="--c:${s.colour}"></span>${esc(s.label)}</li>`,
    )
    .join("")}</ul>`;
}

export type ReportPanel = {
  /** e.g. "balanced risk" */
  heading: string;
  subtitle?: string;
  series: ChartSeries[];
  /** Optional rows appended under the charts as a small metric table. */
  table?: { columns: string[]; rows: string[][] };
};

/** Self-contained HTML report: one panel per risk level, two charts each. */
export function renderBacktestReportHtml(args: {
  title: string;
  subtitle?: string;
  panels: readonly ReportPanel[];
}): string {
  const panels = args.panels
    .map(
      (p) => `<section class="panel">
  <h2>${esc(p.heading)}</h2>
  ${p.subtitle ? `<p class="sub">${esc(p.subtitle)}</p>` : ""}
  ${renderLegend(p.series)}
  <div class="charts">
    ${renderEquityChart(p.series, "Equity curve (% from start)")}
    ${renderDrawdownChart(p.series, "Drawdown (% from high-water mark)")}
  </div>
  ${
    p.table
      ? `<table><thead><tr>${p.table.columns
          .map((c) => `<th>${esc(c)}</th>`)
          .join("")}</tr></thead><tbody>${p.table.rows
          .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`
      : ""
  }
</section>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(args.title)}</title>
<style>
  :root { color-scheme: dark; --bg:#0b1220; --panel:#111a2b; --ink:#e6edf7; --muted:#8fa3bf; --grid:#22304a; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--ink);
         font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:15px; margin:0 0 2px; }
  .sub, .lead { color:var(--muted); font-size:12px; margin:0 0 10px; }
  .panel { background:var(--panel); border:1px solid var(--grid); border-radius:12px;
           padding:16px; margin:16px 0; }
  .charts { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:12px; }
  .chart { width:100%; height:auto; overflow:visible; }
  .line { fill:none; stroke-width:1.8; stroke-linejoin:round; stroke-linecap:round; }
  .grid { stroke:var(--grid); stroke-width:1; }
  .zero { stroke:var(--muted); stroke-width:1; stroke-dasharray:3 3; opacity:.7; }
  .axis, .axis-label, .empty { fill:var(--muted); font-size:10px; }
  .chart-title { fill:var(--ink); font-size:11px; font-weight:600; }
  .legend { list-style:none; display:flex; flex-wrap:wrap; gap:12px; padding:0; margin:0 0 8px;
            font-size:12px; color:var(--muted); }
  .legend li { display:flex; align-items:center; gap:6px; }
  .swatch { width:16px; height:0; border-top:3px solid var(--c); border-radius:2px; }
  .swatch.dashed { border-top-style:dashed; }
  table { width:100%; border-collapse:collapse; margin-top:12px; font-size:12px; }
  th, td { text-align:right; padding:4px 8px; border-bottom:1px solid var(--grid); }
  th:first-child, td:first-child { text-align:left; }
  th { color:var(--muted); font-weight:600; }
</style></head>
<body>
  <h1>${esc(args.title)}</h1>
  ${args.subtitle ? `<p class="lead">${esc(args.subtitle)}</p>` : ""}
  ${panels}
</body></html>`;
}
