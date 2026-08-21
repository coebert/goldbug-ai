// Governor + FX-leg replay.
//
// Purpose: prove — on real historical bars — that the *revised* cost governor
// (leaky-bucket friction budget + one high-edge reserve ticket) and the
// *revised* FX spot leg (amount floored to the pair's decimals, minimum-ticket
// check) actually let the engine place trades when they would have been
// profitable, and that the old behaviour did not.
//
// Two arms share identical signals, sizing and fills. The ONLY differences:
//
//   legacy   — friction budget is an unweighted sum of the trailing window
//              (a step function: a churn burst blocks everything until it
//              falls out of the window all at once), no high-edge reserve,
//              and the FX leg posts the raw float amount, which Saxo rejects
//              for "Number of decimals ... exceeds the configured value".
//   revised  — each past fill's cost decays linearly with age, one exceptional
//              ticket per day may draw on the reserve, and the FX amount is
//              floored to the pair's decimals and checked against its minimum.
//
// Pure and I/O-free: the caller supplies bars.

import { planAdmissions, governorForNav, type GovernorCandidate } from "../cost-governor";
import { estimateTradeCosts } from "../trade-viability-gate";

export type ReplayBar = { date: string; closes: Record<string, number> };

export type GovernorArm = "legacy" | "revised";

export type FxPairRule = {
  /** Decimals the broker accepts on the FROM-currency amount. */
  decimals: number;
  /** Minimum FROM-currency ticket. */
  minAmount: number;
};

export const DEFAULT_FX_RULE: FxPairRule = { decimals: 2, minAmount: 100 };

export type ReplayOptions = {
  startingCash?: number;
  /** Symbols quoted in a non-base currency, needing an FX spot leg to fund. */
  foreignSymbols?: string[];
  fxRule?: FxPairRule;
  /** Target weight of NAV per new position. */
  targetWeightPct?: number;
  /** Bars held before a position is force-exited if no signal exit fires. */
  maxHoldBars?: number;
  /** Trailing stop as a fraction of entry. */
  stopPct?: number;
  /** Forward horizon (bars) used to label a blocked buy as "would have paid". */
  edgeHorizonBars?: number;
};

export type ReplayTrade = {
  symbol: string;
  entryDate: string;
  exitDate: string;
  notional: number;
  grossPnl: number;
  cost: number;
  netPnl: number;
};

export type BlockedBuy = {
  date: string;
  symbol: string;
  notional: number;
  reason: string;
  /** Forward return over the edge horizon, net of modelled round-trip cost. */
  forwardNetPnl: number;
};

export type ArmOutcome = {
  arm: GovernorArm;
  finalEquity: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  buysProposed: number;
  buysAdmitted: number;
  buysBlocked: number;
  /** Blocked buys whose forward move would have covered their friction. */
  profitableBlocked: number;
  profitableBlockedPnl: number;
  fxLegsAttempted: number;
  fxLegsRejected: number;
  /** Longest run of days with candidates but zero admissions. */
  longestIdleStreakDays: number;
  frictionPaid: number;
  trades: ReplayTrade[];
  blocked: BlockedBuy[];
  equityCurve: Array<{ date: string; equity: number }>;
};

type Position = {
  symbol: string;
  qty: number;
  entryPrice: number;
  entryDate: string;
  entryIndex: number;
  peak: number;
  costPaid: number;
};

function sma(values: number[], end: number, n: number): number | null {
  if (end + 1 < n) return null;
  let s = 0;
  for (let i = end - n + 1; i <= end; i += 1) s += values[i]!;
  return s / n;
}

/** Simulate the FX funding leg for a foreign-currency buy. */
export function simulateFxLeg(
  amountFrom: number,
  rule: FxPairRule,
  arm: GovernorArm,
): { ok: boolean; amount: number; reason?: string } {
  if (!(amountFrom > 0)) return { ok: false, amount: 0, reason: "non-positive amount" };
  if (arm === "legacy") {
    // The raw sized float is posted verbatim. Saxo rejects anything with more
    // decimals than the pair allows — which a weight-sized notional almost
    // always has — and anything under the pair minimum.
    const decimals = decimalsOf(amountFrom);
    if (decimals > rule.decimals) {
      return {
        ok: false,
        amount: amountFrom,
        reason: "Number of decimals for fractional amount exceeds the configured value",
      };
    }
    if (amountFrom < rule.minAmount) {
      return { ok: false, amount: amountFrom, reason: "below minimum trade amount" };
    }
    return { ok: true, amount: amountFrom };
  }
  const factor = 10 ** rule.decimals;
  const amount = Math.floor(amountFrom * factor + 1e-9) / factor;
  if (!(amount > 0)) return { ok: false, amount, reason: "rounds to zero" };
  if (amount < rule.minAmount) {
    return { ok: false, amount, reason: `below the ${rule.minAmount} minimum ticket` };
  }
  return { ok: true, amount };
}

