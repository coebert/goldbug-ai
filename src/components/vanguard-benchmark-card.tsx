import { ChartFrame } from "@/components/chart-frame";
import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Scale, TrendingUp, TrendingDown, Minus } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  attributeAlpha,
  buildBenchmarkSeries,
  compareToVanguard,
  simulateAlphaAtRiskLevels,
  VANGUARD_CAGR,
  type DepositLike,
  type EquityPoint,
} from "@/lib/vanguard-benchmark";
import { formatUk } from "@/lib/uk-time";
import { AXIS_LINE, AXIS_TICK, GRID_PROPS, TICK_LINE } from "@/lib/chart-palette";

/**
 * "vs Vanguard benchmark" performance tile.
 *
 * Compares the portfolio's realised trajectory to a passive Vanguard
 * LifeStrategy 60% Equity proxy (5.5% long-run CAGR, GBP-hedged). Deposits
 * added mid-run are compounded from their own date so the comparison is
 * apples-to-apples with the actual trading account.
 */

interface Props {
  startingCash: number;
  currency: string;
  equity: EquityPoint[];
  deposits?: DepositLike[];
  cagr?: number;
  /** Portfolio's current risk_level (conservative | balanced | aggressive). */
  riskLevel?: string | null;
}

export function VanguardBenchmarkCard({
  startingCash,
  currency,
  equity,
  deposits = [],
  cagr = VANGUARD_CAGR,
  riskLevel,
}: Props) {
  const fmtCcy = useMemo(
    () =>
      new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency,
        maximumFractionDigits: 2,
      }),
    [currency],
  );

  const cmp = useMemo(
    () => compareToVanguard(startingCash, equity, deposits, cagr),
    [startingCash, equity, deposits, cagr],
  );
  const series = useMemo(
    () => buildBenchmarkSeries(startingCash, equity, deposits, cagr),
    [startingCash, equity, deposits, cagr],
  );
  const attr = useMemo(
    () => attributeAlpha(cmp, equity, deposits, cagr),
    [cmp, equity, deposits, cagr],
  );
  const riskSim = useMemo(
    () => simulateAlphaAtRiskLevels(attr, riskLevel ?? null),
    [attr, riskLevel],
  );
  const fmtCompact = useMemo(
    () =>
      new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency,
        notation: "compact",
        maximumFractionDigits: 1,
      }),
    [currency],
  );
  const fmtShortDate = (iso: string) => {
    const d = new Date(iso);
    return Number.isFinite(d.getTime())
      ? d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
      : iso;
  };

  const hasData = equity.length > 0;
  const beating = cmp.alphaPct > 0.05;
  const trailing = cmp.alphaPct < -0.05;
  const AlphaIcon = beating ? TrendingUp : trailing ? TrendingDown : Minus;
  const alphaCls = beating
    ? "text-emerald-600 dark:text-emerald-400"
    : trailing
      ? "text-destructive"
      : "text-muted-foreground";
  const verdict = beating
    ? "Beating passive"
    : trailing
      ? "Trailing passive"
      : "In line with passive";

  const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${Number.isFinite(n) ? n.toFixed(2) : "—"}%`;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Scale className="h-4 w-4 text-primary" aria-hidden />
          vs Vanguard benchmark
          <Badge variant="outline" className="ml-1 font-mono text-[10px]">
            VLS60 · {(cagr * 100).toFixed(1)}% CAGR
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          What a boring, low-cost Vanguard LifeStrategy 60% Equity fund would have done with the
          same starting pot and top-ups — the alpha below is the value the AI is adding (or
          destroying) over pure passive.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasData && (
          <p className="text-sm text-muted-foreground">
            No equity snapshots yet — once the portfolio has a couple of daily marks, the passive
            comparison will appear here.
          </p>
        )}

        {hasData && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Tile
                label="Portfolio"
                value={fmtCcy.format(cmp.portfolioValue)}
                sub={fmtPct(cmp.portfolioReturnPct)}
                cls={
                  cmp.portfolioReturnPct >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-destructive"
                }
              />
              <Tile
                label="Vanguard 60/40"
                value={fmtCcy.format(cmp.benchmarkValue)}
                sub={fmtPct(cmp.benchmarkReturnPct)}
                cls="text-muted-foreground"
              />
              <Tile
                label="Alpha"
                value={
                  <span className="inline-flex items-center gap-1">
                    <AlphaIcon className="h-4 w-4" aria-hidden />
                    {fmtPct(cmp.alphaPct)}
                  </span>
                }
                sub={`${cmp.alphaCcy >= 0 ? "+" : ""}${fmtCcy.format(cmp.alphaCcy)}`}
                cls={alphaCls}
              />
            </div>

            {series.length >= 2 && (
              <ChartFrame
                className="h-56"
                role="img"
                aria-label="Portfolio equity curve compared to Vanguard LifeStrategy 60% Equity proxy over time"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={series} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                    <CartesianGrid {...GRID_PROPS} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={fmtShortDate}
                      minTickGap={32}
                      tick={AXIS_TICK}
                      stroke="var(--border)"
                      axisLine={AXIS_LINE}
                      tickLine={TICK_LINE}
                    />
                    <YAxis
                      domain={["auto", "auto"]}
                      tickFormatter={(v: number) => fmtCompact.format(v)}
                      tick={AXIS_TICK}
                      stroke="var(--border)"
                      width={64}
                      axisLine={AXIS_LINE}
                      tickLine={TICK_LINE}
                    />
                    <Tooltip
                      labelFormatter={(l) => formatUk(String(l))}
                      formatter={(value: number, name) => [fmtCcy.format(Number(value)), name]}
                      contentStyle={{
                        background: "var(--popover)",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        fontSize: 12,
                        color: "var(--popover-foreground)",
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="portfolio"
                      name="Portfolio"
                      stroke="var(--primary)"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="benchmark"
                      name="Vanguard 60/40"
                      stroke="var(--muted-foreground)"
                      strokeDasharray="4 4"
                      strokeWidth={1.75}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </ChartFrame>
            )}

            <div className="rounded-md border bg-muted/20 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Where the alpha came from
                </div>
                <div className="font-mono text-[10px] text-muted-foreground">
                  TWR {fmtPct(attr.portfolioTwrPct)} vs {fmtPct(attr.benchmarkTwrPct)}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <AttrRow
                  label="Timing"
                  amount={attr.timing}
                  fmt={fmtCcy}
                  hint="Skill per £: portfolio TWR vs passive TWR, sized to contributed capital."
                />
                <AttrRow
                  label="Allocation"
                  amount={attr.allocation}
                  fmt={fmtCcy}
                  hint="Residual: how deposit-weighted returns differed from time-weighted skill (mix / sizing effect)."
                />
                <AttrRow
                  label="Deposit timing"
                  amount={attr.depositTiming}
                  fmt={fmtCcy}
                  hint="Effect of when top-ups landed vs a lump-sum-on-day-1 passive baseline."
                />
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Components sum to the total alpha above; positive values mean that driver added to
                your edge over the passive baseline.
              </p>
            </div>

            <div className="rounded-md border bg-muted/20 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Risk-level what-if
                </div>
                <div className="font-mono text-[10px] text-muted-foreground">vs Vanguard</div>
              </div>
              <div className="-mx-1 overflow-x-auto">
                <table className="w-full min-w-[380px] text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                      <th className="px-1 py-1 font-medium">Level</th>
                      <th className="px-1 py-1 text-right font-medium">Timing</th>
                      <th className="px-1 py-1 text-right font-medium">Allocation</th>
                      <th className="px-1 py-1 text-right font-medium">Total α</th>
                    </tr>
                  </thead>
                  <tbody>
                    {riskSim.map((r) => (
                      <tr
                        key={r.level}
                        className={
                          r.isCurrent
                            ? "border-t border-primary/40 bg-primary/5"
                            : "border-t border-border/50"
                        }
                      >
                        <td className="px-1 py-1.5">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium">{r.label}</span>
                            {r.isCurrent && (
                              <Badge variant="outline" className="h-4 px-1 text-[9px]">
                                current
                              </Badge>
                            )}
                          </div>
                          <div className="font-mono text-[10px] text-muted-foreground">
                            exp ×{r.exposureFactor.toFixed(2)} · conc ×
                            {r.concentrationFactor.toFixed(2)}
                          </div>
                        </td>
                        <SimCell amount={r.timing} fmt={fmtCcy} />
                        <SimCell amount={r.allocation} fmt={fmtCcy} />
                        <SimCell amount={r.total} fmt={fmtCcy} bold />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Linear counterfactual: timing scales with equity exposure (1 − cash floor),
                allocation scales with the position cap. Deposit timing is unchanged. Not a full
                re-simulation.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
              <span className={`font-medium ${alphaCls}`}>{verdict}</span>
              <span className="font-mono text-muted-foreground">
                {cmp.startDate ? formatUk(cmp.startDate) : "—"}
                {" → "}
                {cmp.asOf ? formatUk(cmp.asOf) : "—"}
                {" · "}
                {cmp.days.toFixed(0)}d
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Tile({
  label,
  value,
  sub,
  cls,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  cls?: string;
}) {
  return (
    <div className="rounded-md border bg-card/40 p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular-nums ${cls ?? ""}`}>{value}</div>
      {sub && <div className={`text-xs tabular-nums ${cls ?? "text-muted-foreground"}`}>{sub}</div>}
    </div>
  );
}

function AttrRow({
  label,
  amount,
  fmt,
  hint,
}: {
  label: string;
  amount: number;
  fmt: Intl.NumberFormat;
  hint: string;
}) {
  const positive = amount >= 0;
  const cls = positive ? "text-emerald-600 dark:text-emerald-400" : "text-destructive";
  const display = `${positive ? "+" : ""}${fmt.format(amount)}`;
  return (
    <div className="rounded-md border bg-card/40 p-2" title={hint}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold tabular-nums ${cls}`}>{display}</div>
    </div>
  );
}

function SimCell({
  amount,
  fmt,
  bold,
}: {
  amount: number;
  fmt: Intl.NumberFormat;
  bold?: boolean;
}) {
  const positive = amount >= 0;
  const cls = positive ? "text-emerald-600 dark:text-emerald-400" : "text-destructive";
  return (
    <td className={`px-1 py-1.5 text-right tabular-nums ${cls} ${bold ? "font-semibold" : ""}`}>
      {positive ? "+" : ""}
      {fmt.format(amount)}
    </td>
  );
}
