// Stress-test and worst-case scenario engine for open FX legs.
//
// The playbook backtest answers "what did the rules do on realised tape".
// This module answers the harder question: "what happens to THIS position if
// the tape does something history only hints at" — instant rate shocks,
// overnight/weekend gap moves, and volatility spikes — plus the worst moves
// actually observed in ~20 years of daily closes, applied to today's rate.
//
// Pure module: the server function supplies the leg, the current rate and
// the historical bars; everything here is deterministic and testable.

import { netClosePnl } from "./fx-leg-quotes";

export type FxStressLeg = {
  /** Signed units of the pair's BASE currency (negative = short base). */
  quantity: number;
  /** Entry rate (quote per 1 base). */
  avgCost: number;
  /** Current market rate. */
  rate: number;
  /** quote ccy → portfolio base ccy multiplier. */
  quoteToBase: number;
};

export type FxStressScenario = {
  key: string;
  label: string;
  /** Rate move applied, as a fraction (+0.05 = +5%). */
  movePct: number;
  shockedRate: number;
  /** True when the move is against the position. */
  adverse: boolean;
  /** Net-of-exit-fee P&L in the pair's quote currency and portfolio base. */
  pnlQuoteNet: number;
  pnlBaseNet: number;
  /** P&L as % of portfolio NAV when a NAV was supplied, else null. */
  pnlPctOfNav: number | null;
  /** Where the move size came from. */
  basis: "fixed-shock" | "gap-sigma" | "vol-spike" | "historical-worst";
};

export type FxStressReport = {
  side: "short" | "long";
  currentRate: number;
  notionalQuote: number;
  /** Daily log-return stdev estimated from history (null if too few bars). */
  sigmaDaily: number | null;
  scenarios: FxStressScenario[];
  /** Worst single scenario loss in base ccy (most negative pnlBaseNet). */
  worstCaseBase: number;
  worstCaseLabel: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function logReturns(bars: Array<{ rate: number }>): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].rate;
    const b = bars[i].rate;
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

function stdev(xs: number[]): number | null {
  if (xs.length < 30) return null;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** Worst adverse move (fraction) over `window` bars, scanned across history. */
function worstAdverseMove(
  bars: Array<{ date: string; rate: number }>,
  window: number,
  side: "short" | "long",
): { movePct: number; from: string; to: string } | null {
  let worst: { movePct: number; from: string; to: string } | null = null;
  for (let i = 0; i + window < bars.length; i++) {
    const a = bars[i];
    const b = bars[i + window];
    if (!(a.rate > 0) || !(b.rate > 0)) continue;
    const raw = b.rate / a.rate - 1;
    // Short base loses when the rate rises; long base loses when it falls.
    const adverse = side === "short" ? raw : -raw;
    if (!worst || adverse > worst.movePct) worst = { movePct: adverse, from: a.date, to: b.date };
  }
  return worst;
}

/**
 * Build the full scenario table for one leg.
 *
 * - fixed-shock: instant ±1/2/5/10% re-rates
 * - gap-sigma: overnight gap of 3σ and 6σ in the adverse direction, σ from
 *   the daily log-return distribution (fat tails make this realistic — the
 *   2022 mini-budget GBP gap was ~5σ)
 * - vol-spike: adverse 5-day and 20-day drifts at 99% (2.33σ√t) with
 *   volatility doubled, modelling a regime break rather than a single print
 * - historical-worst: the worst observed 1/5/20-day adverse moves in the
 *   supplied history, replayed against today's rate
 */
export function stressFxLeg(
  leg: FxStressLeg,
  bars: Array<{ date: string; rate: number }>,
  opts?: { navBase?: number; exitCostBps?: number; minFeeQuote?: number },
): FxStressReport {
  const side: "short" | "long" = leg.quantity < 0 ? "short" : "long";
  const rate = leg.rate;
  const notionalQuote = Math.abs(leg.quantity) * rate;
  const q2b = Number.isFinite(leg.quoteToBase) && leg.quoteToBase > 0 ? leg.quoteToBase : 1;
  const nav = opts?.navBase && opts.navBase > 0 ? opts.navBase : null;
  const exitCostBps = opts?.exitCostBps ?? 3;
  const minFeeQuote = opts?.minFeeQuote ?? 1;

  const rets = logReturns(bars);
  const sigma = stdev(rets);

  const scenarios: FxStressScenario[] = [];
  const push = (key: string, label: string, movePct: number, basis: FxStressScenario["basis"]) => {
    const shockedRate = rate * (1 + movePct);
    const pnlQuote = leg.quantity * (shockedRate - leg.avgCost);
    const net = netClosePnl({
      pnlQuote,
      notionalQuote: Math.abs(leg.quantity) * shockedRate,
      exitCostBps,
      minFeeQuote,
    });
    const pnlBaseNet = round2(net.pnlQuoteNet * q2b);
    scenarios.push({
      key,
      label,
      movePct,
      shockedRate,
      adverse: side === "short" ? movePct > 0 : movePct < 0,
      pnlQuoteNet: net.pnlQuoteNet,
      pnlBaseNet,
      pnlPctOfNav: nav ? round2((pnlBaseNet / nav) * 100) : null,
      basis,
    });
  };

  for (const pct of [0.01, 0.02, 0.05, 0.1]) {
    push(`shock-up-${pct}`, `Instant shock ${(pct * 100).toFixed(0)}% up`, pct, "fixed-shock");
    push(`shock-dn-${pct}`, `Instant shock ${(pct * 100).toFixed(0)}% down`, -pct, "fixed-shock");
  }

  if (sigma != null) {
    const adverseSign = side === "short" ? 1 : -1;
    for (const k of [3, 6]) {
      const gap = adverseSign * k * sigma;
      push(
        `gap-${k}sigma`,
        `Overnight gap ${k}σ (${(Math.abs(gap) * 100).toFixed(1)}%) ${adverseSign > 0 ? "up" : "down"}`,
        gap,
        "gap-sigma",
      );
    }
    for (const [days, mult] of [[5, 2], [20, 2]] as const) {
      // 99% one-sided drift with volatility doubled vs the calm estimate.
      const drift = adverseSign * 2.33 * sigma * Math.sqrt(days) * mult;
      push(
        `vol-spike-${days}d`,
        `Vol spike 2× — ${days}d adverse drift (${(Math.abs(drift) * 100).toFixed(1)}%)`,
        drift,
        "vol-spike",
      );
    }
  }

  // "Worst in history" is only meaningful with a real sample of tape.
  for (const [days, name] of bars.length >= 60 ? ([[1, "1-day"], [5, "1-week"], [20, "1-month"]] as const) : []) {
    const w = worstAdverseMove(bars, days, side);
    if (!w) continue;
    const adverseSign = side === "short" ? 1 : -1;
    push(
      `hist-worst-${days}d`,
      `Worst ${name} in history (${(w.movePct * 100).toFixed(1)}%, ${w.from}→${w.to})`,
      adverseSign * w.movePct,
      "historical-worst",
    );
  }

  let worstCaseBase = 0;
  let worstCaseLabel = "none";
  for (const s of scenarios) {
    if (s.pnlBaseNet < worstCaseBase) {
      worstCaseBase = s.pnlBaseNet;
      worstCaseLabel = s.label;
    }
  }

  return {
    side,
    currentRate: rate,
    notionalQuote: round2(notionalQuote),
    sigmaDaily: sigma,
    scenarios,
    worstCaseBase,
    worstCaseLabel,
  };
}
