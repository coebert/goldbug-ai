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
import { assessNetEdge } from "../net-edge-gate";
import { planViableSizeUp } from "../viable-size-up";
import {
  isDiversifiedFund,
  DEFAULT_MAX_DIVERSIFIED_POSITION_PCT_OF_NAV,
} from "../diversified-fund";
import {
  priceTicket,
  resolveAssumptions,
  DEFAULT_BACKTEST_PRESET,
  describeAssumptions,
  type ExecutionAssumptions,
  type ExecutionAssumptionsInput,
  type AssumptionPresetId,
} from "./execution-assumptions";

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
  /**
   * Candidate cadence. "cross" only proposes on a fresh SMA20/50 cross (a
   * calm tape where the friction budget rarely binds); "churn" proposes on
   * every bar the trend is up, reproducing the live July/August churn burst
   * that exhausted the 40bps window and then blocked buying for eleven days.
   */
  signal?: "cross" | "churn";
  /**
   * Friction (base ccy) already spent when the replay starts, as if the tape
   * opened the morning after a churn burst. This is the live 21 Aug 2026
   * state: £175 of modelled friction against a £41 window budget. Under the
   * legacy step-function accounting that blocks every buy until the whole
   * burst falls out of the window at once; under the decaying bucket the
   * headroom refills a little each day.
   */
  seedFrictionBase?: number;
  /**
   * Fee / spread / slippage assumptions. Either a preset id
   * ("optimistic" | "live" | "realistic" | "pessimistic" | "frictionless") or
   * a partial override of the live model. Both arms always share the same
   * assumptions, so a comparison never confounds cost policy with cost model.
   */
  assumptions?: ExecutionAssumptionsInput | AssumptionPresetId;
  /**
   * First bar the arm is allowed to trade on. Bars before it are used purely
   * to warm the moving averages, so a stress window can carry the 200-bar
   * history an SMA200 filter needs without the calm run-up polluting the
   * window's return, drawdown and friction.
   */
  tradeFromIndex?: number;
  /**
   * Measured round-trip cost floor (bps of notional) applied to every buy
   * through the net-of-cost edge gate, exactly as the live engine applies the
   * account's fill-measured cost. 0 / undefined = modelled friction only.
   */
  netEdgeFloorBps?: number;
  /** Safety multiple the expected move must clear the floor by (default 1.5). */
  edgeSafetyMultiple?: number;
  /** Set false to bypass the net-edge gate entirely. */
  netEdgeGate?: boolean;
  /**
   * Sizing policy.
   *   "legacy"  — the ticket is whatever weight-sizing produced; a notional
   *               under the fee-viable floor is simply thrown away by the
   *               governor's minimum-ticket rule, and every name (including
   *               broad index trackers) sits under the single-name cap.
   *   "revised" — an under-sized ticket is raised to the fee-viable floor when
   *               cash and the position cap allow, and broad diversified index
   *               funds sit under the wider diversified cap.
   */
  sizing?: "legacy" | "revised";
  /** Fee-viable notional floor in base currency for revised sizing (default 250). */
  viableFloorBase?: number;
  /** Cap on a single name as a fraction of NAV (default 0.15). */
  maxPositionPctOfNav?: number;
  /** Cap for broad diversified funds under revised sizing (default 0.35). */
  maxDiversifiedPositionPctOfNav?: number;
  /**
   * Symbols to treat as broad diversified index funds. Absent = classify with
   * the shared `isDiversifiedFund` rule on the symbol alone.
   */
  diversifiedSymbols?: string[];
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
  /** Sizing policy this arm ran under. */
  sizing: "legacy" | "revised";
  /** Tickets raised to the fee-viable floor (revised sizing only). */
  buysSizedUp: number;
  /** Tickets skipped because their notional never reached the viable floor. */
  buysBelowViableFloor: number;
  /** Blocked buys whose forward move would have covered their friction. */
  profitableBlocked: number;
  profitableBlockedPnl: number;
  fxLegsAttempted: number;
  fxLegsRejected: number;
  /** Longest run of days with candidates but zero admissions. */
  longestIdleStreakDays: number;
  /** Bars until the first admitted buy (null = never traded). */
  barsToFirstBuy: number | null;
  frictionPaid: number;
  /** Friction paid as bps of starting equity. */
  frictionBpsOfEquity: number;
  /** Fee / spread / slippage assumptions this arm was priced under. */
  assumptions: ExecutionAssumptions;
  assumptionsLabel: string;
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