function decimalsOf(n: number): number {
  const s = String(n);
  const i = s.indexOf(".");
  if (i < 0) return 0;
  // Ignore float noise beyond 10dp.
  return Math.min(10, s.length - i - 1);
}

/**
 * Replay one arm over the tape. Signals are a deterministic SMA20/50 trend
 * cross (the variant the SMA backtest found actually drives return), so the
 * two arms differ only in their cost-admission and FX behaviour.
 */
export function runGovernorReplay(
  bars: ReplayBar[],
  arm: GovernorArm,
  opts: ReplayOptions = {},
): ArmOutcome {
  const startingCash = opts.startingCash ?? 10_300;
  const targetWeight = opts.targetWeightPct ?? 0.12;
  const maxHold = opts.maxHoldBars ?? 40;
  const stopPct = opts.stopPct ?? 0.08;
  const horizon = opts.edgeHorizonBars ?? 20;
  const fxRule = opts.fxRule ?? DEFAULT_FX_RULE;
  const foreign = new Set((opts.foreignSymbols ?? []).map((s) => s.toUpperCase()));

  const symbols = Array.from(
    new Set(bars.flatMap((b) => Object.keys(b.closes))),
  ).sort();
  const series = new Map<string, number[]>();
  for (const s of symbols) series.set(s, bars.map((b) => b.closes[s] ?? NaN));

  let cash = startingCash;
  const positions = new Map<string, Position>();
  const trades: ReplayTrade[] = [];
  const blocked: BlockedBuy[] = [];
  const equityCurve: Array<{ date: string; equity: number }> = [];
  // Cost ledger: fills as { index, cost } so the arms can account differently.
  const costLedger: Array<{ index: number; cost: number }> = [];
  const lastBuyIndex = new Map<string, number>();

  let buysProposed = 0;
  let buysAdmitted = 0;
  let buysBlocked = 0;
  let fxLegsAttempted = 0;
  let fxLegsRejected = 0;
  let frictionPaid = 0;
  let idleStreak = 0;
  let longestIdleStreakDays = 0;
  let peakEquity = startingCash;
  let maxDrawdownPct = 0;

  const windowDays = 30;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    const price = (s: string) => series.get(s)?.[i] ?? NaN;

    // ---- exits first (never gated) --------------------------------------
    for (const pos of Array.from(positions.values())) {
      const px = price(pos.symbol);
      if (!Number.isFinite(px)) continue;
      pos.peak = Math.max(pos.peak, px);
      const closes = series.get(pos.symbol)!;
      const fast = sma(closes, i, 20);
      const slow = sma(closes, i, 50);
      const stopped = px <= pos.peak * (1 - stopPct);
      const trendOut = fast !== null && slow !== null && fast < slow;
      const aged = i - pos.entryIndex >= maxHold;
      const last = i === bars.length - 1;
      if (!(stopped || trendOut || aged || last)) continue;

      const exitCosts = estimateTradeCosts({
        symbol: pos.symbol,
        side: "sell",
        quantity: pos.qty,
        price: px,
      });
      const proceeds = pos.qty * px - exitCosts.oneWayCost;
      cash += proceeds;
      frictionPaid += exitCosts.oneWayCost;
      costLedger.push({ index: i, cost: exitCosts.oneWayCost });
      const notional = pos.qty * pos.entryPrice;
      const gross = pos.qty * (px - pos.entryPrice);
      trades.push({
        symbol: pos.symbol,
        entryDate: pos.entryDate,
        exitDate: bar.date,
        notional,
        grossPnl: gross,
        cost: pos.costPaid + exitCosts.oneWayCost,
        netPnl: gross - pos.costPaid - exitCosts.oneWayCost,
      });
      positions.delete(pos.symbol);
    }

    // ---- mark to market --------------------------------------------------
    let holdingsValue = 0;
    for (const pos of positions.values()) {
      const px = price(pos.symbol);
      holdingsValue += pos.qty * (Number.isFinite(px) ? px : pos.entryPrice);
    }
    const nav = cash + holdingsValue;
    equityCurve.push({ date: bar.date, equity: nav });
    peakEquity = Math.max(peakEquity, nav);
    if (peakEquity > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct, (peakEquity - nav) / peakEquity);
    }

    // ---- candidate generation -------------------------------------------
    const candidates: GovernorCandidate[] = [];
    const meta = new Map<string, { qty: number; price: number }>();
    for (const s of symbols) {
      if (positions.has(s)) continue;
      const closes = series.get(s)!;
      const px = closes[i]!;
      if (!Number.isFinite(px) || px <= 0) continue;
      const fast = sma(closes, i, 20);
      const slow = sma(closes, i, 50);
      const prevFast = sma(closes, i - 1, 20);
      const prevSlow = sma(closes, i - 1, 50);
      const long = sma(closes, i, 200);
      if (fast === null || slow === null || prevFast === null || prevSlow === null) continue;
      const crossedUp = prevFast <= prevSlow && fast > slow;
      if (!crossedUp) continue;
      if (long !== null && px < long) continue; // regime filter

      const notional = Math.min(nav * targetWeight, cash);
      if (!(notional > 0)) continue;
      const qty = Math.floor(notional / px);
      if (qty <= 0) continue;
      const realNotional = qty * px;
      const costs = estimateTradeCosts({ symbol: s, side: "buy", quantity: qty, price: px });
      const strength = slow > 0 ? Math.min(1, Math.max(0, (fast - slow) / slow) * 20) : 0;
      candidates.push({
        symbol: s,
        side: "buy",
        notionalBase: realNotional,
        estCostBase: costs.oneWayCost + costs.exitCost,
        edgeScore: 0.55 + 0.4 * strength,
        expectedMovePct: 0.04,
      });
      meta.set(s, { qty, price: px });
    }

    if (candidates.length === 0) {
      if (idleStreak > 0) longestIdleStreakDays = Math.max(longestIdleStreakDays, idleStreak);
      idleStreak = 0;
      continue;
    }

    // ---- trailing friction, accounted per arm ----------------------------
    let trailingCost = 0;
    for (const f of costLedger) {
      const ageDays = i - f.index;
      if (ageDays >= windowDays) continue;
      trailingCost += arm === "revised" ? f.cost * (1 - ageDays / windowDays) : f.cost;
    }

    const lastBuyDaysAgo: Record<string, number> = {};
    for (const [s, idx] of lastBuyIndex) lastBuyDaysAgo[s] = i - idx;

    const positionExposureBase: Record<string, number> = {};
    for (const pos of positions.values()) {
      const px = price(pos.symbol);
      positionExposureBase[pos.symbol] = pos.qty * (Number.isFinite(px) ? px : pos.entryPrice);
    }

    const plan = planAdmissions(candidates, {
      navBase: nav,
      trailingCostBase: trailingCost,
      buysAlreadyToday: 0,
      lastBuyDaysAgo,
      positionExposureBase,
      ...governorForNav(nav),
      highEdgeReserveTickets: arm === "revised" ? 1 : 0,
    });

    buysProposed += candidates.length;
    let admittedToday = 0;

    for (const d of plan.decisions) {
      const c = d.candidate;
      if (c.side !== "buy") continue;
      const m = meta.get(c.symbol);
      if (!m) continue;

      const forwardNetPnl = (() => {
        const closes = series.get(c.symbol)!;
        const future = closes[Math.min(i + horizon, closes.length - 1)];
        if (!Number.isFinite(future)) return 0;
        return m.qty * (future! - m.price) - c.estCostBase;
      })();

      if (d.kind === "skip") {
        buysBlocked += 1;
        blocked.push({
          date: bar.date,
          symbol: c.symbol,
          notional: c.notionalBase,
          reason: d.reason,
          forwardNetPnl,
        });
        continue;
      }

      // ---- FX funding leg for foreign-currency buys ----------------------
      if (foreign.has(c.symbol.toUpperCase())) {
        fxLegsAttempted += 1;
        const leg = simulateFxLeg(c.notionalBase, fxRule, arm);
        if (!leg.ok) {
          fxLegsRejected += 1;
          buysBlocked += 1;
          blocked.push({
            date: bar.date,
            symbol: c.symbol,
            notional: c.notionalBase,
            reason: `fx spot failed: ${leg.reason}`,
            forwardNetPnl,
          });
          continue;
        }
      }

      const costs = estimateTradeCosts({
        symbol: c.symbol,
        side: "buy",
        quantity: m.qty,
        price: m.price,
      });
      const outlay = m.qty * m.price + costs.oneWayCost;
      if (outlay > cash) {
        buysBlocked += 1;
        blocked.push({
          date: bar.date,
          symbol: c.symbol,
          notional: c.notionalBase,
          reason: "insufficient cash",
          forwardNetPnl,
        });
        continue;
      }
      cash -= outlay;
      frictionPaid += costs.oneWayCost;
      costLedger.push({ index: i, cost: costs.oneWayCost });
      lastBuyIndex.set(c.symbol, i);
      positions.set(c.symbol, {
        symbol: c.symbol,
        qty: m.qty,
        entryPrice: m.price,
        entryDate: bar.date,
        entryIndex: i,
        peak: m.price,
        costPaid: costs.oneWayCost,
      });
      buysAdmitted += 1;
      admittedToday += 1;
    }

    if (admittedToday === 0) {
      idleStreak += 1;
      longestIdleStreakDays = Math.max(longestIdleStreakDays, idleStreak);
    } else {
      idleStreak = 0;
    }
  }

  const finalEquity = equityCurve.at(-1)?.equity ?? startingCash;
  const profitable = blocked.filter((b) => b.forwardNetPnl > 0);

  return {
    arm,
    finalEquity,
    totalReturnPct: (finalEquity / startingCash - 1) * 100,
    maxDrawdownPct: maxDrawdownPct * 100,
    buysProposed,
    buysAdmitted,
    buysBlocked,
    profitableBlocked: profitable.length,
    profitableBlockedPnl: profitable.reduce((a, b) => a + b.forwardNetPnl, 0),
    fxLegsAttempted,
    fxLegsRejected,
    longestIdleStreakDays,
    frictionPaid,
    trades,
    blocked,
    equityCurve,
  };
}

