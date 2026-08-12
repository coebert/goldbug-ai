import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import {
  buildScenarioReport,
  defaultScenarioSpecs,
  type BuildScenarioReportInput,
  type ScenarioReport,
} from "@/lib/scenario-report";
import { ExecutionCostHeatmaps } from "@/components/execution-cost-heatmaps";
import { CollapsibleLegend } from "@/components/ui/collapsible-legend";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART_ROLE,
  GRID_PROPS,
  LEGEND_PROPS,
  OKABE_ITO,
  TICK_LINE,
} from "@/lib/chart-palette";

const PALETTE = [
  OKABE_ITO.skyBlue,
  CHART_ROLE.positive,
  CHART_ROLE.benchmark,
  OKABE_ITO.reddishPurple,
  CHART_ROLE.negative,
];

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;
}
function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}
function fmtMoney(n: number): string {
  return Number.isFinite(n)
    ? n.toLocaleString(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      })
    : "—";
}

/**
 * Renders a full simulation performance report across a matrix of
 * broker-simulator scenarios: overlaid equity curves, overlaid
 * drawdown curves, and a per-scenario summary table.
 *
 * Pure presentational: takes decisions + initial state, runs the
 * default scenario matrix (frictionless/realistic/harsh × book depth)
 * on the client, and shows the results. Fed by any caller that can
 * describe a dated decision stream — the admin route wires it up to a
 * demo stream for now.
 */
