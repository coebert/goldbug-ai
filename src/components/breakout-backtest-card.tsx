import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Play, Target, ShieldAlert, ShieldCheck, HelpCircle } from "lucide-react";
import {
  runBreakoutSignalBacktest,
  type BreakoutBacktestResponse,
} from "@/lib/breakout-backtest.functions";
import type { CohortStats, SignalCohort } from "@/lib/breakout-backtest";
import { BreakoutDiagnosticsSection } from "@/components/breakout-diagnostics-section";

const COHORTS: readonly SignalCohort[] = ["confirmed", "pending", "extended", "failed"];
const REGIMES = ["all", "bull", "bear", "sideways"] as const;

const COHORT_BLURB: Record<SignalCohort, string> = {
  confirmed: "Held above the broken level on volume — the engine sizes these up.",
  pending: "Cleared the level but not yet held for the confirmation bars.",
  extended: "Confirmed but stale — too late to chase.",
  failed: "Pierced then closed back inside — traded as a reversal.",
};

const tone = (v: number, invert = false) =>
  (invert ? v <= 0 : v >= 0) ? "text-emerald-500" : "text-red-500";

const pp = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

function VerdictBadge({ verdict }: { verdict: BreakoutBacktestResponse["edge"]["verdict"] }) {
  if (verdict === "supported") {
    return (
      <Badge className="gap-1 bg-emerald-500/15 text-emerald-500 border-emerald-500/30">
        <ShieldCheck className="h-3 w-3" /> Edge supported
      </Badge>
    );
  }
  if (verdict === "not_supported") {
    return (
      <Badge className="gap-1 bg-red-500/15 text-red-500 border-red-500/30">
        <ShieldAlert className="h-3 w-3" /> No edge
      </Badge>
    );
  }
  if (verdict === "weak") {
    return (
      <Badge className="gap-1 bg-amber-500/15 text-amber-500 border-amber-500/30">
        <ShieldAlert className="h-3 w-3" /> Weak edge
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1">
      <HelpCircle className="h-3 w-3" /> Not enough signals
    </Badge>
  );
}

function StatRow({ s }: { s: CohortStats }) {
  return (
    <tr className="border-t border-border/60">
      <td className="py-1.5 pr-3 capitalize whitespace-nowrap">{s.regime}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{s.trades}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums">{s.winRatePct.toFixed(1)}%</td>
      <td className={`py-1.5 pr-3 text-right tabular-nums ${tone(s.avgReturnPct)}`}>
        {pp(s.avgReturnPct)}
      </td>
      <td className={`py-1.5 pr-3 text-right tabular-nums ${tone(s.expectancyPct)}`}>
        {pp(s.expectancyPct)}
      </td>
      <td className="py-1.5 pr-3 text-right tabular-nums text-red-500">
        {s.maxDrawdownPct.toFixed(1)}%
      </td>
      <td className="py-1.5 text-right tabular-nums text-muted-foreground">
        {s.profitFactor == null ? "∞" : s.profitFactor.toFixed(2)}
      </td>
    </tr>
  );
}

export function BreakoutBacktestCard({ portfolioId }: { portfolioId: string }) {
  const backtestFn = useServerFn(runBreakoutSignalBacktest);
  const [result, setResult] = useState<BreakoutBacktestResponse | null>(null);
  const [lookbackDays, setLookbackDays] = useState(730);

  const run = useMutation({
    mutationFn: () => backtestFn({ data: { portfolioId, lookbackDays } }),
    onSuccess: (r) => setResult(r),
  });

  const byCohort = useMemo(() => {
    if (!result) return [];
    return COHORTS.map((cohort) => ({
      cohort,
      rows: REGIMES.map(
        (regime) => result.stats.find((s) => s.cohort === cohort && s.regime === regime)!,
      ).filter((s) => s && s.trades > 0),
    })).filter((c) => c.rows.length > 0);
  }, [result]);

  return (
    <Card data-testid="breakout-backtest-card">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Target className="h-4 w-4" /> Breakout signal backtest
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Replays the breakout detector over historical candles and scores what each
              signal actually earned — win rate, average return and drawdown for confirmed
              versus failed breakouts, split by bull / bear / sideways tape.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              value={lookbackDays}
              onChange={(e) => setLookbackDays(Number(e.target.value))}
              aria-label="History window"
            >
              <option value={365}>1 year</option>
              <option value={730}>2 years</option>
              <option value={1825}>5 years</option>
            </select>
            <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
              <Play className="mr-1 h-3 w-3" />
              {run.isPending ? "Running…" : "Run report"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {run.isError && (
          <p className="text-xs text-destructive">{(run.error as Error).message}</p>
        )}
        {!result && !run.isPending && (
          <p className="text-xs text-muted-foreground">
            No report yet — run it to see whether confirmed breakouts have paid.
          </p>
        )}

        {result && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <VerdictBadge verdict={result.edge.verdict} />
              <span className="text-xs text-muted-foreground">
                {result.totalTrades} signals · {result.symbols.length} symbols ·{" "}
                {result.from ?? "?"} → {result.to ?? "?"}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-border/60 p-3">
                <p className="text-[11px] text-muted-foreground">Confirmed win rate</p>
                <p className="text-lg font-semibold tabular-nums">
                  {result.edge.confirmedWinRatePct.toFixed(1)}%
                </p>
              </div>
              <div className="rounded-lg border border-border/60 p-3">
                <p className="text-[11px] text-muted-foreground">Failed win rate</p>
                <p className="text-lg font-semibold tabular-nums">
                  {result.edge.failedWinRatePct.toFixed(1)}%
                </p>
              </div>
              <div className="rounded-lg border border-border/60 p-3">
                <p className="text-[11px] text-muted-foreground">Win-rate gap</p>
                <p className={`text-lg font-semibold tabular-nums ${tone(result.edge.winRateGapPp)}`}>
                  {result.edge.winRateGapPp >= 0 ? "+" : ""}
                  {result.edge.winRateGapPp.toFixed(1)}pp
                </p>
              </div>
              <div className="rounded-lg border border-border/60 p-3">
                <p className="text-[11px] text-muted-foreground">Avg return gap</p>
                <p className={`text-lg font-semibold tabular-nums ${tone(result.edge.avgReturnGapPct)}`}>
                  {pp(result.edge.avgReturnGapPct)}
                </p>
              </div>
            </div>

            <ul className="space-y-1 text-xs text-muted-foreground">
              {result.edge.notes.map((n) => (
                <li key={n}>• {n}</li>
              ))}
            </ul>

            <div className="space-y-4">
              {byCohort.map(({ cohort, rows }) => (
                <div key={cohort}>
                  <p className="text-xs font-medium capitalize">{cohort}</p>
                  <p className="text-[11px] text-muted-foreground">{COHORT_BLURB[cohort]}</p>
                  <div className="mt-1 overflow-x-auto">
                    <table className="w-full min-w-[520px] text-xs">
                      <thead className="text-[11px] text-muted-foreground">
                        <tr>
                          <th className="py-1 pr-3 text-left font-normal">Regime</th>
                          <th className="py-1 pr-3 text-right font-normal">Signals</th>
                          <th className="py-1 pr-3 text-right font-normal">Win rate</th>
                          <th className="py-1 pr-3 text-right font-normal">Avg return</th>
                          <th className="py-1 pr-3 text-right font-normal">Expectancy</th>
                          <th className="py-1 pr-3 text-right font-normal">Max DD</th>
                          <th className="py-1 text-right font-normal">Profit factor</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((s) => (
                          <StatRow key={`${cohort}-${s.regime}`} s={s} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>

            {result.diagnostics && (
              <BreakoutDiagnosticsSection
                diagnostics={result.diagnostics}
                timing={result.timing}
              />
            )}

            <p className="text-[11px] text-muted-foreground">
              Trades are opened at the signal bar's close, held up to{" "}
              {result.config.horizonBars} sessions with a {result.config.stopAtr} ATR stop and{" "}
              {result.config.targetAtr} ATR target, net of {result.config.costBps} bps
              round-trip costs. Failed breakouts are traded as reversals.
              {result.skippedSymbols.length > 0 && (
                <> Skipped for thin history: {result.skippedSymbols.join(", ")}.</>
              )}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
