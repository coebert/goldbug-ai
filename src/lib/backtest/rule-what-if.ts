// "What if the displayed rules had run?" — a pure, deterministic replay of the
// buy / marketable-limit / stop / target / trailing-stop / max-hold rules shown
// on the rationale panel, applied to a recent window of daily bars for one
// instrument.
//
// This is intentionally NOT the full engine: there is no alpha model, no cost
// governor and no portfolio context. It answers one narrow question — over the
// last N sessions, if we had entered this instrument whenever we were flat and
// managed the position with exactly these levels at the current risk setting,
// how would the exits have landed?

import { planMarketableLimit } from "../marketable-limit";
import { stopDistancePct, targetDistancePct, type TradeLevelRiskConfig } from "../trade-levels";

export type WhatIfBar = {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
};

export type WhatIfExitReason = "stop" | "target" | "trailing" | "max_hold" | "open";

export type WhatIfTrade = {
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  reason: WhatIfExitReason;
  holdDays: number;
  /** Net return after the modelled entry and exit slack, as a fraction. */
  returnPct: number;
  stopPrice: number;
  targetPrice: number | null;
};

export type WhatIfSummary = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgReturnPct: number | null;
  medianReturnPct: number | null;
  bestPct: number | null;
  worstPct: number | null;
  avgHoldDays: number | null;
  /** Sum of per-trade returns, i.e. one unit staked per trade. */
  totalReturnPct: number;
  /** Average win / average loss, when both exist. */
  profitFactor: number | null;
  expectancyPct: number | null;
  exitMix: Record<WhatIfExitReason, number>;
  maxDrawdownPct: number;
};

export type WhatIfResult = {
  symbol: string;
  from: string;
  to: string;
  bars: number;
  /** Rule inputs actually used, so the card can show them next to the levels. */
  rules: {
    atrPct: number;
    atrSource: "measured" | "assumed";
    stopPct: number;
    stopBasis: string;
    targetPct: number | null;
    targetBasis: string | null;
    trailingPct: number | null;
    maxHoldDays: number | null;
    entrySlackBps: number;
    exitSlackBps: number;
  };
  trades: WhatIfTrade[];
  summary: WhatIfSummary;
  /** Cumulative return of the rule, one unit staked per trade, per exit. */
  equity: { date: string; cumPct: number }[];
  /** Buy-and-hold over the same window, for context. */
  buyHoldPct: number | null;
  notes: string[];
};

const FALLBACK_ATR_PCT = 0.02;

function fin(v: unknown): number | null {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) && x > 0 ? x : null;
}

function dayDiff(a: string, b: string): number {
  const t = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(t) ? Math.round(t / 86_400_000) : 0;
}

/** Wilder-style ATR over the window, expressed as a fraction of the last close. */
export function atrPctFromBars(bars: WhatIfBar[], period = 14): number | null {
  if (bars.length < 2) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const prev = bars[i - 1]!;
    const hi = fin(b.high) ?? b.close;
    const lo = fin(b.low) ?? b.close;
    trs.push(Math.max(hi - lo, Math.abs(hi - prev.close), Math.abs(lo - prev.close)));
  }
  const slice = trs.slice(-period);
  if (slice.length === 0) return null;
  const atr = slice.reduce((s, v) => s + v, 0) / slice.length;
  const last = bars[bars.length - 1]!.close;
  if (!(last > 0) || !(atr > 0)) return null;
  return atr / last;
}

export type WhatIfInput = {
  symbol: string;
  bars: WhatIfBar[];
  config: TradeLevelRiskConfig | null;
  currency?: string | null;
  assetClass?: string | null;
  /** Typical ticket size, so the modelled spread slack matches live sizing. */
  notional?: number | null;
  /** Cap on how long a position may run when the config sets no max hold. */
  defaultMaxHoldDays?: number;
};

/**
 * Replays the level rules bar by bar. One position at a time, long only,
 * re-entering on the next bar's close after each exit — the same shape as the
 * engine's "buy, protect, exit" loop with the alpha selection removed.
 */
