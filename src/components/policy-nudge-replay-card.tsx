import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Area,
  AreaChart,
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AXIS_LABEL,
  AXIS_PROPS,
  REFERENCE_LINE,
  CHART_ROLE,
  GRID_PROPS,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_LABEL_STYLE,
} from "@/lib/chart-palette";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import type { PolicyNudgeReplayResult } from "@/lib/backtest/policy-nudge-replay";
import { runPolicyNudgeReplayFn } from "@/lib/backtest/policy-nudge-replay.functions";

const pp = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}pp`;
const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;

function verdictBadge(v: PolicyNudgeReplayResult["verdict"]) {
  if (v === "helps")
    return <Badge className="bg-primary text-primary-foreground">Policy nudge helped</Badge>;
  if (v === "hurts") return <Badge variant="destructive">Policy nudge hurt</Badge>;
  return <Badge variant="outline">No measurable effect</Badge>;
}

function regimeBadge(v: PolicyNudgeReplayResult["regimeVerdict"]) {
  if (v === "better_than_fixed")
    return <Badge className="bg-primary text-primary-foreground">Regime scaling better</Badge>;
  if (v === "worse_than_fixed") return <Badge variant="destructive">Regime scaling worse</Badge>;
  if (v === "safer_not_richer") return <Badge variant="secondary">Safer, not richer</Badge>;
  if (v === "inactive") return <Badge variant="outline">Scaling never engaged</Badge>;
  return <Badge variant="outline">Too close to call</Badge>;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`truncate text-sm font-medium tabular-nums ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

type ArmKey = "baseline" | "nudged" | "regime";

const ARMS: { key: ArmKey; label: string; color: string; dash?: string }[] = [
  { key: "baseline", label: "Policy muted", color: CHART_ROLE.neutral, dash: "4 3" },
  { key: "nudged", label: "Fixed nudge", color: CHART_ROLE.positive },
  { key: "regime", label: "Regime-aware nudge", color: CHART_ROLE.benchmark, dash: "6 3" },
];

/** Underwater series: % below the running peak, per arm. */
function drawdownSeries(equity: readonly number[]): number[] {
  let peak = -Infinity;
  return equity.map((v) => {
    peak = Math.max(peak, v);
    return peak > 0 ? Number(((v / peak - 1) * 100).toFixed(3)) : 0;
  });
}

const good = "text-primary";
const bad = "text-destructive";

/**
 * Runs the trend strategy twice over the same tape — once deaf to policy
 * makers, once with the bounded ±10pt nudge — and reports the difference with
 * a bootstrap confidence band on both return and drawdown.
 */
