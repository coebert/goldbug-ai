import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Tooltip as UiTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { PolicySweepCell, PolicySweepResult } from "@/lib/backtest/policy-nudge-sweep";
import { runPolicyNudgeSweepFn } from "@/lib/backtest/policy-nudge-replay.functions";

const pp = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}pp`;

/** Colour a cell by how far the regime arm beat (or lost to) the fixed nudge. */
function cellStyle(cell: PolicySweepCell, maxAbs: number) {
  if (cell.outcome === "inactive") {
    return { background: "hsl(var(--muted) / 0.4)", color: "hsl(var(--muted-foreground))" };
  }
  const d = cell.vsFixed.returnPct;
  const mag = maxAbs > 0 ? Math.min(1, Math.abs(d) / maxAbs) : 0;
  const alpha = 0.12 + mag * 0.6;
  const hue = d >= 0 ? 152 : 4;
  return {
    background: `hsl(${hue} 70% 45% / ${alpha})`,
    color: "hsl(var(--foreground))",
  };
}

function outcomeLabel(o: PolicySweepCell["outcome"]) {
  return o === "wins"
    ? "Beats fixed nudge (significant)"
    : o === "leans_win"
      ? "Leans ahead of fixed nudge"
      : o === "flat"
        ? "Effectively identical"
        : o === "leans_loss"
          ? "Leans behind fixed nudge"
          : o === "loses"
            ? "Loses to fixed nudge (significant)"
            : "Scaling never engaged";
}

export function PolicyNudgeSweepCard({ className }: { className?: string }) {
  const run = useServerFn(runPolicyNudgeSweepFn);
  const [lookbackDays, setLookbackDays] = useState(730);
  const [riskLevel, setRiskLevel] = useState(3);
  const [result, setResult] = useState<PolicySweepResult | null>(null);

  const m = useMutation({
    mutationFn: () => run({ data: { lookbackDays, params: { riskLevel } } }),
    onSuccess: (r) => setResult(r as PolicySweepResult),
  });

  const grid = useMemo(() => {
    if (!result) return null;
    const byKey = new Map(result.cells.map((c) => [`${c.nudgeScale}|${c.regimeGain}`, c]));
    const maxAbs = result.cells.reduce(
      (a, c) => (c.scaledDays > 0 ? Math.max(a, Math.abs(c.vsFixed.returnPct)) : a),
      0,
    );
    return { byKey, maxAbs };
  }, [result]);

  return (
    <Card className={className} id="policy-nudge-sweep">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base">Nudge sensitivity sweep</CardTitle>
            <CardDescription>
              Vary how strong the policy nudge is and how hard the market regime is allowed to
              stretch it — the grid shows where regime-aware scaling keeps beating a fixed nudge.
            </CardDescription>
          </div>
          {result ? (
            <Badge variant={result.robustCount > 0 ? "default" : "outline"}>
              {result.robustCount > 0
                ? `${result.robustCount} robust win${result.robustCount === 1 ? "" : "s"}`
                : "No robust win"}
            </Badge>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
            <Label className="text-xs">Risk level: {riskLevel}</Label>
            <Slider
              value={[riskLevel]}
              min={1}
              max={5}
              step={1}
              onValueChange={([v]) => setRiskLevel(v ?? 3)}
            />
          </div>
          <div className="flex items-end">
            <Button onClick={() => m.mutate()} disabled={m.isPending} className="w-full">
              {m.isPending ? "Sweeping the grid…" : "Run sweep"}
            </Button>
          </div>
        </div>

        {m.isError ? (
          <p className="text-sm text-destructive">
            Sweep failed: {(m.error as Error)?.message ?? "unknown error"}
          </p>
        ) : null}

        {result && grid ? (
          <div className="space-y-3">
            {/* Rows = nudge strength, columns = regime gain. */}
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full min-w-[420px] border-separate border-spacing-1 text-xs">
                <thead>
                  <tr>
                    <th className="text-left font-normal text-muted-foreground">
                      Nudge ↓ / Gain →
                    </th>
                    {result.regimeGains.map((g) => (
                      <th key={g} className="font-medium tabular-nums">
                        ×{g.toFixed(1)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.nudgeScales.map((n) => (
                    <tr key={n}>
                      <th className="whitespace-nowrap text-left font-medium tabular-nums">
                        ×{n.toFixed(1)}
                      </th>
                      {result.regimeGains.map((g) => {
                        const cell = grid.byKey.get(`${n}|${g}`);
                        if (!cell)
                          return (
                            <td key={g} className="rounded-md bg-muted/40 p-2 text-center">
                              –
                            </td>
                          );
                        return (
                          <td key={g} className="p-0">
                            <TooltipProvider delayDuration={100}>
                              <UiTooltip>
                                <TooltipTrigger asChild>
                                  <div
                                    className="rounded-md p-2 text-center tabular-nums outline-none ring-offset-background focus-visible:ring-2"
                                    style={cellStyle(cell, grid.maxAbs)}
                                    tabIndex={0}
                                  >
                                    <span className="font-medium">
                                      {cell.scaledDays === 0 ? "–" : pp(cell.vsFixed.returnPct)}
                                    </span>
                                    {cell.significant ? (
                                      <span className="ml-0.5 align-super text-[9px]">★</span>
                                    ) : null}
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-[260px] text-xs">
                                  <div className="font-medium">
                                    Nudge ×{cell.nudgeScale.toFixed(1)}, gain ×
                                    {cell.regimeGain.toFixed(1)}
                                  </div>
                                  <div className="mt-1 text-muted-foreground">
                                    {outcomeLabel(cell.outcome)}
                                  </div>
                                  <ul className="mt-1 space-y-0.5">
                                    <li>
                                      Regime {cell.regimeReturnPct.toFixed(2)}% vs fixed{" "}
                                      {cell.fixedReturnPct.toFixed(2)}% (baseline{" "}
                                      {cell.baselineReturnPct.toFixed(2)}%)
                                    </li>
                                    <li>
                                      95% CI {cell.vsFixedConfidence.returnDeltaLo}..
                                      {cell.vsFixedConfidence.returnDeltaHi}pp
                                    </li>
                                    <li>
                                      Drawdown {cell.regimeDrawdownPct.toFixed(2)}% vs{" "}
                                      {cell.fixedDrawdownPct.toFixed(2)}%
                                    </li>
                                    <li>Average scale ×{cell.avgScale.toFixed(2)}</li>
                                  </ul>
                                </TooltipContent>
                              </UiTooltip>
                            </TooltipProvider>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block h-3 w-5 rounded-sm"
                  style={{ background: "hsl(4 70% 45% / 0.6)" }}
                />
                behind fixed nudge
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block h-3 w-5 rounded-sm"
                  style={{ background: "hsl(152 70% 45% / 0.6)" }}
                />
                ahead of fixed nudge
              </span>
              <span>★ = 95% interval clear of zero</span>
            </div>

            <p className="text-sm text-muted-foreground">{result.summary}</p>
            <p className="text-[11px] text-muted-foreground">
              {result.from} → {result.to} · {result.tradingDays} bars · {result.symbols.length}{" "}
              symbols · gain ×0 is the fixed nudge itself, so that column is always flat.
            </p>
          </div>
        ) : !m.isPending ? (
          <p className="text-sm text-muted-foreground">
            Run the sweep to see a grid of nudge strengths against regime-scaling gains.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