export function runRuleWhatIf(input: WhatIfInput): WhatIfResult | null {
  const bars = input.bars
    .filter((b) => fin(b.close) != null)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length < 5) return null;

  const cfg = input.config ?? {};
  const notes: string[] = [];
  const measured = atrPctFromBars(bars);
  const atrPct = measured ?? FALLBACK_ATR_PCT;
  if (measured == null) {
    notes.push(`No usable high/low history, so the replay assumes ${(FALLBACK_ATR_PCT * 100).toFixed(1)}% ATR.`);
  }

  const stop = stopDistancePct(cfg, atrPct);
  const target = targetDistancePct(cfg, atrPct);
  const trailMult = Number(cfg.atr_trailing_mult);
  const trailingPct = Number.isFinite(trailMult) && trailMult > 0 ? trailMult * atrPct : null;
  const maxHoldRaw = Number(cfg.max_hold_days);
  const maxHold =
    Number.isFinite(maxHoldRaw) && maxHoldRaw > 0 ? Math.round(maxHoldRaw) : (input.defaultMaxHoldDays ?? 30);

  const ref = bars[bars.length - 1]!.close;
  const limitArgs = {
    referencePrice: ref,
    atrPct,
    ...(input.currency ? { currency: input.currency } : {}),
    ...(input.assetClass ? { assetClass: input.assetClass } : {}),
    ...(input.notional != null ? { notional: input.notional } : {}),
  };
  const buyLimit = planMarketableLimit({ side: "buy", ...limitArgs } as Parameters<typeof planMarketableLimit>[0]);
  const sellLimit = planMarketableLimit({ side: "sell", ...limitArgs } as Parameters<typeof planMarketableLimit>[0]);
  const entrySlackBps = buyLimit?.slackBps ?? 0;
  const exitSlackBps = sellLimit?.slackBps ?? 0;
  const entryMult = 1 + entrySlackBps / 10_000;
  const exitMult = 1 - exitSlackBps / 10_000;

  const trades: WhatIfTrade[] = [];
  let i = 0;
  while (i < bars.length - 1) {
    const entryBar = bars[i]!;
    const entryPrice = entryBar.close * entryMult;
    const stopPrice = entryPrice * (1 - stop.pct);
    const targetPrice = target ? entryPrice * (1 + target.pct) : null;
    let runHigh = entryPrice;
    let exited = false;

    for (let j = i + 1; j < bars.length; j++) {
      const b = bars[j]!;
      const hi = fin(b.high) ?? b.close;
      const lo = fin(b.low) ?? b.close;
      const trailStop = trailingPct != null ? runHigh * (1 - trailingPct) : null;
      // Conservative tie-break: when a bar spans both the stop and the target,
      // assume the adverse level filled first.
      const effStop = trailStop != null ? Math.max(stopPrice, trailStop) : stopPrice;
      let exitPrice: number | null = null;
      let reason: WhatIfExitReason | null = null;

      if (lo <= effStop) {
        exitPrice = Math.min(effStop, fin(b.open) ?? effStop);
        reason = trailStop != null && effStop === trailStop && trailStop > stopPrice ? "trailing" : "stop";
      } else if (targetPrice != null && hi >= targetPrice) {
        exitPrice = targetPrice;
        reason = "target";
      } else if (dayDiff(entryBar.date, b.date) >= maxHold) {
        exitPrice = b.close;
        reason = "max_hold";
      }

      if (exitPrice != null && reason) {
        const net = exitPrice * exitMult;
        trades.push({
          entryDate: entryBar.date,
          entryPrice,
          exitDate: b.date,
          exitPrice: net,
          reason,
          holdDays: dayDiff(entryBar.date, b.date),
          returnPct: net / entryPrice - 1,
          stopPrice,
          targetPrice,
        });
        i = j; // re-enter on the exit bar's close
        exited = true;
        break;
      }
      runHigh = Math.max(runHigh, hi);
    }

    if (!exited) {
      const last = bars[bars.length - 1]!;
      const net = last.close * exitMult;
      trades.push({
        entryDate: entryBar.date,
        entryPrice,
        exitDate: last.date,
        exitPrice: net,
        reason: "open",
        holdDays: dayDiff(entryBar.date, last.date),
        returnPct: net / entryPrice - 1,
        stopPrice,
        targetPrice,
      });
      break;
    }
  }

  const rets = trades.map((t) => t.returnPct);
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r <= 0);
  const sorted = rets.slice().sort((a, b) => a - b);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
  const avgWin = avg(wins);
  const avgLoss = avg(losses);

  const exitMix: Record<WhatIfExitReason, number> = {
    stop: 0,
    target: 0,
    trailing: 0,
    max_hold: 0,
    open: 0,
  };
  for (const t of trades) exitMix[t.reason] += 1;

  const equity: { date: string; cumPct: number }[] = [];
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of trades) {
    cum += t.returnPct;
    equity.push({ date: t.exitDate, cumPct: cum });
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }

  const first = bars[0]!.close;
  const last = bars[bars.length - 1]!.close;

  if (trades.some((t) => t.reason === "open")) {
    notes.push("The final position was still open at the end of the window and is marked to the last close.");
  }
  notes.push(
    "Entries are unfiltered — the replay buys whenever it is flat, so this measures the exit rules, not the AI's instrument selection.",
  );

  return {
    symbol: input.symbol,
    from: bars[0]!.date,
    to: bars[bars.length - 1]!.date,
    bars: bars.length,
    rules: {
      atrPct,
      atrSource: measured != null ? "measured" : "assumed",
      stopPct: stop.pct,
      stopBasis: stop.basis,
      targetPct: target?.pct ?? null,
      targetBasis: target?.basis ?? null,
      trailingPct,
      maxHoldDays: maxHold,
      entrySlackBps,
      exitSlackBps,
    },
    trades,
    summary: {
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length ? wins.length / trades.length : null,
      avgReturnPct: avg(rets),
      medianReturnPct: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : null,
      bestPct: sorted.length ? sorted[sorted.length - 1]! : null,
      worstPct: sorted.length ? sorted[0]! : null,
      avgHoldDays: trades.length ? trades.reduce((s, t) => s + t.holdDays, 0) / trades.length : null,
      totalReturnPct: cum,
      profitFactor:
        avgWin != null && avgLoss != null && avgLoss < 0
          ? (avgWin * wins.length) / Math.abs(avgLoss * losses.length)
          : null,
      expectancyPct: avg(rets),
      exitMix,
      maxDrawdownPct: maxDd,
    },
    equity,
    buyHoldPct: first > 0 ? last / first - 1 : null,
    notes,
  };
}
