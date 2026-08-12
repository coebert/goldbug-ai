import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import type { NudgeReplayResult } from "@/lib/backtest/insider-nudge-replay";
import type { WalkForwardResult } from "@/lib/backtest/insider-nudge-oos";
import {
  runNudgeReplayFn,
  runNudgeWalkForwardFn,
} from "@/lib/backtest/insider-nudge-replay.functions";

const pp = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}pp`;
const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;

function verdictBadge(v: NudgeReplayResult["verdict"]) {
  if (v === "helps") return <Badge className="bg-primary text-primary-foreground">Nudge helped</Badge>;
  if (v === "hurts") return <Badge variant="destructive">Nudge hurt</Badge>;
  return <Badge variant="outline">No measurable effect</Badge>;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border/60 p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`text-sm font-medium tabular-nums ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

/**
 * Replays the trend strategy over the last 1-2 years twice — with and without
 * the bounded director-dealing nudge — so the nudge has to justify itself.
 */
export function InsiderNudgeReplayCard({
  symbols,
  className,
}: {
  symbols?: string[];
  className?: string;
}) {
  const run = useServerFn(runNudgeReplayFn);
  const [lookbackDays, setLookbackDays] = useState(730);
  const [minValue, setMinValue] = useState(100_000);
  const [nudgeScale, setNudgeScale] = useState(1);
  const [riskLevel, setRiskLevel] = useState(3);
  const [result, setResult] = useState<NudgeReplayResult | null>(null);
  const [mode, setMode] = useState<"single" | "walkforward">("single");
  const [trainMonths, setTrainMonths] = useState(9);
  const [testMonths, setTestMonths] = useState(3);
  const [objective, setObjective] = useState<"return" | "sharpe" | "calmar">("return");
  const [wf, setWf] = useState<WalkForwardResult | null>(null);
  const runWf = useServerFn(runNudgeWalkForwardFn);
  const wfm = useMutation({
    mutationFn: () =>
      runWf({
        data: {
          symbols,
          lookbackDays,
          minValue,
          params: { riskLevel },
          options: { trainMonths, testMonths, objective, scaleGrid: [0, 0.5, 1, 2] },
        },
      }),
    onSuccess: (r) => setWf(r as WalkForwardResult),
  });

  const m = useMutation({
    mutationFn: () =>
      run({ data: { symbols, lookbackDays, minValue, params: { nudgeScale, riskLevel } } }),
    onSuccess: (r) => setResult(r as NudgeReplayResult),
  });

  const chart =
    result?.baseline.curve.map((c, i) => ({
      date: c.date,
      baseline: c.equity,
      nudged: result.nudged.curve[i]?.equity ?? null,
    })) ?? [];

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Insider-nudge replay</CardTitle>
            <CardDescription>
              Same strategy, same tape, same costs — the only difference is the bounded
              director-dealing nudge on the symbol score.
            </CardDescription>
          </div>
          {result ? verdictBadge(result.verdict) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="inline-flex rounded-lg border border-border/60 p-0.5 text-xs">
          {(["single", "walkforward"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setMode(k)}
              className={`rounded-md px-2.5 py-1 ${
                mode === k ? "bg-primary text-primary-foreground" : "text-muted-foreground"
              }`}
            >
              {k === "single" ? "Single pass" : "Rolling out-of-sample"}
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="nr-lookback" className="text-xs">
              Lookback (days)
            </Label>
            <Input
              id="nr-lookback"
              type="number"
              min={365}
              max={900}
              step={30}
              value={lookbackDays}
              onChange={(e) => setLookbackDays(Number(e.target.value) || 730)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="nr-min" className="text-xs">
              Min deal size
            </Label>
            <Input
              id="nr-min"
              type="number"
              min={0}
              step={50_000}
              value={minValue}
              onChange={(e) => setMinValue(Number(e.target.value) || 0)}
            />
          </div>
          <div className={`space-y-1 ${mode === "walkforward" ? "hidden" : ""}`}>
            <Label className="text-xs">Nudge strength ×{nudgeScale.toFixed(1)}</Label>
            <Slider
              value={[nudgeScale]}
              min={0}
              max={3}
              step={0.5}
              onValueChange={(v) => setNudgeScale(v[0] ?? 1)}
              aria-label="Nudge strength"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">
              Risk level {riskLevel}
              {result ? ` — ${result.sizing.name}` : ""}
            </Label>
            <Slider
              value={[riskLevel]}
              min={1}
              max={5}
              step={1}
              onValueChange={(v) => setRiskLevel(v[0] ?? 3)}
              aria-label="Risk level"
            />
            <p className="text-[11px] text-muted-foreground">
              Sizes both arms with the same dial preset the live AI uses.
            </p>
          </div>
        </div>

        {mode === "walkforward" ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="wf-train" className="text-xs">
                Train window (months)
              </Label>
              <Input
                id="wf-train"
                type="number"
                min={3}
                max={18}
                value={trainMonths}
                onChange={(e) => setTrainMonths(Number(e.target.value) || 9)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wf-test" className="text-xs">
                Evaluate window (months)
              </Label>
              <Input
                id="wf-test"
                type="number"
                min={1}
                max={12}
                value={testMonths}
                onChange={(e) => setTestMonths(Number(e.target.value) || 3)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wf-obj" className="text-xs">
                Training objective
              </Label>
              <select
                id="wf-obj"
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={objective}
                onChange={(e) => setObjective(e.target.value as typeof objective)}
              >
                <option value="return">Return</option>
                <option value="sharpe">Sharpe</option>
                <option value="calmar">Return / drawdown</option>
              </select>
            </div>
          </div>
        ) : null}

        {mode === "single" ? (
          <Button onClick={() => m.mutate()} disabled={m.isPending} size="sm">
            {m.isPending ? "Replaying…" : "Run replay"}
          </Button>
        ) : (
          <Button onClick={() => wfm.mutate()} disabled={wfm.isPending} size="sm">
            {wfm.isPending ? "Walking forward…" : "Run rolling test"}
          </Button>
        )}

        {mode === "walkforward" && wfm.isError ? (
          <p className="text-xs text-destructive">
            {(wfm.error as Error)?.message ?? "Walk-forward failed."}
          </p>
        ) : null}

        {mode === "walkforward" && wf ? <WalkForwardBlock r={wf} /> : null}

        {mode === "single" && m.isError ? (
          <p className="text-xs text-destructive">
            {(m.error as Error)?.message ?? "Replay failed."}
          </p>
        ) : null}

        {mode === "single" && result ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{result.summary}</p>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat
                label="Return delta"
                value={pp(result.delta.returnPct)}
                tone={result.delta.returnPct < 0 ? "text-destructive" : "text-primary"}
              />
              <Stat
                label="Drawdown delta"
                value={pp(result.delta.maxDrawdownPct)}
                tone={result.delta.maxDrawdownPct < 0 ? "text-primary" : "text-destructive"}
              />
              <Stat label="Sharpe delta" value={result.delta.sharpe.toFixed(2)} />
              <Stat
                label="95% VaR delta"
                value={pp(result.delta.var95Pct)}
                tone={result.delta.var95Pct <= 0 ? "text-primary" : "text-destructive"}
              />
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs tabular-nums">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 text-left font-normal">Arm</th>
                    <th className="py-1 pr-3 text-right font-normal">Return</th>
                    <th className="py-1 pr-3 text-right font-normal">Max DD</th>
                    <th className="py-1 pr-3 text-right font-normal">Sharpe</th>
                    <th className="py-1 pr-3 text-right font-normal">VaR 95%</th>
                    <th className="py-1 pr-3 text-right font-normal">CVaR 95%</th>
                    <th className="py-1 pr-3 text-right font-normal">Avg gross</th>
                    <th className="py-1 pr-3 text-right font-normal">Cost</th>
                    <th className="py-1 text-right font-normal">Tickets</th>
                  </tr>
                </thead>
                <tbody>
                  {[result.baseline, result.nudged].map((a) => (
                    <tr key={a.label} className="border-t border-border/40">
                      <td className="py-1 pr-3">{a.label}</td>
                      <td className="py-1 pr-3 text-right">{pct(a.totalReturnPct)}</td>
                      <td className="py-1 pr-3 text-right">{a.maxDrawdownPct.toFixed(2)}%</td>
                      <td className="py-1 pr-3 text-right">{a.sharpe.toFixed(2)}</td>
                      <td className="py-1 pr-3 text-right">{a.var95Pct.toFixed(2)}%</td>
                      <td className="py-1 pr-3 text-right">{a.cvar95Pct.toFixed(2)}%</td>
                      <td className="py-1 pr-3 text-right">{(a.avgGross * 100).toFixed(0)}%</td>
                      <td className="py-1 pr-3 text-right">{a.totalCost.toFixed(0)}</td>
                      <td className="py-1 text-right">{a.trades}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {chart.length > 0 ? (
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chart} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={40} />
                    <YAxis tick={{ fontSize: 10 }} width={52} domain={["auto", "auto"]} />
                    <Tooltip
                      contentStyle={{ fontSize: 12 }}
                      formatter={(v: number | string) => Number(v).toFixed(0)}
                    />
                    <Line
                      type="monotone"
                      dataKey="baseline"
                      dot={false}
                      strokeWidth={1.5}
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <Line
                      type="monotone"
                      dataKey="nudged"
                      dot={false}
                      strokeWidth={1.8}
                      stroke="hsl(var(--primary))"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            ) : null}

            <div className="rounded-lg border border-border/60 p-3 text-xs">
              <div className="mb-1 font-medium">What the nudge actually did</div>
              <ul className="space-y-1 text-muted-foreground">
                <li>
                  {result.attribution.eventsInWindow} filings in window (
                  {result.attribution.sellEvents} sells, {result.attribution.buyEvents} buys)
                </li>
                <li>
                  Kept {result.attribution.suppressedSymbols} name(s) out on{" "}
                  {result.attribution.suppressedDays} symbol-day(s); those names then returned{" "}
                  {result.attribution.suppressedForward21Pct == null
                    ? "n/a"
                    : pct(result.attribution.suppressedForward21Pct)}{" "}
                  over the next 21 days
                </li>
                <li>
                  Pulled names in on {result.attribution.promotedDays} symbol-day(s); forward 21d{" "}
                  {result.attribution.promotedForward21Pct == null
                    ? "n/a"
                    : pct(result.attribution.promotedForward21Pct)}
                </li>
                <li>
                  Sized at {result.sizing.name} (level {result.sizing.level}): per-symbol cap{" "}
                  {(result.sizing.perSymbolCap * 100).toFixed(0)}%, size ×
                  {result.sizing.aggressiveness.sizeMult}, buy fill{" "}
                  {(result.sizing.aggressiveness.buy * 100).toFixed(0)}%, drift band{" "}
                  {(result.sizing.aggressiveness.driftBand * 100).toFixed(2)}%
                </li>
                <li>
                  95% CI on return delta {result.confidence.returnDeltaLo}..
                  {result.confidence.returnDeltaHi}pp over {result.tradingDays} bars (
                  {result.from} → {result.to})
                </li>
              </ul>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Out-of-sample block: stitched curves plus what each fold trained and picked. */
function WalkForwardBlock({ r }: { r: WalkForwardResult }) {
  const chart = r.baseline.curve.map((c, i) => ({
    date: c.date,
    baseline: c.equity,
    nudged: r.nudged.curve[i]?.equity ?? null,
  }));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {r.verdict === "helps" ? (
          <Badge className="bg-primary text-primary-foreground">Holds up out of sample</Badge>
        ) : r.verdict === "hurts" ? (
          <Badge variant="destructive">Hurts out of sample</Badge>
        ) : (
          <Badge variant="outline">
            {r.verdict === "insufficient" ? "Not enough history" : "No out-of-sample edge"}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          Fold win rate {(r.foldWinRate * 100).toFixed(0)}%
        </span>
      </div>

      <p className="text-sm text-muted-foreground">{r.summary}</p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat
          label="OOS return delta"
          value={pp(r.delta.returnPct)}
          tone={r.delta.returnPct < 0 ? "text-destructive" : "text-primary"}
        />
        <Stat
          label="Drawdown delta"
          value={pp(r.delta.maxDrawdownPct)}
          tone={r.delta.maxDrawdownPct < 0 ? "text-primary" : "text-destructive"}
        />
        <Stat label="Sharpe delta" value={r.delta.sharpe.toFixed(2)} />
        <Stat
          label="95% VaR delta"
          value={pp(r.delta.var95Pct)}
          tone={r.delta.var95Pct <= 0 ? "text-primary" : "text-destructive"}
        />
      </div>

      {chart.length > 0 ? (
        <div className="h-44 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={40} />
              <YAxis tick={{ fontSize: 10 }} width={52} domain={["auto", "auto"]} />
              <Tooltip
                contentStyle={{ fontSize: 12 }}
                formatter={(v: number | string) => Number(v).toFixed(0)}
              />
              <Line
                type="monotone"
                dataKey="baseline"
                dot={false}
                strokeWidth={1.5}
                stroke="hsl(var(--muted-foreground))"
              />
              <Line
                type="monotone"
                dataKey="nudged"
                dot={false}
                strokeWidth={1.8}
                stroke="hsl(var(--primary))"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : null}

      {r.folds.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 text-left font-normal">Fold</th>
                <th className="py-1 pr-3 text-left font-normal">Train</th>
                <th className="py-1 pr-3 text-left font-normal">Evaluate</th>
                <th className="py-1 pr-3 text-right font-normal">Picked ×</th>
                <th className="py-1 pr-3 text-right font-normal">Train edge</th>
                <th className="py-1 pr-3 text-right font-normal">OOS base</th>
                <th className="py-1 pr-3 text-right font-normal">OOS nudge</th>
                <th className="py-1 text-right font-normal">OOS delta</th>
              </tr>
            </thead>
            <tbody>
              {r.folds.map((f) => (
                <tr key={f.index} className="border-t border-border/40">
                  <td className="py-1 pr-3">{f.index}</td>
                  <td className="py-1 pr-3">
                    {f.trainFrom} → {f.trainTo}
                  </td>
                  <td className="py-1 pr-3">
                    {f.testFrom} → {f.testTo}
                  </td>
                  <td className="py-1 pr-3 text-right">{f.chosenScale.toFixed(1)}</td>
                  <td className="py-1 pr-3 text-right">{pp(f.trainDeltaPct)}</td>
                  <td className="py-1 pr-3 text-right">{pct(f.testBaselinePct)}</td>
                  <td className="py-1 pr-3 text-right">{pct(f.testNudgedPct)}</td>
                  <td
                    className={`py-1 text-right ${
                      f.testDeltaPct < 0 ? "text-destructive" : "text-primary"
                    }`}
                  >
                    {pp(f.testDeltaPct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="text-[11px] text-muted-foreground">
        Each fold tunes the nudge strength on {r.options.trainMonths} months of history and is then
        scored blind on the following {r.options.testMonths} months; only evaluation windows are
        compounded into the curves above.
      </p>
    </div>
  );
}