export function ScenarioReportCard(props: { title?: string; input: BuildScenarioReportInput }) {
  const [visible, setVisible] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(props.input.scenarios.map((s) => [s.id, true])),
  );

  const reports = useMemo(() => buildScenarioReport(props.input), [props.input]);

  const equityChartData = useMemo(
    () => alignByDate(reports, (r) => r.equityCurve.map((p) => [p.date, p.equity])),
    [reports],
  );
  const drawdownChartData = useMemo(
    () => alignByDate(reports, (r) => r.drawdownCurve.map((p) => [p.date, p.drawdown])),
    [reports],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.title ?? "Simulation Performance Report"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-8">
        <ScenarioLegend
          reports={reports}
          visible={visible}
          onToggle={(id) => setVisible((v) => ({ ...v, [id]: !v[id] }))}
        />

        <section>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">Equity curve</h3>
          <div className="h-72 w-full">
            <ResponsiveContainer>
              <LineChart data={equityChartData}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis
                  dataKey="date"
                  tick={AXIS_TICK}
                  minTickGap={24}
                  axisLine={AXIS_LINE}
                  tickLine={TICK_LINE}
                />
                <YAxis
                  width={64}
                  tick={AXIS_TICK}
                  tickFormatter={(v) => Number(v).toLocaleString()}
                  axisLine={AXIS_LINE}
                  tickLine={TICK_LINE}
                />
                <Tooltip
                  formatter={(v: number) => fmtMoney(v)}
                  labelFormatter={(l) => `Date: ${l}`}
                />
                <Legend {...LEGEND_PROPS} content={<CollapsibleLegend />} />
                {reports.map(
                  (r, i) =>
                    visible[r.id] && (
                      <Line
                        key={r.id}
                        type="monotone"
                        dataKey={r.id}
                        name={r.label}
                        stroke={PALETTE[i % PALETTE.length]}
                        dot={false}
                        strokeWidth={2}
                        isAnimationActive={false}
                      />
                    ),
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">Drawdown (%)</h3>
          <div className="h-56 w-full">
            <ResponsiveContainer>
              <LineChart data={drawdownChartData}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis
                  dataKey="date"
                  tick={AXIS_TICK}
                  minTickGap={24}
                  axisLine={AXIS_LINE}
                  tickLine={TICK_LINE}
                />
                <YAxis
                  width={64}
                  tick={AXIS_TICK}
                  tickFormatter={(v) => `${Number(v).toFixed(1)}%`}
                  domain={["auto", 0]}
                  axisLine={AXIS_LINE}
                  tickLine={TICK_LINE}
                />
                <Tooltip
                  formatter={(v: number) => `${v.toFixed(2)}%`}
                  labelFormatter={(l) => `Date: ${l}`}
                />
                <Legend {...LEGEND_PROPS} content={<CollapsibleLegend />} />
                {reports.map(
                  (r, i) =>
                    visible[r.id] && (
                      <Line
                        key={r.id}
                        type="monotone"
                        dataKey={r.id}
                        name={r.label}
                        stroke={PALETTE[i % PALETTE.length]}
                        dot={false}
                        strokeWidth={2}
                        isAnimationActive={false}
                      />
                    ),
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        <ExecutionQualitySection reports={reports} visible={visible} />

        <CostBreakdownSection reports={reports} visible={visible} />

        <ExecutionCostHeatmaps reports={reports} visible={visible} />

        <section>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">Summary</h3>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scenario</TableHead>
                  <TableHead className="text-right">Ending equity</TableHead>
                  <TableHead className="text-right">Total return</TableHead>
                  <TableHead className="text-right">CAGR</TableHead>
                  <TableHead className="text-right">Sharpe</TableHead>
                  <TableHead className="text-right">Max DD</TableHead>
                  <TableHead className="text-right">Win rate</TableHead>
                  <TableHead className="text-right">Trades</TableHead>
                  <TableHead className="text-right">Fill ratio</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reports.map((r) => (
                  <TableRow key={r.id} data-testid={`scenario-row-${r.id}`}>
                    <TableCell className="font-medium">{r.label}</TableCell>
                    <TableCell className="text-right">{fmtMoney(r.summary.endEquity)}</TableCell>
                    <TableCell
                      className={`text-right ${
                        r.summary.totalReturnPct >= 0 ? "text-emerald-600" : "text-red-600"
                      }`}
                    >
                      {fmtPct(r.summary.totalReturnPct)}
                    </TableCell>
                    <TableCell className="text-right">{fmtPct(r.summary.cagrPct)}</TableCell>
                    <TableCell className="text-right">{fmtNum(r.summary.sharpe)}</TableCell>
                    <TableCell className="text-right text-red-600">
                      {fmtPct(r.summary.maxDrawdownPct)}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.summary.winRatePct == null ? "—" : `${r.summary.winRatePct.toFixed(1)}%`}
                    </TableCell>
                    <TableCell className="text-right">{r.summary.trades}</TableCell>
                    <TableCell className="text-right">
                      {(r.summary.fillRatio * 100).toFixed(1)}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

/**
 * Execution-quality dashboard: two overlaid charts plotted against the
 * per-decision execution timeline (decision index on the x-axis so
 * multiple orders on the same date remain distinguishable).
 *   1. Fill ratio per decision, per scenario (0..1).
 *   2. Liquidity-adjusted slippage in bps per decision, per scenario.
 * Points where the metric is unavailable (unfilled / unconstrained
 * book) are skipped by supplying `null`, which Recharts renders as a
 * gap in that scenario's line rather than a zero.
 */
function ExecutionQualitySection(props: {
  reports: ScenarioReport[];
  visible: Record<string, boolean>;
}) {
  const { reports, visible } = props;
  const fillData = useMemo(() => buildExecutionChartData(reports, (p) => p.fillRatio), [reports]);
  const liqSlipData = useMemo(
    () => buildExecutionChartData(reports, (p) => p.liquidityAdjustedSlippageBps),
    [reports],
  );
  const anyDecisions = fillData.length > 0;
  if (!anyDecisions) return null;

  return (
    <>
      <section>
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">Fill ratio per decision</h3>
        <div className="h-56 w-full">
          <ResponsiveContainer>
            <LineChart data={fillData}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis
                dataKey="label"
                tick={AXIS_TICK}
                minTickGap={16}
                axisLine={AXIS_LINE}
                tickLine={TICK_LINE}
              />
              <YAxis
                width={64}
                tick={AXIS_TICK}
                domain={[0, 1]}
                tickFormatter={(v) => `${Math.round(Number(v) * 100)}%`}
                axisLine={AXIS_LINE}
                tickLine={TICK_LINE}
              />
              <Tooltip
                formatter={(v: number) => `${(v * 100).toFixed(1)}%`}
                labelFormatter={(l) => `Decision: ${l}`}
              />
              <Legend {...LEGEND_PROPS} content={<CollapsibleLegend />} />
              {reports.map(
                (r, i) =>
                  visible[r.id] && (
                    <Line
                      key={r.id}
                      type="monotone"
                      dataKey={r.id}
                      name={r.label}
                      stroke={PALETTE[i % PALETTE.length]}
                      strokeWidth={2}
                      dot={{ r: 2 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  ),
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">
          Liquidity-adjusted slippage per decision (bps)
        </h3>
        <p className="mb-2 text-xs text-muted-foreground">
          Adverse slippage in basis points, normalised by the fraction of available liquidity
          consumed. Positive = costlier fills. Gaps indicate an unconstrained book or unfilled
          order.
        </p>
        <div className="h-56 w-full">
          <ResponsiveContainer>
            <LineChart data={liqSlipData}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis
                dataKey="label"
                tick={AXIS_TICK}
                minTickGap={16}
                axisLine={AXIS_LINE}
                tickLine={TICK_LINE}
              />
              <YAxis
                width={64}
                tick={AXIS_TICK}
                tickFormatter={(v) => `${Number(v).toFixed(0)}`}
                axisLine={AXIS_LINE}
                tickLine={TICK_LINE}
              />
              <Tooltip
                formatter={(v: number) => `${v.toFixed(2)} bps`}
                labelFormatter={(l) => `Decision: ${l}`}
              />
              <Legend {...LEGEND_PROPS} content={<CollapsibleLegend />} />
              {reports.map(
                (r, i) =>
                  visible[r.id] && (
                    <Line
                      key={r.id}
                      type="monotone"
                      dataKey={r.id}
                      name={r.label}
                      stroke={PALETTE[i % PALETTE.length]}
                      strokeWidth={2}
                      dot={{ r: 2 }}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  ),
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>
    </>
  );
}

/**
 * Build a row-per-decision dataset for the execution charts. The x-axis
 * key `label` uniquely identifies each decision (`date · SYMBOL SIDE`)
 * so multiple orders on the same date don't collapse into one x-value.
 * The decision universe is the UNION across scenarios, ordered by the
 * first scenario's `executionSeries` (decisions are input-order stable
 * across scenarios in practice, but we defensively support gaps).
 */
function buildExecutionChartData(
  reports: ScenarioReport[],
  pick: (p: ScenarioReport["executionSeries"][number]) => number | null,
): Array<Record<string, string | number | null>> {
  if (reports.length === 0) return [];
  // Preserve decision order by walking the longest series; then union
  // in any decisionIds unique to shorter/differently-ordered series.
  const orderRef = reports.reduce(
    (best, r) => (r.executionSeries.length > best.length ? r.executionSeries : best),
    reports[0].executionSeries,
  );
  const seen = new Set<string>();
  const orderedIds: string[] = [];
  const labelFor = new Map<string, string>();
  for (const p of orderRef) {
    if (!seen.has(p.decisionId)) {
      seen.add(p.decisionId);
      orderedIds.push(p.decisionId);
      labelFor.set(p.decisionId, `${p.date} · ${p.symbol} ${p.side}`);
    }
  }
  for (const r of reports) {
    for (const p of r.executionSeries) {
      if (!seen.has(p.decisionId)) {
        seen.add(p.decisionId);
        orderedIds.push(p.decisionId);
        labelFor.set(p.decisionId, `${p.date} · ${p.symbol} ${p.side}`);
      }
    }
  }
  const perScenarioById = reports.map((r) => {
    const m = new Map<string, ScenarioReport["executionSeries"][number]>();
    for (const p of r.executionSeries) m.set(p.decisionId, p);
    return { id: r.id, m };
  });
  return orderedIds.map((decisionId) => {
    const row: Record<string, string | number | null> = {
      label: labelFor.get(decisionId) ?? decisionId,
    };
    for (const s of perScenarioById) {
      const p = s.m.get(decisionId);
      row[s.id] = p ? pick(p) : null;
    }
    return row;
  });
}

/**
 * Per-trade execution cost decomposition (spread, latency, market impact,
 * urgency) from the microstructure model. One expandable sub-section per
 * visible scenario with a table of every filled parent decision, plus a
 * scenario-level notional-weighted average summary row.
 */
function CostBreakdownSection(props: {
  reports: ScenarioReport[];
  visible: Record<string, boolean>;
}) {
  const shown = props.reports.filter((r) => props.visible[r.id]);
  const anyBreakdown = shown.some((r) => r.executionSeries.some((p) => p.costBreakdownBps != null));
  if (!anyBreakdown) return null;

  return (
    <section>
      <h3 className="mb-2 text-sm font-medium text-muted-foreground">
        Per-trade cost breakdown (bps of mid, per side)
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Attributes each filled decision's execution cost to half-spread, fixed latency toll,
        size-driven market impact, and urgency. Bars stack to the modelled total per-side cost.
        Weighted averages use filled notional.
      </p>
      <div className="space-y-6">
        {shown.map((r, i) => (
          <CostBreakdownScenario key={r.id} report={r} color={PALETTE[i % PALETTE.length]} />
        ))}
      </div>
    </section>
  );
}

function CostBreakdownScenario(props: { report: ScenarioReport; color: string }) {
  const rows = props.report.executionSeries.filter(
    (p) => p.costBreakdownBps != null && p.filledNotional > 0,
  );
  if (rows.length === 0) return null;

  // Notional-weighted average per component.
  const totalNotional = rows.reduce((a, p) => a + p.filledNotional, 0);
  const wavg = (pick: (b: NonNullable<(typeof rows)[number]["costBreakdownBps"]>) => number) =>
    totalNotional > 0
      ? rows.reduce((a, p) => a + pick(p.costBreakdownBps!) * p.filledNotional, 0) / totalNotional
      : 0;
  const avg = {
    halfSpreadBps: wavg((b) => b.halfSpreadBps),
    latencyBps: wavg((b) => b.latencyBps),
    impactBps: wavg((b) => b.impactBps),
    urgencyBps: wavg((b) => b.urgencyBps),
    totalBps: wavg((b) => b.totalBps),
  };

  const SEG = {
    spread: OKABE_ITO.skyBlue,
    latency: CHART_ROLE.benchmark,
    impact: OKABE_ITO.reddishPurple,
    urgency: CHART_ROLE.positive,
  };

  return (
    <div className="rounded-md border border-foreground/10">
      <div className="flex items-center justify-between gap-2 border-b border-foreground/10 px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: props.color }}
          />
          {props.report.label}
        </div>
        <div className="text-xs text-muted-foreground">
          {rows.length} filled trade{rows.length === 1 ? "" : "s"} · weighted total{" "}
          {avg.totalBps.toFixed(1)} bps
        </div>
      </div>
      <div className="flex flex-wrap gap-3 border-b border-foreground/10 px-3 py-2 text-xs">
        <LegendSwatch color={SEG.spread} label={`Spread ${avg.halfSpreadBps.toFixed(1)}bps`} />
        <LegendSwatch color={SEG.latency} label={`Latency ${avg.latencyBps.toFixed(1)}bps`} />
        <LegendSwatch color={SEG.impact} label={`Impact ${avg.impactBps.toFixed(1)}bps`} />
        <LegendSwatch
          color={SEG.urgency}
          label={`Urgency ${avg.urgencyBps >= 0 ? "+" : ""}${avg.urgencyBps.toFixed(1)}bps`}
        />
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Decision</TableHead>
              <TableHead className="text-right">Spread</TableHead>
              <TableHead className="text-right">Latency</TableHead>
              <TableHead className="text-right">Impact</TableHead>
              <TableHead className="text-right">Urgency</TableHead>
              <TableHead className="text-right">Total (bps)</TableHead>
              <TableHead className="min-w-[160px]">Composition</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => {
              const b = p.costBreakdownBps!;
              const total = Math.max(0, b.totalBps);
              const pctOf = (v: number) => (total > 0 ? (Math.max(0, v) / total) * 100 : 0);
              return (
                <TableRow key={p.decisionId}>
                  <TableCell className="font-medium">
                    <div className="text-sm">
                      {p.symbol} <span className="text-muted-foreground">{p.side}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">{p.date}</div>
                  </TableCell>
                  <TableCell className="text-right">{b.halfSpreadBps.toFixed(1)}</TableCell>
                  <TableCell className="text-right">{b.latencyBps.toFixed(1)}</TableCell>
                  <TableCell className="text-right">{b.impactBps.toFixed(1)}</TableCell>
                  <TableCell className="text-right">
                    {b.urgencyBps >= 0 ? "+" : ""}
                    {b.urgencyBps.toFixed(1)}
                  </TableCell>
                  <TableCell className="text-right font-medium">{b.totalBps.toFixed(1)}</TableCell>
                  <TableCell>
                    <div
                      className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
                      role="img"
                      aria-label={`Spread ${b.halfSpreadBps.toFixed(1)} bps, latency ${b.latencyBps.toFixed(1)} bps, impact ${b.impactBps.toFixed(1)} bps, urgency ${b.urgencyBps.toFixed(1)} bps, total ${b.totalBps.toFixed(1)} bps`}
                    >
                      <span
                        style={{ width: `${pctOf(b.halfSpreadBps)}%`, backgroundColor: SEG.spread }}
                      />
                      <span
                        style={{ width: `${pctOf(b.latencyBps)}%`, backgroundColor: SEG.latency }}
                      />
                      <span
                        style={{ width: `${pctOf(b.impactBps)}%`, backgroundColor: SEG.impact }}
                      />
                      <span
                        style={{
                          width: `${pctOf(Math.max(0, b.urgencyBps))}%`,
                          backgroundColor: SEG.urgency,
                        }}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function LegendSwatch(props: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: props.color }} />
      {props.label}
    </span>
  );
}

function ScenarioLegend(props: {
  reports: ScenarioReport[];
  visible: Record<string, boolean>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {props.reports.map((r, i) => {
        const active = props.visible[r.id];
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => props.onToggle(r.id)}
            className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition ${
              active ? "border-foreground/20 bg-muted" : "border-foreground/10 opacity-40"
            }`}
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
            />
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Join per-scenario `[date, value]` series into a single row-oriented
 * dataset keyed by date, with one column per scenario id. Recharts
 * needs a single object array with all series columns present, so
 * missing values are filled forward from the last known point per
 * scenario (equity/drawdown are step-functions between events).
 */
function alignByDate(
  reports: ScenarioReport[],
  extract: (r: ScenarioReport) => Array<[string, number]>,
): Array<Record<string, string | number>> {
  const byScenario = reports.map((r) => ({ id: r.id, pts: extract(r) }));
  const allDates = Array.from(new Set(byScenario.flatMap((s) => s.pts.map((p) => p[0])))).sort();
  const cursors: Record<string, number> = {};
  const last: Record<string, number> = {};
  for (const s of byScenario) cursors[s.id] = 0;
  return allDates.map((date) => {
    const row: Record<string, string | number> = { date };
    for (const s of byScenario) {
      while (cursors[s.id] < s.pts.length && s.pts[cursors[s.id]][0] <= date) {
        last[s.id] = s.pts[cursors[s.id]][1];
        cursors[s.id] += 1;
      }
      if (last[s.id] !== undefined) row[s.id] = last[s.id];
    }
    return row;
  });
}

// ---------------------------------------------------------------------------
// Small demo generator used by the standalone report route. Deterministic
// GBM-ish daily prices for a single symbol, with a simple momentum decision
// rule producing BUY/SELL orders — enough to exercise every scenario in the
// matrix without any live data dependency.
export function buildDemoScenarioInput(opts?: {
  startingCash?: number;
  days?: number;
  seed?: number;
}): BuildScenarioReportInput {
  const cash = opts?.startingCash ?? 100_000;
  const days = opts?.days ?? 120;
  let seed = opts?.seed ?? 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  // Build a synthetic price series.
  const start = new Date("2024-01-02T00:00:00Z");
  const bars: { date: string; price: number; volume: number }[] = [];
  let price = 100;
  for (let i = 0; i < days; i++) {
    const drift = 0.0004;
    const vol = 0.012;
    const z = Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
    price = Math.max(1, price * Math.exp(drift + vol * z));
    const d = new Date(start.getTime() + i * 86_400_000);
    // Skip weekends for a slightly more realistic calendar.
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    bars.push({
      date: d.toISOString().slice(0, 10),
      price: Number(price.toFixed(2)),
      volume: Math.floor(5_000 + rand() * 10_000),
    });
  }
  // Momentum: 10-bar SMA cross -> flip position between all-in and cash.
  const decisions: BuildScenarioReportInput["decisions"] = [];
  let inMarket = false;
  const sma = (i: number, n: number) => {
    if (i < n) return null;
    let s = 0;
    for (let k = i - n; k < i; k++) s += bars[k].price;
    return s / n;
  };
  let holdingQty = 0;
  let simCash = cash;
  for (let i = 10; i < bars.length; i++) {
    const bar = bars[i];
    const fast = sma(i, 5);
    const slow = sma(i, 10);
    if (fast == null || slow == null) continue;
    if (!inMarket && fast > slow) {
      const qty = Math.floor(simCash / bar.price);
      if (qty > 0) {
        decisions.push({
          id: `d-${i}-buy`,
          date: bar.date,
          symbol: "DEMO",
          side: "BUY",
          quantity: qty,
          price: bar.price,
          volumeHistory: bars.slice(Math.max(0, i - 20), i).map((b) => b.volume),
        });
        holdingQty = qty;
        simCash -= qty * bar.price;
        inMarket = true;
      }
    } else if (inMarket && fast < slow) {
      if (holdingQty > 0) {
        decisions.push({
          id: `d-${i}-sell`,
          date: bar.date,
          symbol: "DEMO",
          side: "SELL",
          quantity: holdingQty,
          price: bar.price,
          volumeHistory: bars.slice(Math.max(0, i - 20), i).map((b) => b.volume),
        });
        simCash += holdingQty * bar.price;
        holdingQty = 0;
        inMarket = false;
      }
    }
  }
  return {
    decisions,
    defaultInitial: { cash, holdings: [] },
    scenarios: defaultScenarioSpecs(),
  };
}