export type GovernorReplayComparison = {
  legacy: ArmOutcome;
  revised: ArmOutcome;
  verdict: "revised_unblocks_profitable_trades" | "no_material_difference" | "revised_worse";
};

export function compareGovernorArms(
  bars: ReplayBar[],
  opts: ReplayOptions = {},
): GovernorReplayComparison {
  const legacy = runGovernorReplay(bars, "legacy", opts);
  const revised = runGovernorReplay(bars, "revised", opts);
  const moreFills = revised.buysAdmitted > legacy.buysAdmitted;
  const better = revised.totalReturnPct >= legacy.totalReturnPct - 0.25;
  const verdict = moreFills && better
    ? "revised_unblocks_profitable_trades"
    : revised.totalReturnPct < legacy.totalReturnPct - 0.25
      ? "revised_worse"
      : "no_material_difference";
  return { legacy, revised, verdict };
}

export function governorReplayReport(cmp: GovernorReplayComparison): string {
  const row = (o: ArmOutcome) =>
    [
      o.arm.padEnd(8),
      `${o.totalReturnPct.toFixed(2)}%`.padStart(9),
      `${o.maxDrawdownPct.toFixed(2)}%`.padStart(9),
      String(o.buysAdmitted).padStart(8),
      String(o.buysBlocked).padStart(8),
      String(o.profitableBlocked).padStart(10),
      `£${o.profitableBlockedPnl.toFixed(0)}`.padStart(11),
      `${o.fxLegsRejected}/${o.fxLegsAttempted}`.padStart(9),
      String(o.longestIdleStreakDays).padStart(6),
      `£${o.frictionPaid.toFixed(0)}`.padStart(9),
    ].join(" ");
  return [
    "arm         return  maxDD   admitted  blocked  profBlkd  missedPnL  fxRej/att  idle  friction",
    row(cmp.legacy),
    row(cmp.revised),
    `verdict: ${cmp.verdict}`,
  ].join("\n");
}