/** Mean absolute daily return over the last n bars, as a fraction of price. */
function atrPct(values: number[], end: number, n = 14): number {
  let sum = 0;
  let k = 0;
  for (let i = Math.max(1, end - n + 1); i <= end; i += 1) {
    const a = values[i - 1];
    const b = values[i];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !a) continue;
    sum += Math.abs(b! - a!) / a!;
    k += 1;
  }
  return k > 0 ? sum / k : 0.015;
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
  const signalMode = opts.signal ?? "cross";
  const assumptions = resolveAssumptions(opts.assumptions, DEFAULT_BACKTEST_PRESET);
  const tradeFrom = Math.max(0, Math.floor(opts.tradeFromIndex ?? 0));
  const foreign = new Set((opts.foreignSymbols ?? []).map((s) => s.toUpperCase()));
  const gateOn = opts.netEdgeGate !== false;
  const floorBps = Math.max(0, opts.netEdgeFloorBps ?? 0);
  const safety = opts.edgeSafetyMultiple ?? 1.5;
  const sizing = opts.sizing ?? "legacy";
  const viableFloor = Math.max(0, opts.viableFloorBase ?? 250);
  const singleNameCapPct = opts.maxPositionPctOfNav ?? 0.15;
  const diversifiedCapPct = Math.max(
    singleNameCapPct,
    opts.maxDiversifiedPositionPctOfNav ?? DEFAULT_MAX_DIVERSIFIED_POSITION_PCT_OF_NAV,
  );
  const diversifiedList = opts.diversifiedSymbols
    ? new Set(opts.diversifiedSymbols.map((s) => s.toUpperCase()))
    : null;
  const isDiversified = (s: string) =>
    diversifiedList
      ? diversifiedList.has(s.toUpperCase())
      : isDiversifiedFund({ symbol: s });

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
  // Seeded friction is injected on the first bar that actually produces a
  // candidate, so the "morning after a churn burst" state is exercised rather
  // than decaying away during the SMA warm-up.
  const seed = Math.max(0, opts.seedFrictionBase ?? 0);
  let seedPending = seed > 0;
  const lastBuyIndex = new Map<string, number>();

  let buysProposed = 0;
  let buysAdmitted = 0;
  let buysBlocked = 0;
  let buysSizedUp = 0;
  let buysBelowViableFloor = 0;
  let fxLegsAttempted = 0;
  let fxLegsRejected = 0;
  let frictionPaid = 0;
  let idleStreak = 0;
  let longestIdleStreakDays = 0;
  let firstBuyIndex: number | null = null;
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

      const exitCosts = priceTicket(
        {
          symbol: pos.symbol,
          side: "sell",
          quantity: pos.qty,
          price: px,
          foreign: foreign.has(pos.symbol.toUpperCase()),
        },
        assumptions,
      );
      // Sells fill at the assumed execution price (spread/slippage/impact move
      // the print against us); the explicit fees are charged on top.
      const exitPrice = exitCosts.fillPrice;
      const explicitExitFees =
        exitCosts.commission + exitCosts.stampDuty + exitCosts.ptmLevy + exitCosts.fxSpread;
      const proceeds = pos.qty * exitPrice - explicitExitFees;
      cash += proceeds;
      frictionPaid += exitCosts.totalCost;
      costLedger.push({ index: i, cost: exitCosts.totalCost });
      const notional = pos.qty * pos.entryPrice;
      const gross = pos.qty * (px - pos.entryPrice);
      trades.push({
        symbol: pos.symbol,
        entryDate: pos.entryDate,
        exitDate: bar.date,
        notional,
        grossPnl: gross,
        cost: pos.costPaid + exitCosts.totalCost,
        netPnl: gross - pos.costPaid - exitCosts.totalCost,
      });
      positions.delete(pos.symbol);
    }

    // ---- mark to market --------------------------------------------------
    // (warm-up bars are silent: no candidates, no curve, no drawdown)
    let holdingsValue = 0;
    for (const pos of positions.values()) {
      const px = price(pos.symbol);
      holdingsValue += pos.qty * (Number.isFinite(px) ? px : pos.entryPrice);
    }
    const nav = cash + holdingsValue;
    if (i < tradeFrom) continue;
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
      const trendUp = fast > slow;
      if (!(signalMode === "churn" ? trendUp : crossedUp)) continue;
      if (long !== null && px < long) continue; // regime filter

      const notional = Math.min(nav * targetWeight, cash);
      if (!(notional > 0)) continue;
      let qty = Math.floor(notional / px);
      if (qty <= 0) continue;
      const diversified = isDiversified(s);
      if (sizing === "revised") {
        const up = planViableSizeUp({
          quantity: qty,
          price: px,
          minViableNotional: viableFloor,
          spendable: cash,
          maxNotional: nav * (diversified ? diversifiedCapPct : singleNameCapPct),
        });
        if (up.applied) {
          qty = up.quantity;
          buysSizedUp += 1;
        }
      }
      if (qty * px < viableFloor) buysBelowViableFloor += 1;
      let realNotional = qty * px;
      let costs = priceTicket(
        { symbol: s, side: "buy", quantity: qty, price: px, foreign: foreign.has(s.toUpperCase()) },
        assumptions,
      );
      const strength = slow > 0 ? Math.min(1, Math.max(0, (fast - slow) / slow) * 20) : 0;
      if (gateOn) {
        const gateInput = {
          symbol: s,
          side: "buy" as const,
          price: px,
          conviction: 0.55 + 0.4 * strength,
          atrPct: atrPct(closes, i),
          horizonDays: maxHold,
          safetyMultiple: safety,
          measuredRoundTripBps: floorBps > 0 ? floorBps : null,
        };
        let edge = assessNetEdge({ ...gateInput, quantity: qty });

        // Same rule the live engine uses: a gate failure that names a minimum
        // viable notional is a sizing problem, so buy up to it when cash and
        // the position cap allow, then re-price the round trip.
        if (!edge.pass && sizing === "revised" && Number.isFinite(edge.minViableNotional)) {
          const up = planViableSizeUp({
            quantity: qty,
            price: px,
            minViableNotional: edge.minViableNotional,
            spendable: cash,
            maxNotional: nav * (diversified ? diversifiedCapPct : singleNameCapPct),
          });
          if (up.applied) {
            const retry = assessNetEdge({ ...gateInput, quantity: up.quantity });
            if (retry.pass) {
              qty = up.quantity;
              buysSizedUp += 1;
              realNotional = qty * px;
              costs = priceTicket(
                {
                  symbol: s,
                  side: "buy",
                  quantity: qty,
                  price: px,
                  foreign: foreign.has(s.toUpperCase()),
                },
                assumptions,
              );
              edge = retry;
            }
          }
        }

        if (!edge.pass) {
          buysProposed += 1;
          buysBlocked += 1;
          const future = closes[Math.min(i + horizon, closes.length - 1)];
          blocked.push({
            date: bar.date,
            symbol: s,
            notional: realNotional,
            reason: `net-edge gate: ${edge.reason ?? "blocked"}`,
            forwardNetPnl: Number.isFinite(future)
              ? qty * (future! - px) - (costs.roundTripBps / 10_000) * realNotional
              : 0,
          });
          continue;
        }
      }
      candidates.push({
        symbol: s,
        side: "buy",
        notionalBase: realNotional,
        estCostBase: (costs.roundTripBps / 10_000) * realNotional,
        edgeScore: 0.55 + 0.4 * strength,
        expectedMovePct: 0.04,
        // Only the revised policy widens the cap for broad index trackers.
        diversifiedFund: sizing === "revised" ? diversified : false,
      });
      meta.set(s, { qty, price: px });
    }

    if (candidates.length === 0) {
      if (idleStreak > 0) longestIdleStreakDays = Math.max(longestIdleStreakDays, idleStreak);
      idleStreak = 0;
      continue;
    }

    if (seedPending) {
      costLedger.push({ index: i, cost: seed });
      seedPending = false;
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

    const investedBase = Object.values(positionExposureBase).reduce((s, v) => s + v, 0);

    const plan = planAdmissions(candidates, {
      navBase: nav,
      trailingCostBase: trailingCost,
      buysAlreadyToday: 0,
      // Only the revised arm lifts the daily cap while the book is idle, so
      // the replay measures that change rather than assuming it.
      investedFraction: sizing === "revised" && nav > 0 ? investedBase / nav : undefined,
      lastBuyDaysAgo,
      positionExposureBase,
      ...governorForNav(nav),
      maxPositionPctOfNav: singleNameCapPct,
      maxDiversifiedPositionPctOfNav: sizing === "revised" ? diversifiedCapPct : singleNameCapPct,
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

      const costs = priceTicket(
        {
          symbol: c.symbol,
          side: "buy",
          quantity: m.qty,
          price: m.price,
          foreign: foreign.has(c.symbol.toUpperCase()),
        },
        assumptions,
      );
      const entryPrice = costs.fillPrice;
      const explicitFees =
        costs.commission + costs.stampDuty + costs.ptmLevy + costs.fxSpread;
      const outlay = m.qty * entryPrice + explicitFees;
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
      frictionPaid += costs.totalCost;
      costLedger.push({ index: i, cost: costs.totalCost });
      lastBuyIndex.set(c.symbol, i);
      positions.set(c.symbol, {
        symbol: c.symbol,
        qty: m.qty,
        entryPrice: m.price,
        entryDate: bar.date,
        entryIndex: i,
        peak: m.price,
        costPaid: costs.totalCost,
      });
      buysAdmitted += 1;
      admittedToday += 1;
      if (firstBuyIndex === null) firstBuyIndex = i;
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
    sizing,
    buysSizedUp,
    buysBelowViableFloor,
    profitableBlocked: profitable.length,
    profitableBlockedPnl: profitable.reduce((a, b) => a + b.forwardNetPnl, 0),
    fxLegsAttempted,
    fxLegsRejected,
    longestIdleStreakDays,
    barsToFirstBuy: firstBuyIndex,
    frictionPaid,
    frictionBpsOfEquity: startingCash > 0 ? (frictionPaid / startingCash) * 10_000 : 0,
    assumptions,
    assumptionsLabel: describeAssumptions(assumptions),
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
      String(o.barsToFirstBuy ?? "never").padStart(7),
      `£${o.frictionPaid.toFixed(0)}`.padStart(9),
      `${o.frictionBpsOfEquity.toFixed(0)}bps`.padStart(8),
    ].join(" ");
  return [
    "arm         return  maxDD   admitted  blocked  profBlkd  missedPnL  fxRej/att  idle   1stBuy  friction   bps/eq",
    row(cmp.legacy),
    row(cmp.revised),
    `verdict: ${cmp.verdict}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Sizing comparison (plan stage D).
//
// Both arms run the REVISED governor (decaying friction bucket + reserve) and
// identical signals, cash and fills. The only difference is the sizing policy:
// whether an under-sized ticket is raised to the fee-viable floor and whether
// broad index trackers get the wider position cap. That isolates the effect of
// the sizing changes from the cost-governor changes already proven.
// ---------------------------------------------------------------------------

export type SizingComparison = {
  legacy: ArmOutcome;
  revised: ArmOutcome;
  verdict: "revised_sizing_better" | "no_material_difference" | "revised_sizing_worse";
};

export function compareSizingArms(
  bars: ReplayBar[],
  opts: ReplayOptions = {},
): SizingComparison {
  const legacy = runGovernorReplay(bars, "revised", { ...opts, sizing: "legacy" });
  const revised = runGovernorReplay(bars, "revised", { ...opts, sizing: "revised" });
  const delta = revised.totalReturnPct - legacy.totalReturnPct;
  const ddWorse = revised.maxDrawdownPct > legacy.maxDrawdownPct + 2;
  const verdict =
    delta > 0.25 && !ddWorse
      ? "revised_sizing_better"
      : delta < -0.25 || ddWorse
        ? "revised_sizing_worse"
        : "no_material_difference";
  return { legacy, revised, verdict };
}

export function sizingReplayReport(cmp: SizingComparison): string {
  const row = (o: ArmOutcome) =>
    [
      o.sizing.padEnd(8),
      `${o.totalReturnPct.toFixed(2)}%`.padStart(9),
      `${o.maxDrawdownPct.toFixed(2)}%`.padStart(9),
      String(o.buysAdmitted).padStart(8),
      String(o.buysBlocked).padStart(8),
      String(o.buysSizedUp).padStart(8),
      String(o.buysBelowViableFloor).padStart(9),
      String(o.trades.length).padStart(7),
      String(o.longestIdleStreakDays).padStart(6),
      `£${o.frictionPaid.toFixed(0)}`.padStart(9),
      `${o.frictionBpsOfEquity.toFixed(0)}bps`.padStart(8),
    ].join(" ");
  return [
    "sizing      return  maxDD   admitted  blocked  sizedUp  subFloor  trades  idle   friction   bps/eq",
    row(cmp.legacy),
    row(cmp.revised),
    `verdict: ${cmp.verdict}`,
  ].join("\n");
}
