import { useMemo, useState } from "react";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from "recharts";
import {
  buildScenarioReport, defaultScenarioSpecs,
  type BuildScenarioReportInput, type ScenarioReport,
} from "@/lib/scenario-report";

const PALETTE = [
  "hsl(217 91% 60%)",
  "hsl(142 71% 45%)",
  "hsl(38 92% 50%)",
  "hsl(291 64% 55%)",
  "hsl(0 84% 60%)",
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
  return Number.isFinite(n) ? n.toLocaleString(undefined, {
    style: "currency", currency: "USD", maximumFractionDigits: 2,
  }) : "—";
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
export function ScenarioReportCard(props: {
  title?: string;
  input: BuildScenarioReportInput;
}) {
  const [visible, setVisible] = useState<Record<string, boolean>>(
    () => Object.fromEntries(props.input.scenarios.map((s) => [s.id, true])),
  );

  const reports = useMemo(
    () => buildScenarioReport(props.input),
    [props.input],
  );

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
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">
            Equity curve
          </h3>
          <div className="h-72 w-full">
            <ResponsiveContainer>
              <LineChart data={equityChartData}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={24} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v) => Number(v).toLocaleString()}
                />
                <Tooltip
                  formatter={(v: number) => fmtMoney(v)}
                  labelFormatter={(l) => `Date: ${l}`}
                />
                <Legend />
                {reports.map((r, i) => visible[r.id] && (
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
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">
            Drawdown (%)
          </h3>
          <div className="h-56 w-full">
            <ResponsiveContainer>
              <LineChart data={drawdownChartData}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={24} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v) => `${Number(v).toFixed(1)}%`}
                  domain={["auto", 0]}
                />
                <Tooltip
                  formatter={(v: number) => `${v.toFixed(2)}%`}
                  labelFormatter={(l) => `Date: ${l}`}
                />
                <Legend />
                {reports.map((r, i) => visible[r.id] && (
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
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        <ExecutionQualitySection reports={reports} visible={visible} />



        <section>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">
            Summary
          </h3>
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
                    <TableCell className="text-right">
                      {fmtMoney(r.summary.endEquity)}
                    </TableCell>
                    <TableCell className={`text-right ${
                      r.summary.totalReturnPct >= 0
                        ? "text-emerald-600" : "text-red-600"
                    }`}>
                      {fmtPct(r.summary.totalReturnPct)}
                    </TableCell>
                    <TableCell className="text-right">
                      {fmtPct(r.summary.cagrPct)}
                    </TableCell>
                    <TableCell className="text-right">
                      {fmtNum(r.summary.sharpe)}
                    </TableCell>
                    <TableCell className="text-right text-red-600">
                      {fmtPct(r.summary.maxDrawdownPct)}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.summary.winRatePct == null
                        ? "—"
                        : `${r.summary.winRatePct.toFixed(1)}%`}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.summary.trades}
                    </TableCell>
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
              active
                ? "border-foreground/20 bg-muted"
                : "border-foreground/10 opacity-40"
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
  const allDates = Array.from(new Set(byScenario.flatMap((s) => s.pts.map((p) => p[0]))))
    .sort();
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
          id: `d-${i}-buy`, date: bar.date, symbol: "DEMO",
          side: "BUY", quantity: qty, price: bar.price,
          volumeHistory: bars.slice(Math.max(0, i - 20), i).map((b) => b.volume),
        });
        holdingQty = qty; simCash -= qty * bar.price; inMarket = true;
      }
    } else if (inMarket && fast < slow) {
      if (holdingQty > 0) {
        decisions.push({
          id: `d-${i}-sell`, date: bar.date, symbol: "DEMO",
          side: "SELL", quantity: holdingQty, price: bar.price,
          volumeHistory: bars.slice(Math.max(0, i - 20), i).map((b) => b.volume),
        });
        simCash += holdingQty * bar.price; holdingQty = 0; inMarket = false;
      }
    }
  }
  return {
    decisions,
    defaultInitial: { cash, holdings: [] },
    scenarios: defaultScenarioSpecs(),
  };
}
