/**
 * Pure SVG renderers for the swing-vs-position backtest report.
 *
 * Kept dependency-free (string output only) so the comparison script can write
 * a self-contained HTML file from Bun with no browser or chart library.
 */
import type { EquityPoint } from "@/lib/backtest-metrics";

/** One executed fill, keyed by the bar date it settled on. */
export type ChartTrade = {
  date: string;
  side: "buy" | "sell";
  symbol?: string;
  quantity?: number;
  price?: number;
};

/** Per-bar aggregate of the fills that happened on that bar. */
export type BarTrades = {
  buys: number;
  sells: number;
  /** Short human summary, e.g. "BUY AAPL ×10, SELL MSFT ×4". */
  summary: string;
};

export type ChartSeries = {
  label: string;
  colour: string;
  /** Dashed rendering — used to distinguish the control (heuristic) layer. */
  dashed?: boolean;
  curve: readonly EquityPoint[];
  /** Executed fills to overlay as buy/sell markers. */
  trades?: readonly ChartTrade[];
};

/**
 * Group fills onto bar indexes of `curve`. Fills whose date is not a bar in
 * the curve are dropped (they cannot be placed on the x-axis).
 */
export function buildTradeMarkers(
  curve: readonly EquityPoint[],
  trades: readonly ChartTrade[] = [],
): Map<number, BarTrades> {
  const indexByDate = new Map<string, number>();
  curve.forEach((p, i) => {
    if (!indexByDate.has(p.snapshot_date)) indexByDate.set(p.snapshot_date, i);
  });
  const out = new Map<number, BarTrades>();
  const parts = new Map<number, string[]>();
  for (const t of trades) {
    const i = indexByDate.get(t.date);
    if (i === undefined) continue;
    const bucket = out.get(i) ?? { buys: 0, sells: 0, summary: "" };
    if (t.side === "buy") bucket.buys += 1;
    else bucket.sells += 1;
    out.set(i, bucket);
    const list = parts.get(i) ?? [];
    if (list.length < 4) {
      const qty = Number.isFinite(t.quantity) ? ` ×${t.quantity}` : "";
      list.push(`${t.side.toUpperCase()} ${t.symbol ?? ""}${qty}`.replace(/\s+/g, " ").trim());
    }
    parts.set(i, list);
  }
  for (const [i, bucket] of out) {
    const list = parts.get(i) ?? [];
    const extra = bucket.buys + bucket.sells - list.length;
    bucket.summary = list.join(", ") + (extra > 0 ? ` +${extra} more` : "");
  }
  return out;
}


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
    /** Fill summary per index; null when nothing traded on that bar. */
    trades: (string | null)[];
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

  const markersBySeries = plotted.map(({ s }) => buildTradeMarkers(s.curve, s.trades ?? []));

  // Buy = upward triangle under the point, sell = downward triangle above it.
  const tradeMarks = plotted
    .map(({ s, ys }, idx) => {
      const marks: string[] = [];
      for (const [i, bar] of markersBySeries[idx] ?? new Map<number, BarTrades>()) {
        const v = at(ys, i);
        if (v === null) continue;
        const cx = x(i);
        const cy = y(v);
        const tip = esc(`${labels[i]} — ${bar.summary}`);
        if (bar.buys > 0) {
          marks.push(
            `<polygon class="trade buy" fill="${s.colour}" points="${fmt(cx)},${fmt(cy + 5)} ${fmt(cx - 4)},${fmt(cy + 12)} ${fmt(cx + 4)},${fmt(cy + 12)}"><title>${tip}</title></polygon>`,
          );
        }
        if (bar.sells > 0) {
          marks.push(
            `<polygon class="trade sell" fill="${s.colour}" points="${fmt(cx)},${fmt(cy - 5)} ${fmt(cx - 4)},${fmt(cy - 12)} ${fmt(cx + 4)},${fmt(cy - 12)}"><title>${tip}</title></polygon>`,
          );
        }
      }
      return marks.join("\n  ");
    })
    .filter(Boolean)
    .join("\n  ");

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
    series: plotted.map(({ s, ys }, idx) => ({
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
      trades: Array.from(
        { length: maxLen },
        (_, i) => markersBySeries[idx]?.get(i)?.summary ?? null,
      ),
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
  ${tradeMarks}
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

/** Wrap a chart SVG with the positioned tooltip element the hover script fills. */
export const withHoverTooltip = (svg: string) =>
  `<figure class="chart-wrap">${svg}<div class="chart-tip" hidden></div></figure>`;

/** Inline script that drives crosshair + tooltip for every chart on the page. */
export const HOVER_SCRIPT = `
(function () {
  var f2 = function (v) { return v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2); };
  document.querySelectorAll('.chart-wrap').forEach(function (wrap) {
    var svg = wrap.querySelector('svg.chart');
    var tip = wrap.querySelector('.chart-tip');
    if (!svg || !tip || !svg.dataset.hover) return;
    var data = JSON.parse(svg.dataset.hover);
    var layer = svg.querySelector('.hover');
    var cross = svg.querySelector('.hover .cross');
    var dots = svg.querySelectorAll('.hover .dot');
    if (!data.xs.length) return;

    function hide() { if (layer) layer.style.display = 'none'; tip.hidden = true; }

    function move(ev) {
      var r = svg.getBoundingClientRect();
      var vb = svg.viewBox.baseVal;
      var ux = (ev.clientX - r.left) / r.width * (vb.width || r.width);
      var best = 0, bestD = Infinity;
      for (var i = 0; i < data.xs.length; i++) {
        var d = Math.abs(data.xs[i] - ux);
        if (d < bestD) { bestD = d; best = i; }
      }
      var ux2 = data.xs[best];
      if (layer) layer.style.display = '';
      if (cross) { cross.setAttribute('x1', ux2); cross.setAttribute('x2', ux2); }
      var rows = '';
      data.series.forEach(function (s, k) {
        var dot = dots[k];
        var py = s.px[best];
        if (dot) {
          if (py === null) { dot.setAttribute('cx', -99); dot.setAttribute('cy', -99); }
          else { dot.setAttribute('cx', ux2); dot.setAttribute('cy', py); }
        }
        rows += '<div class="tip-row"><span class="tip-swatch" style="background:' + s.colour + '"></span>' +
          '<span class="tip-label">' + s.label + '</span>' +
          '<span class="tip-val">' + f2(s.equity[best]) + '%</span>' +
          '<span class="tip-dd">' + f2(s.drawdown[best]) + '%</span></div>';
        var tr = s.trades && s.trades[best];
        if (tr) rows += '<div class="tip-trade">' + tr + '</div>';
      });
      tip.innerHTML = '<div class="tip-head">' + data.labels[best] + '</div>' +
        '<div class="tip-row tip-head-row"><span class="tip-swatch"></span><span class="tip-label"></span>' +
        '<span class="tip-val">equity</span><span class="tip-dd">drawdown</span></div>' + rows;
      tip.hidden = false;
      var px = ux2 / (vb.width || r.width) * r.width;
      var left = Math.min(Math.max(px + 12, 4), r.width - tip.offsetWidth - 4);
      tip.style.left = left + 'px';
      tip.style.top = '8px';
    }

    svg.addEventListener('mousemove', move);
    svg.addEventListener('mouseleave', hide);
    svg.addEventListener('touchmove', function (e) { if (e.touches[0]) move(e.touches[0]); }, { passive: true });
    svg.addEventListener('touchend', hide);
  });
})();
`;

export function renderLegend(series: readonly ChartSeries[]): string {
  const tradeKey = series.some((s) => (s.trades?.length ?? 0) > 0)
    ? `<li class="legend-trades">&#9650; buy &nbsp;&#9660; sell</li>`
    : "";
  return `<ul class="legend">${series
    .map(
      (s) =>
        `<li><span class="swatch${s.dashed ? " dashed" : ""}" style="--c:${s.colour}"></span>${esc(s.label)}</li>`,
    )
    .join("")}${tradeKey}</ul>`;

}

/**
 * A table row. Plain string arrays still work; the tagged form lets the report
 * filter rows client-side (e.g. by risk level or ticket-size band).
 */
export type ReportTableRow = string[] | { cells: string[]; tags?: Record<string, string> };

/** A group of toggle chips rendered in the report toolbar. */
export type ReportFilterGroup = {
  /** Tag key rows/panels are matched on. */
  key: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  /** Values selected on load. Defaults to all options. */
  selected?: string[];
  /** "single" behaves like radio buttons. Default "multi". */
  mode?: "single" | "multi";
};

export type ReportPanel = {
  /** e.g. "balanced risk" */
  heading: string;
  subtitle?: string;
  series: ChartSeries[];
  /**
   * Pre-rendered SVG charts. When present these replace the default
   * equity/drawdown pair, so a panel can carry a different kind of chart
   * (e.g. the cost-vs-return and breakeven curves) inside the same report.
   */
  charts?: string[];
  /** Legend entries for pre-rendered charts, which have no ChartSeries. */
  legend?: { label: string; colour: string; dashed?: boolean }[];
  /** Optional rows appended under the charts as a small metric table. */
  table?: { columns: string[]; rows: ReportTableRow[] };
  /** Filter tags for the whole panel; the panel hides when they are unselected. */
  tags?: Record<string, string>;
};

const rowCells = (r: ReportTableRow): string[] => (Array.isArray(r) ? r : r.cells);
const rowTags = (r: ReportTableRow): Record<string, string> =>
  Array.isArray(r) ? {} : (r.tags ?? {});

const tagAttrs = (tags: Record<string, string>): string =>
  Object.entries(tags)
    .map(([k, v]) => ` data-f-${esc(k)}="${esc(v)}"`)
    .join("");

/** Toolbar markup for the filter chip groups. */
export function renderFilterBar(groups: readonly ReportFilterGroup[]): string {
  if (groups.length === 0) return "";
  const bar = groups
    .map((g) => {
      const selected = new Set(g.selected ?? g.options.map((o) => o.value));
      const chips = g.options
        .map(
          (o) =>
            `<button type="button" class="chip${selected.has(o.value) ? " on" : ""}" ` +
            `data-key="${esc(g.key)}" data-value="${esc(o.value)}" ` +
            `data-mode="${esc(g.mode ?? "multi")}" aria-pressed="${selected.has(o.value)}">` +
            `${esc(o.label)}</button>`,
        )
        .join("");
      const all =
        (g.mode ?? "multi") === "multi"
          ? `<button type="button" class="chip all" data-key="${esc(g.key)}" data-all="1">all</button>`
          : "";
      return `<div class="filter-group"><span class="filter-label">${esc(g.label)}</span>${chips}${all}</div>`;
    })
    .join("");
  return `<div class="filters" id="report-filters">${bar}<span class="filter-count" id="filter-count"></span></div>`;
}

/** Client-side filtering: chips toggle `data-f-*` tags on rows and panels. */
export const FILTER_SCRIPT = `
(function () {
  var bar = document.getElementById('report-filters');
  if (!bar) return;
  var state = {};
  bar.querySelectorAll('.chip[data-value]').forEach(function (c) {
    var k = c.dataset.key;
    state[k] = state[k] || { mode: c.dataset.mode || 'multi', on: new Set(), all: new Set() };
    state[k].all.add(c.dataset.value);
    if (c.classList.contains('on')) state[k].on.add(c.dataset.value);
  });
  function visible(el) {
    for (var k in state) {
      var tag = el.dataset['f' + k.charAt(0).toUpperCase() + k.slice(1).replace(/-(.)/g, function (m, c) { return c.toUpperCase(); })];
      if (tag == null) continue;
      if (!state[k].on.has(tag)) return false;
    }
    return true;
  }
  function apply() {
    var shown = 0, total = 0;
    document.querySelectorAll('tbody tr').forEach(function (tr) {
      total++;
      var ok = visible(tr);
      tr.hidden = !ok;
      if (ok) shown++;
    });
    document.querySelectorAll('section.panel').forEach(function (p) {
      var ok = visible(p);
      var body = p.querySelector('tbody');
      if (ok && body && !p.querySelector('.charts svg')) {
        ok = Array.prototype.some.call(body.rows, function (r) { return !r.hidden; });
      }
      p.hidden = !ok;
    });
    var out = document.getElementById('filter-count');
    if (out) out.textContent = shown === total ? total + ' rows' : shown + ' of ' + total + ' rows';
  }
  bar.addEventListener('click', function (e) {
    var c = e.target.closest('.chip');
    if (!c) return;
    var k = c.dataset.key, s = state[k];
    if (!s) return;
    if (c.dataset.all) {
      s.on = new Set(s.all);
    } else if (s.mode === 'single') {
      s.on = new Set([c.dataset.value]);
    } else if (s.on.has(c.dataset.value)) {
      if (s.on.size > 1) s.on.delete(c.dataset.value);
    } else {
      s.on.add(c.dataset.value);
    }
    bar.querySelectorAll('.chip[data-key="' + k + '"][data-value]').forEach(function (b) {
      var on = s.on.has(b.dataset.value);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    apply();
  });
  apply();
})();
`;


/** Self-contained HTML report: one panel per risk level, two charts each. */
export function renderBacktestReportHtml(args: {
  title: string;
  subtitle?: string;
  panels: readonly ReportPanel[];
  /** Optional toggle chips (e.g. risk level, ticket-size band). */
  filters?: readonly ReportFilterGroup[];
}): string {
  const panels = args.panels
    .map(
      (p) => `<section class="panel"${tagAttrs(p.tags ?? {})}>
  <h2>${esc(p.heading)}</h2>
  ${p.subtitle ? `<p class="sub">${esc(p.subtitle)}</p>` : ""}
  ${renderLegend(
    p.legend
      ? p.legend.map((l) => ({ label: l.label, colour: l.colour, dashed: l.dashed, curve: [] }))
      : p.series,
  )}
  <div class="charts">
    ${
      p.charts?.length
        ? p.charts.join("\n    ")
        : `${withHoverTooltip(renderEquityChart(p.series, "Equity curve (% from start)"))}
    ${withHoverTooltip(renderDrawdownChart(p.series, "Drawdown (% from high-water mark)"))}`
    }
  </div>

  ${
    p.table
      ? `<table><thead><tr>${p.table.columns
          .map((c) => `<th>${esc(c)}</th>`)
          .join("")}</tr></thead><tbody>${p.table.rows
          .map(
            (r) =>
              `<tr${tagAttrs(rowTags(r))}>${rowCells(r)
                .map((c) => `<td>${esc(c)}</td>`)
                .join("")}</tr>`,
          )
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
  .chart-wrap { position:relative; margin:0; }
  .hit { cursor:crosshair; }
  .cross { stroke:var(--muted); stroke-width:1; stroke-dasharray:3 3; opacity:.8; }
  .dot { stroke:var(--panel); stroke-width:1.5; }
  .trade { fill-opacity:.95; stroke:var(--panel); stroke-width:.6; }
  .trade.sell { fill-opacity:.55; }
  .tip-trade { grid-column:1/-1; color:var(--ink); opacity:.8; font-size:10px;
               margin:0 0 3px 14px; white-space:normal; }
  .chart-tip { position:absolute; pointer-events:none; z-index:2; min-width:190px;
               background:rgba(11,18,32,.96); border:1px solid var(--grid); border-radius:8px;
               padding:6px 8px; font-size:11px; box-shadow:0 6px 18px rgba(0,0,0,.45); }
  .chart-tip[hidden] { display:none; }
  .tip-head { color:var(--muted); margin-bottom:4px; }
  .tip-head-row { color:var(--muted); }
  .tip-row { display:grid; grid-template-columns:10px 1fr auto auto; gap:6px; align-items:center;
             white-space:nowrap; }
  .tip-swatch { width:8px; height:8px; border-radius:2px; }
  .tip-val, .tip-dd { font-variant-numeric:tabular-nums; text-align:right; min-width:56px; }
  .tip-dd { color:var(--muted); }
</style></head>
<body>
  <h1>${esc(args.title)}</h1>
  ${args.subtitle ? `<p class="lead">${esc(args.subtitle)}</p>` : ""}
  ${panels}
<script>${HOVER_SCRIPT}</script>
</body></html>`;

}