export function PolicyNudgeReplayCard({
  symbols,
  className,
}: {
  symbols?: string[];
  className?: string;
}) {
  const run = useServerFn(runPolicyNudgeReplayFn);
  const [lookbackDays, setLookbackDays] = useState(730);
  const [nudgeScale, setNudgeScale] = useState(1);
  const [halfLifeHours, setHalfLifeHours] = useState(48);
  const [riskLevel, setRiskLevel] = useState(3);
  const [result, setResult] = useState<PolicyNudgeReplayResult | null>(null);
  const [equityMode, setEquityMode] = useState<"money" | "pct">("money");
  const [visibleArms, setVisibleArms] = useState<Record<ArmKey, boolean>>({
    baseline: true,
    nudged: true,
    regime: true,
  });

  const m = useMutation({
    mutationFn: () =>
      run({
        data: { symbols, lookbackDays, params: { nudgeScale, halfLifeHours, riskLevel } },
      }),
    onSuccess: (r) => setResult(r as PolicyNudgeReplayResult),
  });

  // Equity, normalised return and underwater drawdown for all three arms.
  const chart = useMemo(() => {
    if (!result) return [] as Record<string, string | number | null>[];
    const start = result.baseline.curve[0]?.equity ?? 0;
    const dd = {
      baseline: drawdownSeries(result.baseline.curve.map((c) => c.equity)),
      nudged: drawdownSeries(result.nudged.curve.map((c) => c.equity)),
      regime: drawdownSeries(result.regime.curve.map((c) => c.equity)),
    };
    return result.baseline.curve.map((c, i) => {
      const eq = {
        baseline: c.equity,
        nudged: result.nudged.curve[i]?.equity ?? null,
        regime: result.regime.curve[i]?.equity ?? null,
      };
      const rel = (v: number | null) => (v == null || start <= 0 ? null : (v / start - 1) * 100);
      return {
        date: c.date,
        baseline: eq.baseline,
        nudged: eq.nudged,
        regime: eq.regime,
        baselinePct: rel(eq.baseline),
        nudgedPct: rel(eq.nudged),
        regimePct: rel(eq.regime),
        baselineDd: dd.baseline[i] ?? null,
        nudgedDd: dd.nudged[i] ?? null,
        regimeDd: dd.regime[i] ?? null,
        spread: (eq.nudged ?? c.equity) - c.equity,
        regimeSpread: (eq.regime ?? c.equity) - c.equity,
      };
    });
  }, [result]);

  const toggleArm = (key: ArmKey) =>
    setVisibleArms((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      // Never let the reader blank the chart entirely.
      return Object.values(next).some(Boolean) ? next : prev;
    });

  const a = result?.attribution;

  return (
    <Card className={className} id="policy-nudge-replay">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base">Policy-nudge backtest</CardTitle>
            <CardDescription>
              Same strategy, same tape, same costs — the only difference is whether the AI
              listens to central bankers and finance ministers.
            </CardDescription>
          </div>
          {result ? verdictBadge(result.verdict) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Lookback: {Math.round(lookbackDays / 30)} months</Label>
            <Slider
              value={[lookbackDays]}
              min={365}
              max={900}
              step={30}
              onValueChange={([v]) => setLookbackDays(v ?? 730)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Nudge strength: ×{nudgeScale.toFixed(1)}</Label>
            <Slider
              value={[nudgeScale]}
              min={0}
              max={3}
              step={0.5}
              onValueChange={([v]) => setNudgeScale(v ?? 1)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Signal half-life: {halfLifeHours}h</Label>
            <Slider
              value={[halfLifeHours]}
              min={6}
              max={168}
              step={6}
              onValueChange={([v]) => setHalfLifeHours(v ?? 48)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Risk dial: level {riskLevel}</Label>
            <Slider
              value={[riskLevel]}
              min={1}
              max={5}
              step={1}
              onValueChange={([v]) => setRiskLevel(v ?? 3)}
            />
          </div>
        </div>

        <Button onClick={() => m.mutate()} disabled={m.isPending} size="sm">
          {m.isPending ? "Replaying…" : "Run backtest"}
        </Button>

        {m.isError ? (
          <p className="text-sm text-destructive">
            {(m.error as Error)?.message ?? "The replay failed — try a shorter lookback."}
          </p>
        ) : null}

        {result ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{result.summary}</p>

            <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Return delta"
                value={pp(result.delta.returnPct)}
                tone={result.delta.returnPct >= 0 ? good : bad}
              />
              <Stat
                label="Max drawdown delta"
                value={pp(result.delta.maxDrawdownPct)}
                tone={result.delta.maxDrawdownPct >= 0 ? good : bad}
              />
              <Stat
                label="Sharpe delta"
                value={result.delta.sharpe > 0 ? `+${result.delta.sharpe}` : `${result.delta.sharpe}`}
                tone={result.delta.sharpe >= 0 ? good : bad}
              />
              <Stat
                label="95% CVaR delta"
                value={pp(result.delta.cvar95Pct)}
                tone={result.delta.cvar95Pct >= 0 ? good : bad}
              />
            </div>

            {/* Arm-by-arm table: the numbers a reviewer asks for next. */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border/60">
                    <th className="py-1.5 text-left font-medium">Arm</th>
                    <th className="py-1.5 text-right font-medium">Return</th>
                    <th className="py-1.5 text-right font-medium">Max DD</th>
                    <th className="py-1.5 text-right font-medium">Sharpe</th>
                    <th className="py-1.5 text-right font-medium">Vol (ann.)</th>
                    <th className="py-1.5 text-right font-medium">95% VaR</th>
                    <th className="py-1.5 text-right font-medium">95% CVaR</th>
                    <th className="py-1.5 text-right font-medium">Tickets</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {[result.baseline, result.nudged, result.regime].map((arm) => (
                    <tr key={arm.label} className="border-b border-border/40 last:border-0">
                      <td className="py-1.5 pr-2">{arm.label}</td>
                      <td className="py-1.5 text-right">{pct(arm.totalReturnPct)}</td>
                      <td className="py-1.5 text-right">{arm.maxDrawdownPct.toFixed(2)}%</td>
                      <td className="py-1.5 text-right">{arm.sharpe.toFixed(2)}</td>
                      <td className="py-1.5 text-right">{arm.volAnnPct.toFixed(2)}%</td>
                      <td className="py-1.5 text-right">{arm.var95Pct.toFixed(2)}%</td>
                      <td className="py-1.5 text-right">{arm.cvar95Pct.toFixed(2)}%</td>
                      <td className="py-1.5 text-right">{arm.trades}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {chart.length > 1 ? (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  {ARMS.map((arm) => (
                    <button
                      key={arm.key}
                      type="button"
                      onClick={() => toggleArm(arm.key)}
                      aria-pressed={visibleArms[arm.key]}
                      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                        visibleArms[arm.key]
                          ? "border-border bg-muted/60 text-foreground"
                          : "border-border/50 text-muted-foreground opacity-60"
                      }`}
                    >
                      <span
                        aria-hidden
                        className="inline-block h-2.5 w-2.5 rounded-[2px]"
                        style={{ backgroundColor: arm.color }}
                      />
                      {arm.label}
                    </button>
                  ))}
                  <div className="ml-auto flex gap-1">
                    {(["money", "pct"] as const).map((mode) => (
                      <Button
                        key={mode}
                        size="sm"
                        variant={equityMode === mode ? "secondary" : "ghost"}
                        className="h-7 px-2 text-xs"
                        onClick={() => setEquityMode(mode)}
                      >
                        {mode === "money" ? "Equity" : "Return %"}
                      </Button>
                    ))}
                  </div>
                </div>

                <div className="h-60 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={chart}
                      syncId="policy-nudge-replay"
                      margin={{ top: 4, right: 8, left: 0, bottom: 18 }}
                    >
                      <CartesianGrid {...GRID_PROPS} />
                      <XAxis dataKey="date" {...AXIS_PROPS} minTickGap={40} />
                      <YAxis
                        {...AXIS_PROPS}
                        width={58}
                        domain={["auto", "auto"]}
                        tickFormatter={(v: number) =>
                          equityMode === "money" ? Number(v).toFixed(0) : `${Number(v).toFixed(0)}%`
                        }
                        label={{
                          value: equityMode === "money" ? "Equity (£)" : "Return (%)",
                          angle: -90,
                          position: "insideLeft",
                          style: { ...AXIS_LABEL, textAnchor: "middle" },
                        }}
                      />
                      <Tooltip
                        contentStyle={TOOLTIP_CONTENT_STYLE}
                        labelStyle={TOOLTIP_LABEL_STYLE}
                        formatter={(v: number | string, name: string) => [
                          equityMode === "money"
                            ? Number(v).toFixed(0)
                            : `${Number(v).toFixed(2)}%`,
                          name,
                        ]}
                      />
                      {ARMS.filter((arm) => visibleArms[arm.key]).map((arm) => (
                        <Line
                          key={arm.key}
                          type="monotone"
                          dataKey={equityMode === "money" ? arm.key : `${arm.key}Pct`}
                          name={arm.label}
                          stroke={arm.color}
                          strokeDasharray={arm.dash}
                          dot={false}
                          activeDot={{ r: 3 }}
                          strokeWidth={1.8}
                          isAnimationActive={false}
                          connectNulls
                        />
                      ))}
                      <Brush
                        dataKey="date"
                        height={18}
                        travellerWidth={8}
                        stroke={CHART_ROLE.neutral}
                        fill="transparent"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {/* Underwater curves: how deep each arm sat below its own peak. */}
                <div className="h-40 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={chart}
                      syncId="policy-nudge-replay"
                      margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                    >
                      <CartesianGrid {...GRID_PROPS} />
                      <XAxis dataKey="date" {...AXIS_PROPS} minTickGap={40} />
                      <YAxis
                        {...AXIS_PROPS}
                        width={58}
                        tickFormatter={(v: number) => `${Number(v).toFixed(0)}%`}
                        label={{
                          value: "Drawdown (%)",
                          angle: -90,
                          position: "insideLeft",
                          style: { ...AXIS_LABEL, textAnchor: "middle" },
                        }}
                      />
                      <Tooltip
                        contentStyle={TOOLTIP_CONTENT_STYLE}
                        labelStyle={TOOLTIP_LABEL_STYLE}
                        formatter={(v: number | string, name: string) => [
                          `${Number(v).toFixed(2)}%`,
                          name,
                        ]}
                      />
                      <ReferenceLine y={0} {...REFERENCE_LINE} />
                      {ARMS.filter((arm) => visibleArms[arm.key]).map((arm) => (
                        <Area
                          key={arm.key}
                          type="monotone"
                          dataKey={`${arm.key}Dd`}
                          name={`${arm.label} drawdown`}
                          stroke={arm.color}
                          strokeDasharray={arm.dash}
                          fill={arm.color}
                          fillOpacity={0.12}
                          strokeWidth={1.4}
                          isAnimationActive={false}
                          connectNulls
                        />
                      ))}
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                {/* Cumulative edge: above zero means the nudge is ahead. */}
                <div className="h-28 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chart} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid {...GRID_PROPS} />
                      <XAxis dataKey="date" {...AXIS_PROPS} minTickGap={40} />
                      <YAxis {...AXIS_PROPS} width={52} />
                      <Tooltip
                        contentStyle={TOOLTIP_CONTENT_STYLE}
                        labelStyle={TOOLTIP_LABEL_STYLE}
                        formatter={(v: number | string) => Number(v).toFixed(0)}
                      />
                      <Area
                        type="monotone"
                        dataKey="spread"
                        name="Nudge edge"
                        stroke="hsl(var(--primary))"
                        fill="hsl(var(--primary) / 0.18)"
                        strokeWidth={1.4}
                      />
                      <Area
                        type="monotone"
                        dataKey="regimeSpread"
                        name="Regime-aware edge"
                        stroke={CHART_ROLE.benchmark}
                        fill="transparent"
                        strokeWidth={1.4}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </>
            ) : null}

            <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
              <Stat
                label="95% CI on return delta"
                value={`${result.confidence.returnDeltaLo}..${result.confidence.returnDeltaHi}pp`}
              />
              <Stat
                label="95% CI on drawdown delta"
                value={`${result.confidence.drawdownDeltaLo}..${result.confidence.drawdownDeltaHi}pp`}
              />
              <Stat
                label="P(nudge ahead)"
                value={`${(result.confidence.probPositive * 100).toFixed(0)}%`}
              />
              <Stat
                label="P(drawdown no worse)"
                value={`${(result.confidence.probDrawdownBetter * 100).toFixed(0)}%`}
              />
            </div>

            {/* Regime-aware scaling vs the fixed-strength nudge. */}
            <div className="space-y-2 rounded-lg border border-border/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">Regime-aware scaling vs fixed nudge</div>
                {regimeBadge(result.regimeVerdict)}
              </div>
              <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
                <Stat
                  label="Return delta"
                  value={pp(result.regimeVsFixed.delta.returnPct)}
                  tone={result.regimeVsFixed.delta.returnPct >= 0 ? good : bad}
                />
                <Stat
                  label="Drawdown delta"
                  value={pp(result.regimeVsFixed.delta.maxDrawdownPct)}
                  tone={result.regimeVsFixed.delta.maxDrawdownPct >= 0 ? good : bad}
                />
                <Stat
                  label="95% CI on return delta"
                  value={`${result.regimeVsFixed.confidence.returnDeltaLo}..${result.regimeVsFixed.confidence.returnDeltaHi}pp`}
                />
                <Stat
                  label="95% CI on drawdown delta"
                  value={`${result.regimeVsFixed.confidence.drawdownDeltaLo}..${result.regimeVsFixed.confidence.drawdownDeltaHi}pp`}
                />
                <Stat
                  label="P(regime ahead of fixed)"
                  value={`${(result.regimeVsFixed.confidence.probPositive * 100).toFixed(0)}%`}
                />
                <Stat
                  label="P(drawdown no worse)"
                  value={`${(result.regimeVsFixed.confidence.probDrawdownBetter * 100).toFixed(0)}%`}
                />
                <Stat
                  label="Scaling applied"
                  value={`×${result.regimeAttribution.avgScale.toFixed(2)} avg (${result.regimeAttribution.minScale.toFixed(2)}–${result.regimeAttribution.maxScale.toFixed(2)})`}
                />
                <Stat
                  label="Amplified / damped"
                  value={`${result.regimeAttribution.amplifiedDays} / ${result.regimeAttribution.dampenedDays}`}
                />
              </div>
              <div className="text-[11px] text-muted-foreground">
                Regime bars — risk-on {result.regimeAttribution.postureDays.risk_on}, neutral{" "}
                {result.regimeAttribution.postureDays.neutral}, risk-off{" "}
                {result.regimeAttribution.postureDays.risk_off}; volatility calm{" "}
                {result.regimeAttribution.volDays.calm}, normal{" "}
                {result.regimeAttribution.volDays.normal}, elevated{" "}
                {result.regimeAttribution.volDays.elevated}, stressed{" "}
                {result.regimeAttribution.volDays.stressed}. Versus the policy-deaf baseline the
                regime arm is {pp(result.regimeVsBaseline.delta.returnPct)} (95% CI{" "}
                {result.regimeVsBaseline.confidence.returnDeltaLo}..
                {result.regimeVsBaseline.confidence.returnDeltaHi}pp).
              </div>
            </div>


            {a ? (
              <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
                <Stat
                  label="Bars with a policy signal"
                  value={`${(a.coverage * 100).toFixed(0)}% (${a.activeDays})`}
                />
                <Stat label="Symbols touched" value={`${a.touchedSymbols}/${result.symbols.length}`} />
                <Stat label="Hawkish / dovish days" value={`${a.hawkishDays} / ${a.dovishDays}`} />
                <Stat
                  label="Peak nudge"
                  value={
                    a.peakNudgeSymbol
                      ? `${a.peakNudge > 0 ? "+" : ""}${a.peakNudge} ${a.peakNudgeSymbol}`
                      : "—"
                  }
                />
                <Stat
                  label="Suppressed (name kept out)"
                  value={`${a.suppressedDays} days, ${a.suppressedSymbols} names`}
                />
                <Stat
                  label="Fwd 21d after suppression"
                  value={a.suppressedForward21Pct == null ? "—" : pct(a.suppressedForward21Pct)}
                  tone={
                    a.suppressedForward21Pct == null
                      ? undefined
                      : a.suppressedForward21Pct < 0
                        ? good
                        : bad
                  }
                />
                <Stat label="Promoted (name pulled in)" value={`${a.promotedDays} days`} />
                <Stat
                  label="Fwd 21d after promotion"
                  value={a.promotedForward21Pct == null ? "—" : pct(a.promotedForward21Pct)}
                  tone={
                    a.promotedForward21Pct == null
                      ? undefined
                      : a.promotedForward21Pct > 0
                        ? good
                        : bad
                  }
                />
              </div>
            ) : null}

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {result.from} → {result.to} · {result.tradingDays} bars · {result.symbols.length}{" "}
              symbols · sized through the {result.sizing.name} dial · nudge capped at ±
              {(result.maxNudge * 100).toFixed(0)}pt · {result.confidence.iterations} moving-block
              bootstrap resamples ({result.confidence.blockDays}-day blocks). Suppression numbers
              read best when the forward return is negative: that is the nudge dodging weakness.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
