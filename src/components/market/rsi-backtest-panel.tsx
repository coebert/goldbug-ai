// Quick RSI strategy backtest panel shown under the symbol chart.
//
// It replays the same buy/sell markers drawn on the chart over the visible
// window so what you see and what you measure cannot drift apart.

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_RSI_BACKTEST_FRICTION_BPS,
  backtestRsiStrategy,
} from "@/lib/rsi-backtest";
import { RSI_SIGNAL_MODE_LABEL, type RsiSignalMode } from "@/lib/rsi-signals";
import type { HistoryPoint } from "@/lib/market-symbol-history";
import { formatUkDate } from "@/lib/uk-time";

const FRICTION_CHOICES = [0, 20, 40, 80];

function pct(v: number, digits = 1) {
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
  hint?: string;
}) {
  return (
    <div className="rounded-md border border-border/60 p-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p
        className={`text-sm font-semibold tabular-nums ${
          tone === "positive"
            ? "text-emerald-500"
            : tone === "negative"
              ? "text-destructive"
              : ""
        }`}
      >
        {value}
      </p>
      {hint ? <p className="text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function RsiBacktestPanel({
  points,
  mode,
  rangeLabel,
  onTrades,
}: {
  points: HistoryPoint[];
  mode: RsiSignalMode;
  rangeLabel?: string;
  /** Reports the executed trades so the charts above can mark them. */
  onTrades?: (trades: RsiTrade[]) => void;
}) {
  const [frictionBps, setFrictionBps] = useState(DEFAULT_RSI_BACKTEST_FRICTION_BPS);
  const result = useMemo(
    () => backtestRsiStrategy(points, mode, { frictionBps }),
    [points, mode, frictionBps],
  );

  useEffect(() => {
    onTrades?.(result.trades);
  }, [result.trades, onTrades]);

  useEffect(() => () => onTrades?.([]), [onTrades]);


  const beatsHold = result.totalReturn > result.buyHoldReturn;

  return (
    <section className="space-y-3 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-medium">
            RSI strategy backtest · {RSI_SIGNAL_MODE_LABEL[mode]} logic
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Long-only, one position at a time, over {result.bars} bars
            {rangeLabel ? ` (${rangeLabel})` : ""}.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-muted-foreground">Round-trip cost</span>
          {FRICTION_CHOICES.map((bps) => (
            <Button
              key={bps}
              size="sm"
              variant={bps === frictionBps ? "secondary" : "ghost"}
              className="h-6 px-2 text-[11px]"
              aria-pressed={bps === frictionBps}
              onClick={() => setFrictionBps(bps)}
            >
              {bps}bps
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Net return"
          value={pct(result.totalReturn)}
          tone={result.totalReturn >= 0 ? "positive" : "negative"}
        />
        <Stat
          label="Buy & hold"
          value={pct(result.buyHoldReturn)}
          tone={result.buyHoldReturn >= 0 ? "positive" : "negative"}
        />
        <Stat label="Win rate" value={`${(result.winRate * 100).toFixed(0)}%`} hint={`${result.trades.length} trades`} />
        <Stat
          label="Max drawdown"
          value={`-${(result.maxDrawdown * 100).toFixed(1)}%`}
          tone={result.maxDrawdown > 0 ? "negative" : undefined}
        />
        <Stat label="Avg per trade" value={pct(result.avgReturn, 2)} />
        <Stat label="Time in market" value={`${(result.exposure * 100).toFixed(0)}%`} />
      </div>

      {result.trades.length ? (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">Recent trades</p>
          <ul className="space-y-1">
            {result.trades
              .slice(-5)
              .reverse()
              .map((t) => (
                <li key={`${t.entryDate}-${t.exitDate}`} className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge
                    variant="outline"
                    className={
                      t.netReturn >= 0
                        ? "border-emerald-500/40 text-emerald-500"
                        : "border-destructive/40 text-destructive"
                    }
                  >
                    {pct(t.netReturn)}
                  </Badge>
                  <span className="text-muted-foreground">
                    {formatUkDate(t.entryDate)} → {formatUkDate(t.exitDate)} · {t.bars} bars
                    {t.open ? " · still open at window end" : ""}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No completed RSI trades in this window — widen the timespan or switch logic.
        </p>
      )}

      <p className="text-[11px] text-muted-foreground">
        {beatsHold
          ? "Strategy beat buy & hold on this window"
          : "Buy & hold beat the strategy on this window"}
        , net of {frictionBps}bps per round trip. A single window is not evidence of edge —
        past results do not predict future returns. Not financial advice.
      </p>
    </section>
  );
}
