import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Area,
  AreaChart,
  Brush,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
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
import { ArmMetricsPanel } from "@/components/backtest/arm-metrics-panel";
import { runPolicyNudgeReplayFn } from "@/lib/backtest/policy-nudge-replay.functions";
import { TradeMarkerLegend, TradeMarkerShape } from "@/components/charts/trade-markers";
import { EpisodeBandLegend, renderEpisodeBands } from "@/components/charts/trade-episode-bands";
import { TradeEpisodeList } from "@/components/charts/trade-episode-list";
import { spanBand, type EpisodeBand } from "@/lib/trade-episodes";
import type { TradeMarkerCell } from "@/lib/chart-trade-markers";

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
  // Overlay compare mode: absolute equity, normalised return, or every arm
  // re-based against one chosen arm so the gaps between them read directly.
  const [equityMode, setEquityMode] = useState<"money" | "pct" | "rel">("money");
  const [compareBase, setCompareBase] = useState<ArmKey>("baseline");
  // Which arm's entries/exits and holding periods to annotate. Only one at a
  // time: three overlaid sets of markers is unreadable.
  const [markerArm, setMarkerArm] = useState<ArmKey | "none">("regime");
  // Trade row spotlighted on the equity and drawdown charts.
  const [selectedEpisode, setSelectedEpisode] = useState<string | null>(null);
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

  // Entries/exits of the annotated arm, keyed by curve date.
  const armEvents = useMemo(() => {
    const map = new Map<string, { buys: string[]; sells: string[] }>();
    if (!result || markerArm === "none") return map;
    for (const e of result[markerArm].events ?? []) {
      map.set(e.date, { buys: e.buys, sells: e.sells });
    }
    return map;
  }, [result, markerArm]);

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
      const basePct = rel(eq[compareBase]);
      const baseDd = dd[compareBase][i] ?? null;
      // Re-based overlay: distance from the chosen arm, in percentage points.
      const vs = (v: number | null) => {
        const p2 = rel(v);
        return p2 == null || basePct == null ? null : p2 - basePct;
      };
      const vsDd = (v: number | null) => (v == null || baseDd == null ? null : v - baseDd);
      const ev = armEvents.get(c.date) ?? null;
      const markY =
        markerArm === "none"
          ? null
          : equityMode === "money"
            ? eq[markerArm]
            : equityMode === "pct"
              ? rel(eq[markerArm])
              : vs(eq[markerArm]);
      const markDd =
        markerArm === "none"
          ? null
          : equityMode === "rel"
            ? vsDd(dd[markerArm][i] ?? null)
            : (dd[markerArm][i] ?? null);
      return {
        date: c.date,
        buyMark: ev && ev.buys.length ? markY : null,
        sellMark: ev && ev.sells.length ? markY : null,
        buyMarkDd: ev && ev.buys.length ? markDd : null,
        sellMarkDd: ev && ev.sells.length ? markDd : null,
        marker: ev
          ? ({
              buys: ev.buys.length,
              sells: ev.sells.length,
              buyValue: 0,
              sellValue: 0,
              trades: [],
            } as TradeMarkerCell)
          : null,
        eventLabel: ev
          ? [
              ev.buys.length ? `▲ in: ${ev.buys.slice(0, 4).join(", ")}` : "",
              ev.sells.length ? `▼ out: ${ev.sells.slice(0, 4).join(", ")}` : "",
            ]
              .filter(Boolean)
              .join(" · ")
          : null,
        baseline: eq.baseline,
        nudged: eq.nudged,
        regime: eq.regime,
        baselinePct: rel(eq.baseline),
        nudgedPct: rel(eq.nudged),
        regimePct: rel(eq.regime),
        baselineRel: vs(eq.baseline),
        nudgedRel: vs(eq.nudged),
        regimeRel: vs(eq.regime),
        baselineDdRel: vsDd(dd.baseline[i] ?? null),
        nudgedDdRel: vsDd(dd.nudged[i] ?? null),
        regimeDdRel: vsDd(dd.regime[i] ?? null),
        baselineDd: dd.baseline[i] ?? null,
        nudgedDd: dd.nudged[i] ?? null,
        regimeDd: dd.regime[i] ?? null,
        spread: (eq.nudged ?? c.equity) - c.equity,
        regimeSpread: (eq.regime ?? c.equity) - c.equity,
      };
    });
  }, [result, armEvents, markerArm, equityMode, compareBase]);

  // Holding periods of the annotated arm, clipped to the plotted window.
  const holdBands: EpisodeBand[] = useMemo(() => {
    if (!result || markerArm === "none" || chart.length < 2) return [];
    const lastDate = String(chart[chart.length - 1]?.date ?? "");
    const eps = result[markerArm].episodes ?? [];
    return eps
      // One-bar touches add noise without telling you anything about duration.
      .filter((e) => e.days >= 2)
      .slice(0, 60)
      .map((e) =>
        spanBand({
          symbol: e.symbol,
          x1: e.from,
          x2: e.to ?? lastDate,
          days: e.days,
          open: e.open,
        }),
      );
  }, [result, markerArm, chart]);

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

            <ArmMetricsPanel
              arms={ARMS.map((a2) => ({
                result: result[a2.key],
                label: a2.label,
                color: a2.color,
              }))}
            />

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
                  <div className="ml-auto flex flex-wrap gap-1">
                    {(["money", "pct", "rel"] as const).map((mode) => (
                      <Button
                        key={mode}
                        size="sm"
                        variant={equityMode === mode ? "secondary" : "ghost"}
                        className="h-7 px-2 text-xs"
                        onClick={() => setEquityMode(mode)}
                      >
                        {mode === "money" ? "Equity" : mode === "pct" ? "Return %" : "Compare"}
                      </Button>
                    ))}
                  </div>
                </div>

                {equityMode === "rel" ? (
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span>Compare against:</span>
                    {ARMS.map((arm) => (
                      <button
                        key={arm.key}
                        type="button"
                        onClick={() => setCompareBase(arm.key)}
                        aria-pressed={compareBase === arm.key}
                        className={`rounded-full border px-2.5 py-1 transition-colors ${
                          compareBase === arm.key
                            ? "border-border bg-muted/60 text-foreground"
                            : "border-border/50 opacity-70 hover:text-foreground"
                        }`}
                      >
                        {arm.label}
                      </button>
                    ))}
                    <span className="ml-auto">
                      Both charts show the gap versus{" "}
                      {ARMS.find((a2) => a2.key === compareBase)?.label}; above zero is ahead.
                    </span>
                  </div>
                ) : null}

                {/* Which arm's trades to annotate. Markers sit on that arm's own
                    curve, and its holding periods shade both charts. */}
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>Trade markers:</span>
                  {([...ARMS.map((a2) => a2.key), "none"] as Array<ArmKey | "none">).map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setMarkerArm(key)}
                      aria-pressed={markerArm === key}
                      className={`rounded-full border px-2.5 py-1 transition-colors ${
                        markerArm === key
                          ? "border-border bg-muted/60 text-foreground"
                          : "border-border/50 opacity-70 hover:text-foreground"
                      }`}
                    >
                      {key === "none" ? "Off" : ARMS.find((a2) => a2.key === key)?.label}
                    </button>
                  ))}
                  {markerArm !== "none" && (
                    <span className="ml-auto flex flex-wrap items-center gap-x-3">
                      <TradeMarkerLegend />
                      {holdBands.length > 0 && <EpisodeBandLegend count={holdBands.length} />}
                    </span>
                  )}
                </div>

                <div className="h-60 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={chart}
                      syncId="policy-nudge-replay"
                      margin={{ top: 4, right: 8, left: 0, bottom: 18 }}
                    >
                      <CartesianGrid {...GRID_PROPS} />
                      {renderEpisodeBands(holdBands, {
                        labels: holdBands.length <= 12,
                        selectedKey: selectedEpisode,
                      })}
                      <XAxis dataKey="date" {...AXIS_PROPS} minTickGap={40} />
                      <YAxis
                        {...AXIS_PROPS}
                        width={58}
                        domain={["auto", "auto"]}
                        tickFormatter={(v: number) =>
                          equityMode === "money"
                            ? Number(v).toFixed(0)
                            : equityMode === "pct"
                              ? `${Number(v).toFixed(0)}%`
                              : `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(0)}pp`
                        }
                        label={{
                          value:
                            equityMode === "money"
                              ? "Equity (£)"
                              : equityMode === "pct"
                                ? "Return (%)"
                                : `Gap vs ${ARMS.find((a2) => a2.key === compareBase)?.label} (pp)`,
                          angle: -90,
                          position: "insideLeft",
                          style: { ...AXIS_LABEL, textAnchor: "middle" },
                        }}
                      />
                      <Tooltip
                        labelStyle={TOOLTIP_LABEL_STYLE}
                        contentStyle={{ ...TOOLTIP_CONTENT_STYLE, whiteSpace: "pre-line" }}
                        formatter={(v: number | string, name: string, item) => {
                          if (name === "buys" || name === "sells")
                            return [] as unknown as [string, string];
                          const ev = (item?.payload as { eventLabel?: string | null })?.eventLabel;
                          const head =
                            equityMode === "money"
                              ? Number(v).toFixed(0)
                              : equityMode === "pct"
                                ? `${Number(v).toFixed(2)}%`
                                : `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(2)}pp`;
                          return [`${head}${ev ? `\n${ev}` : ""}`, name];
                        }}
                      />
                      {ARMS.filter((arm) => visibleArms[arm.key]).map((arm) => (
                        <Line
                          key={arm.key}
                          type="monotone"
                          dataKey={
                            equityMode === "money"
                              ? arm.key
                              : equityMode === "pct"
                                ? `${arm.key}Pct`
                                : `${arm.key}Rel`
                          }
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
                      {equityMode === "rel" ? <ReferenceLine y={0} {...REFERENCE_LINE} /> : null}
                      {markerArm !== "none" && (
                        <Scatter
                          dataKey="buyMark"
                          name="buys"
                          isAnimationActive={false}
                          shape={(props: unknown) => (
                            <TradeMarkerShape
                              {...(props as { cx?: number; cy?: number })}
                              side="buy"
                            />
                          )}
                        />
                      )}
                      {markerArm !== "none" && (
                        <Scatter
                          dataKey="sellMark"
                          name="sells"
                          isAnimationActive={false}
                          shape={(props: unknown) => (
                            <TradeMarkerShape
                              {...(props as { cx?: number; cy?: number })}
                              side="sell"
                            />
                          )}
                        />
                      )}
                      <Brush
                        dataKey="date"
                        height={18}
                        travellerWidth={8}
                        stroke={CHART_ROLE.neutral}
                        fill="transparent"
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                {/* Underwater curves: how deep each arm sat below its own peak. */}
                <div className="h-40 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={chart}
                      syncId="policy-nudge-replay"
                      margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                    >
                      <CartesianGrid {...GRID_PROPS} />
                      {renderEpisodeBands(holdBands, { labels: false, selectedKey: selectedEpisode })}
                      <XAxis dataKey="date" {...AXIS_PROPS} minTickGap={40} />
                      <YAxis
                        {...AXIS_PROPS}
                        width={58}
                        tickFormatter={(v: number) =>
                          equityMode === "rel"
                            ? `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(0)}pp`
                            : `${Number(v).toFixed(0)}%`
                        }
                        label={{
                          value:
                            equityMode === "rel"
                              ? `Drawdown gap vs ${ARMS.find((a2) => a2.key === compareBase)?.label} (pp)`
                              : "Drawdown (%)",
                          angle: -90,
                          position: "insideLeft",
                          style: { ...AXIS_LABEL, textAnchor: "middle" },
                        }}
                      />
                      <Tooltip
                        labelStyle={TOOLTIP_LABEL_STYLE}
                        contentStyle={{ ...TOOLTIP_CONTENT_STYLE, whiteSpace: "pre-line" }}
                        formatter={(v: number | string, name: string, item) => {
                          if (name === "buys" || name === "sells")
                            return [] as unknown as [string, string];
                          const ev = (item?.payload as { eventLabel?: string | null })?.eventLabel;
                          const head =
                            equityMode === "rel"
                              ? `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(2)}pp`
                              : `${Number(v).toFixed(2)}%`;
                          return [`${head}${ev ? `\n${ev}` : ""}`, name];
                        }}
                      />
                      <ReferenceLine y={0} {...REFERENCE_LINE} />
                      {ARMS.filter((arm) => visibleArms[arm.key]).map((arm) => (
                        <Area
                          key={arm.key}
                          type="monotone"
                          dataKey={equityMode === "rel" ? `${arm.key}DdRel` : `${arm.key}Dd`}
                          name={
                            equityMode === "rel"
                              ? `${arm.label} drawdown gap`
                              : `${arm.label} drawdown`
                          }
                          stroke={arm.color}
                          strokeDasharray={arm.dash}
                          fill={arm.color}
                          fillOpacity={0.12}
                          strokeWidth={1.4}
                          isAnimationActive={false}
                          connectNulls
                        />
                      ))}
                      {markerArm !== "none" && (
                        <Scatter
                          dataKey="buyMarkDd"
                          name="buys"
                          isAnimationActive={false}
                          shape={(props: unknown) => (
                            <TradeMarkerShape
                              {...(props as { cx?: number; cy?: number })}
                              side="buy"
                            />
                          )}
                        />
                      )}
                      {markerArm !== "none" && (
                        <Scatter
                          dataKey="sellMarkDd"
                          name="sells"
                          isAnimationActive={false}
                          shape={(props: unknown) => (
                            <TradeMarkerShape
                              {...(props as { cx?: number; cy?: number })}
                              side="sell"
                            />
                          )}
                        />
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                {/* Every position the annotated arm held, clickable to spotlight. */}
                {markerArm !== "none" && holdBands.length > 0 ? (
                  <TradeEpisodeList
                    bands={holdBands}
                    selectedKey={selectedEpisode}
                    onSelect={setSelectedEpisode}
                    money={(v) => `£${v.toFixed(2)}`}
                  />
                ) : null}

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
