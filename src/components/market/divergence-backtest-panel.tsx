// Divergence backtest panel: how often the divergences drawn on this chart
// led to a real reversal versus a failed setup.

import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_DIVERGENCE_FRICTION_BPS,
  DEFAULT_DIVERGENCE_HORIZON,
  DEFAULT_DIVERGENCE_TARGET_PCT,
  backtestRsiDivergences,
  divergenceBacktestVerdict,
  type DivergenceStats,
  type DivergenceTrade,
} from "@/lib/rsi-divergence-backtest";
import { divergenceTradeId } from "@/lib/backtest-trade-markers";
import type { HistoryPoint } from "@/lib/market-symbol-history";
import { formatUkDate } from "@/lib/uk-time";

const HORIZONS = [5, 10, 15, 30];
const TARGETS = [2, 3, 5];
const FRICTIONS = [0, 20, 40, 80];

function pct(v: number, digits = 1) {
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: "positive" | "negative"; hint?: string }) {
  return (
    <div className="rounded-md border border-border/60 p-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p
        className={`text-sm font-semibold tabular-nums ${
          tone === "positive" ? "text-emerald-500" : tone === "negative" ? "text-destructive" : ""
        }`}
      >
        {value}
      </p>
      {hint ? <p className="text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function SideRow({ label, s }: { label: string; s: DivergenceStats }) {
  if (!s.trades) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {label}: none confirmed in this window.
      </p>
    );
  }
  return (
    <p className="text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">{label}</span>: {s.trades} setups ·{" "}
      {(s.hitRate * 100).toFixed(0)}% reversed · {(s.failRate * 100).toFixed(0)}% failed ·{" "}
      {pct(s.avgReturn, 2)} avg · {s.avgBars.toFixed(0)} bars held
    </p>
  );
}

function Toggles<T extends number>({
  label,
  values,
  value,
  onChange,
  suffix,
}: {
  label: string;
  values: readonly T[];
  value: T;
  onChange: (v: T) => void;
  suffix: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {values.map((v) => (
        <Button
          key={v}
          size="sm"
          variant={v === value ? "secondary" : "ghost"}
          className="h-6 px-2 text-[11px]"
          aria-pressed={v === value}
          onClick={() => onChange(v)}
        >
          {v}
          {suffix}
        </Button>
      ))}
    </div>
  );
}

export function DivergenceBacktestPanel({
  points,
  rangeLabel,
  onTrades,
  selectedTradeId = null,
  onSelectTrade,
}: {
  points: HistoryPoint[];
  rangeLabel?: string;
  /** Reports the executed setups so the charts above can mark them. */
  onTrades?: (trades: DivergenceTrade[]) => void;
  /** Currently highlighted setup, if any. */
  selectedTradeId?: string | null;
  /** Click-to-highlight: jump the charts to this setup's entry and exit. */
  onSelectTrade?: (trade: DivergenceTrade | null) => void;
}) {
  const [horizon, setHorizon] = useState(DEFAULT_DIVERGENCE_HORIZON);
  const [targetPct, setTargetPct] = useState(DEFAULT_DIVERGENCE_TARGET_PCT);
  const [frictionBps, setFrictionBps] = useState(DEFAULT_DIVERGENCE_FRICTION_BPS);

  const result = useMemo(
    () => backtestRsiDivergences(points, { horizon, targetPct, frictionBps }),
    [points, horizon, targetPct, frictionBps],
  );

  useEffect(() => {
    onTrades?.(result.trades);
  }, [result.trades, onTrades]);

  useEffect(() => () => onTrades?.([]), [onTrades]);


  const o = result.overall;

  return (
    <section className="space-y-3 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-medium">RSI divergence backtest</h2>
          <p className="text-[11px] text-muted-foreground">
            Entry {3} bars after each pivot is confirmed, exit on target, invalidation or horizon
            {rangeLabel ? ` · ${rangeLabel}` : ""}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Toggles label="Hold" values={HORIZONS} value={horizon} onChange={setHorizon} suffix="d" />
          <Toggles label="Target" values={TARGETS} value={targetPct} onChange={setTargetPct} suffix="%" />
          <Toggles label="Cost" values={FRICTIONS} value={frictionBps} onChange={setFrictionBps} suffix="bps" />
        </div>
      </div>

      {o.trades ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat
              label="Reversal rate"
              value={`${(o.hitRate * 100).toFixed(0)}%`}
              hint={`${o.trades} setups`}
              tone={o.hitRate >= o.failRate ? "positive" : undefined}
            />
            <Stat
              label="Failed setups"
              value={`${(o.failRate * 100).toFixed(0)}%`}
              tone={o.failRate > o.hitRate ? "negative" : undefined}
              hint="broke invalidation"
            />
            <Stat
              label="Avg net"
              value={pct(o.avgReturn, 2)}
              tone={o.avgReturn >= 0 ? "positive" : "negative"}
              hint={`median ${pct(o.medianReturn, 2)}`}
            />
            <Stat
              label="Profit factor"
              value={Number.isFinite(o.profitFactor) ? o.profitFactor.toFixed(2) : "∞"}
              tone={o.profitFactor >= 1 ? "positive" : "negative"}
            />
            <Stat label="Avg best move" value={pct(o.avgMfe, 1)} hint={`worst ${pct(-o.avgMae, 1)}`} />
            <Stat label="Avg hold" value={`${o.avgBars.toFixed(0)} bars`} />
          </div>

          <div className="space-y-0.5">
            <SideRow label="Bullish" s={result.bullish} />
            <SideRow label="Bearish" s={result.bearish} />
          </div>

          <div className="space-y-1.5">
            <p className="text-[11px] font-medium text-muted-foreground">
              Recent setups · click one to jump the charts to it
            </p>
            <ul className="space-y-1">
              {result.trades
                .slice(-5)
                .reverse()
                .map((t) => {
                  const id = divergenceTradeId(t);
                  const selected = id === selectedTradeId;
                  return (
                  <li key={`${t.pivotDate}-${t.entryDate}`}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelectTrade?.(selected ? null : t)}
                    title="Jump the charts to this setup's entry and exit"
                    className={`flex w-full flex-wrap items-center gap-2 rounded-md border px-2 py-1 text-left text-xs transition-colors ${
                      selected
                        ? "border-primary/60 bg-primary/10"
                        : "border-transparent hover:border-border hover:bg-muted/50"
                    }`}
                  >
                    <Badge
                      variant="outline"
                      className={
                        t.outcome === "reversal"
                          ? "border-emerald-500/40 text-emerald-500"
                          : t.outcome === "failed"
                            ? "border-destructive/40 text-destructive"
                            : "text-muted-foreground"
                      }
                    >
                      {t.kind} · {t.outcome}
                    </Badge>
                    <span className="text-muted-foreground">
                      pivot {formatUkDate(t.pivotDate)} → entry {formatUkDate(t.entryDate)} @{" "}
                      {t.entryPrice.toFixed(2)} → {formatUkDate(t.exitDate)} · {t.bars} bars ·{" "}
                      <span className={t.netReturn >= 0 ? "text-emerald-500" : "text-destructive"}>
                        {pct(t.netReturn, 2)}
                      </span>
                    </span>
                  </button>
                  </li>
                  );
                })}
            </ul>
          </div>
        </>
      ) : null}

      <p className="text-[11px] text-muted-foreground">
        {divergenceBacktestVerdict(result)} Bullish divergences are taken long, bearish short, net
        of {frictionBps}bps per round trip. One window is not evidence of edge — past results do
        not predict future returns. Not financial advice.
      </p>
    </section>
  );
}
