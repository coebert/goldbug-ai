import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AXIS_PROPS,
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

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`truncate text-sm font-medium tabular-nums ${tone ?? ""}`}>{value}</div>
    </div>
  );
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

  const m = useMutation({
    mutationFn: () =>
      run({
        data: { symbols, lookbackDays, params: { nudgeScale, halfLifeHours, riskLevel } },
      }),
    onSuccess: (r) => setResult(r as PolicyNudgeReplayResult),
  });

  const chart =
    result?.baseline.curve.map((c, i) => ({
      date: c.date,
      baseline: c.equity,
      nudged: result.nudged.curve[i]?.equity ?? null,
      spread: (result.nudged.curve[i]?.equity ?? c.equity) - c.equity,
    })) ?? [];

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
                  {[result.baseline, result.nudged].map((arm) => (
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
                <div className="h-56 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chart} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid {...GRID_PROPS} />
                      <XAxis dataKey="date" {...AXIS_PROPS} minTickGap={40} />
                      <YAxis {...AXIS_PROPS} width={52} domain={["auto", "auto"]} />
                      <Tooltip
                        contentStyle={TOOLTIP_CONTENT_STYLE}
                        labelStyle={TOOLTIP_LABEL_STYLE}
                        formatter={(v: number | string) => Number(v).toFixed(0)}
                      />
                      <Line
                        type="monotone"
                        dataKey="baseline"
                        name="Policy muted"
                        stroke="hsl(var(--muted-foreground))"
                        dot={false}
                        strokeWidth={1.5}
                      />
                      <Line
                        type="monotone"
                        dataKey="nudged"
                        name="With policy nudge"
                        stroke="hsl(var(--primary))"
                        dot={false}
                        strokeWidth={1.8}
                      />
                    </LineChart>
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
