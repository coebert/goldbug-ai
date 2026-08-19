// "What if these rules had run?" — replays the displayed stop / target /
// trailing / max-hold levels over recent history at the portfolio's current
// risk setting, so the levels can be judged rather than just read.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { FlaskConical } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getRuleWhatIf } from "@/lib/backtest/rule-what-if.functions";
import type { WhatIfExitReason, WhatIfResult } from "@/lib/backtest/rule-what-if";
import { formatUkDate } from "@/lib/uk-time";
import { cn } from "@/lib/utils";

const WINDOWS = [90, 180, 365] as const;

const EXIT_LABEL: Record<WhatIfExitReason, string> = {
  stop: "Stopped out",
  trailing: "Trailing stop",
  target: "Target hit",
  max_hold: "Max hold",
  open: "Still open",
};

const EXIT_TONE: Record<WhatIfExitReason, string> = {
  stop: "border-rose-500/40 text-rose-400",
  trailing: "border-amber-500/40 text-amber-400",
  target: "border-emerald-500/40 text-emerald-400",
  max_hold: "border-sky-500/40 text-sky-400",
  open: "border-muted-foreground/40 text-muted-foreground",
};

const pct = (v: number | null | undefined, dp = 1) =>
  v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(dp)}%`;

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border bg-muted/20 p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("text-sm font-semibold tabular-nums", tone)}>{value}</div>
    </div>
  );
}

function WhatIfBody({ result }: { result: WhatIfResult }) {
  const s = result.summary;
  const data = result.equity.map((p) => ({ date: p.date, cum: p.cumPct * 100 }));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <Stat
          label="Rule total"
          value={pct(s.totalReturnPct)}
          tone={s.totalReturnPct >= 0 ? "text-emerald-400" : "text-rose-400"}
        />
        <Stat
          label="Buy & hold"
          value={pct(result.buyHoldPct)}
          tone={(result.buyHoldPct ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}
        />
        <Stat label="Win rate" value={s.winRate == null ? "—" : `${Math.round(s.winRate * 100)}%`} />
        <Stat label="Max drawdown" value={pct(-s.maxDrawdownPct)} tone="text-rose-400" />
        <Stat label="Trades" value={String(s.trades)} />
        <Stat label="Avg per trade" value={pct(s.avgReturnPct, 2)} />
        <Stat label="Best / worst" value={`${pct(s.bestPct)} / ${pct(s.worstPct)}`} />
        <Stat
          label="Avg hold"
          value={s.avgHoldDays == null ? "—" : `${s.avgHoldDays.toFixed(1)}d`}
        />
      </div>

      {data.length > 1 && (
        <div className="h-40 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="whatif-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10 }}
                tickFormatter={(d: string) => formatUkDate(d)}
                minTickGap={24}
              />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `${v.toFixed(0)}%`} width={40} />
              <Tooltip
                contentStyle={{ fontSize: 11 }}
                labelFormatter={(d) => formatUkDate(String(d))}
                formatter={(v: number) => [`${v.toFixed(2)}%`, "Cumulative"]}
              />
              <Area
                type="monotone"
                dataKey="cum"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                fill="url(#whatif-fill)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(EXIT_LABEL) as WhatIfExitReason[])
          .filter((k) => s.exitMix[k] > 0)
          .map((k) => (
            <Badge key={k} variant="outline" className={cn("text-[10px]", EXIT_TONE[k])}>
              {EXIT_LABEL[k]} × {s.exitMix[k]}
            </Badge>
          ))}
      </div>

      <div className="rounded-md border bg-muted/20 p-2 text-[11px] leading-relaxed text-muted-foreground">
        <p>
          Stop {pct(-result.rules.stopPct, 2)} — {result.rules.stopBasis}.
        </p>
        {result.rules.targetPct != null && (
          <p>
            Target {pct(result.rules.targetPct, 2)} — {result.rules.targetBasis}.
          </p>
        )}
        {result.rules.trailingPct != null && <p>Trailing stop {pct(-result.rules.trailingPct, 2)} below the run high.</p>}
        <p>
          Max hold {result.rules.maxHoldDays}d · entry slack {result.rules.entrySlackBps.toFixed(1)}bps · exit slack{" "}
          {result.rules.exitSlackBps.toFixed(1)}bps · ATR {(result.rules.atrPct * 100).toFixed(2)}% (
          {result.rules.atrSource}).
        </p>
      </div>

      {result.trades.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[380px] text-[11px]">
            <thead className="text-muted-foreground">
              <tr className="text-left">
                <th className="py-1 pr-2 font-medium">Entry</th>
                <th className="py-1 pr-2 font-medium">Exit</th>
                <th className="py-1 pr-2 font-medium">Reason</th>
                <th className="py-1 pr-2 text-right font-medium">Hold</th>
                <th className="py-1 text-right font-medium">Return</th>
              </tr>
            </thead>
            <tbody>
              {result.trades.slice(-12).reverse().map((t) => (
                <tr key={`${t.entryDate}-${t.exitDate}`} className="border-t">
                  <td className="py-1 pr-2 tabular-nums">{formatUkDate(t.entryDate)}</td>
                  <td className="py-1 pr-2 tabular-nums">{formatUkDate(t.exitDate)}</td>
                  <td className="py-1 pr-2">{EXIT_LABEL[t.reason]}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{t.holdDays}d</td>
                  <td
                    className={cn(
                      "py-1 text-right font-medium tabular-nums",
                      t.returnPct >= 0 ? "text-emerald-400" : "text-rose-400",
                    )}
                  >
                    {pct(t.returnPct, 2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result.notes.map((n) => (
        <p key={n} className="text-[10px] leading-relaxed text-muted-foreground">
          {n}
        </p>
      ))}
    </div>
  );
}

export function RuleWhatIfPanel({ portfolioId, symbol }: { portfolioId: string; symbol: string }) {
  const [windowDays, setWindowDays] = useState<number>(180);
  const fetchWhatIf = useServerFn(getRuleWhatIf);
  const query = useQuery({
    queryKey: ["rule-what-if", portfolioId, symbol, windowDays],
    queryFn: () => fetchWhatIf({ data: { portfolioId, symbol, windowDays } }),
    staleTime: 10 * 60_000,
  });

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
          <FlaskConical className="h-3.5 w-3.5" />
          What-if: these rules over recent history
        </div>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <Button
              key={w}
              size="sm"
              variant={windowDays === w ? "secondary" : "ghost"}
              className="h-6 px-2 text-[11px]"
              onClick={() => setWindowDays(w)}
            >
              {w}d
            </Button>
          ))}
        </div>
      </div>

      {query.isLoading && <div className="h-32 animate-pulse rounded-md bg-muted" aria-hidden />}
      {query.error && (
        <p className="text-xs text-destructive">Couldn't run the what-if: {(query.error as Error).message}</p>
      )}
      {query.data && (
        <>
          <p className="mb-1.5 text-[11px] text-muted-foreground">
            Risk level {query.data.riskLevel}/5 ({query.data.riskLevelName}) applied to {symbol}
            {query.data.result ? ` · ${query.data.result.bars} sessions to ${formatUkDate(query.data.result.to)}` : ""}.
          </p>
          {query.data.result ? (
            <WhatIfBody result={query.data.result} />
          ) : (
            <p className="text-xs text-muted-foreground">{query.data.reason ?? "No history available."}</p>
          )}
        </>
      )}
    </div>
  );
}
