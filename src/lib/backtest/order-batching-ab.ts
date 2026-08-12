// Order-batching A/B backtest.
//
// The batching window (`order-batching.ts`) exists on a theory: parking a
// sub-minimum buy and releasing it later as one larger ticket pays the Saxo
// commission floor once instead of N times, so it should cut friction without
// making the book riskier. That theory has never been measured.
//
// This module replays the SAME signal stream over the SAME historical bars
// twice, changing exactly one thing:
//
//   arm "unbatched" — the pre-batching behaviour: any buy below the NAV-scaled
//                     minimum ticket is skipped outright, the signal is lost.
//   arm "batched"   — sub-minimum buys are parked in the window and released
//                     once the accumulated notional clears the floor.
//
// Everything else (bars, signals, sizing, fee model, sell logic, no-borrow
// invariants) is byte-identical between arms, so any difference in cost or
// drawdown is attributable to batching alone.
//
// The delay is the honest part of the test: a batched buy enters LATER and at
// a DIFFERENT price than the unbatched arm would have, so the arm can lose on
// entry quality even while it wins on commission. That trade-off is exactly
// what the verdict below scores — cost saving is only "supported" if the
// drawdown does not deteriorate.
//
// Pure and deterministic: no I/O, no clock, no randomness.

import { runBacktest, type BacktestBar } from "../backtest-runner";
import type { SimDecision, SimState } from "../broker-simulator";
import { computeMaxDrawdown, computeSharpe, dailyReturns } from "../backtest-metrics";
import { estimateTradeCosts } from "../trade-viability-gate";
import {
  planBatchWindow,
  DEFAULT_BATCH_WINDOW,
  type BatchableOrder,
  type ParkedIntent,
} from "../order-batching";
import { engineSymbolKey } from "../price-symbol";

/** One sized intent produced by the strategy for a given bar. */
export type BatchingSignal = {
  /** ISO date (YYYY-MM-DD) — must match a bar in the series. */
  date: string;
  symbol: string;
  side: "buy" | "sell";
  /** Intended ticket size in base currency at that bar's close. */
  notionalBase: number;
  conviction?: number | null;
  assetClass?: string | null;
};

export type BatchingAbArm = "batched" | "unbatched";

export type BatchingArmTrade = {
  date: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  notional: number;
  cost: number;
  /** Quantity that came from previously parked slices (batched arm only). */
  parkedQuantity: number;
  waitedHours: number;
};

export type BatchingArmResult = {
  arm: BatchingAbArm;
  /** Tickets actually routed (this is what pays the commission floor). */
  tickets: number;
  trades: BatchingArmTrade[];
  /** Total modelled execution cost (commission + stamp + PTM + half-spread). */
  totalCostBase: number;
  /** Cost as bps of the notional actually traded. */
  costBpsOfTurnover: number;
  /** Cost as bps of starting equity — the number that shows up in the P&L. */
  costBpsOfEquity: number;
  turnoverBase: number;
  /** Buy signals thrown away because they never cleared the floor. */
  signalsSkipped: number;
  /** Parked slices that expired or drifted away unfilled (batched arm only). */
  parkedLost: number;
  startingValue: number;
  finalValue: number;
  returnPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  equityCurve: Array<{ date: string; totalValue: number }>;
};

export type BatchingAbVerdict =
  | "supported"
  | "not_supported"
  | "costly_risk"
  | "inconclusive";

export type OrderBatchingAbResult = {
  batched: BatchingArmResult;
  unbatched: BatchingArmResult;
  /** Positive = batching is cheaper, in bps of starting equity. */
  costSavingBps: number;
  /** Positive = batching drew down MORE (worse). Percentage points. */
  drawdownDeltaPct: number;
  /** Positive = batching returned more. Percentage points. */
  returnDeltaPct: number;
  ticketsSaved: number;
  verdict: BatchingAbVerdict;
  summary: string;
  bars: number;
  signals: number;
  minTicketBase: number;
};

export type OrderBatchingAbInput = {
  bars: BacktestBar[];
  signals: BatchingSignal[];
  startingCash: number;
  /** NAV-scaled minimum economic ticket, base currency. */
  minTicketBase: number;
  windowHours?: number;
  maxPriceDriftPct?: number;
  /** Drawdown deterioration (pp) still counted as "no worse". */
  drawdownTolerancePct?: number;
  /** Cost saving (bps of equity) below which the result is noise. */
  costSavingFloorBps?: number;
};

export const DEFAULT_DRAWDOWN_TOLERANCE_PCT = 0.5;
export const DEFAULT_COST_SAVING_FLOOR_BPS = 2;

type PendingOrder = BatchableOrder & {
  notionalBase: number;
  assetClass: string | null;
};

function costOf(o: {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  assetClass?: string | null;
}): number {
  const c = estimateTradeCosts({
    symbol: o.symbol,
    side: o.side,
    quantity: o.quantity,
    price: o.price,
    assetClass: o.assetClass ?? null,
  });
  return Number.isFinite(c.oneWayCost) ? c.oneWayCost : 0;
}

function heldQuantity(state: SimState, symbol: string): number {
  const key = engineSymbolKey(symbol);
  let q = 0;
  for (const h of state.holdings) {
    if (engineSymbolKey(h.symbol) === key) q += Number(h.quantity) || 0;
  }
  return q;
}

async function runArm(
  arm: BatchingAbArm,
  input: OrderBatchingAbInput,
): Promise<BatchingArmResult> {
  const minTicket = Math.max(0, Number(input.minTicketBase) || 0);
  const windowHours = input.windowHours ?? DEFAULT_BATCH_WINDOW.windowHours;
  const maxPriceDriftPct = input.maxPriceDriftPct ?? DEFAULT_BATCH_WINDOW.maxPriceDriftPct;

  const byDate = new Map<string, BatchingSignal[]>();
  for (const s of input.signals) {
    if (!(Number(s.notionalBase) > 0)) continue;
    (byDate.get(s.date) ?? byDate.set(s.date, []).get(s.date)!).push(s);
  }

  const trades: BatchingArmTrade[] = [];
  let signalsSkipped = 0;
  let parkedLost = 0;
  // Parked window state carried across bars. Ids are synthetic and stable so
  // the planner's consume/drop bookkeeping behaves exactly as it does live.
  let parked: ParkedIntent[] = [];
  let parkSeq = 0;

  const strategy = async (ctx: {
    date: string;
    state: SimState;
    closes: Record<string, number>;
  }): Promise<SimDecision[]> => {
    const todays = byDate.get(ctx.date) ?? [];
    // A bar with no signals still ages the window: parked slices expire.
    const incoming: PendingOrder[] = [];
    for (const s of todays) {
      const price = Number(ctx.closes[s.symbol]);
      if (!Number.isFinite(price) || price <= 0) continue;
      if (s.side === "sell") {
        const held = heldQuantity(ctx.state, s.symbol);
        const qty = Math.min(held, Math.floor(Number(s.notionalBase) / price));
        if (qty <= 0) continue;
        incoming.push({
          symbol: s.symbol,
          side: "sell",
          quantity: qty,
          price,
          notionalBase: qty * price,
          conviction: s.conviction ?? null,
          assetClass: s.assetClass ?? null,
        });
        continue;
      }
      const qty = Math.floor(Number(s.notionalBase) / price);
      if (qty <= 0) continue;
      incoming.push({
        symbol: s.symbol,
        side: "buy",
        quantity: qty,
        price,
        notionalBase: qty * price,
        conviction: s.conviction ?? null,
        assetClass: s.assetClass ?? null,
      });
    }

    const routed: Array<{ order: PendingOrder; parkedQuantity: number; waitedHours: number }> = [];

    if (arm === "unbatched") {
      for (const o of incoming) {
        if (o.side === "buy" && o.notionalBase < minTicket) {
          signalsSkipped += 1;
          continue;
        }
        routed.push({ order: o, parkedQuantity: 0, waitedHours: 0 });
      }
    } else {
      const now = new Date(`${ctx.date}T12:00:00.000Z`);
      const plan = planBatchWindow<PendingOrder>({
        incoming,
        parked,
        minTicketBase: minTicket,
        now,
        config: { windowHours, maxPriceDriftPct },
      });
      parkedLost += plan.drop.length;
      for (const r of plan.release) {
        routed.push({
          order: r.order,
          parkedQuantity: r.parkedQuantity,
          waitedHours: r.waitedHours,
        });
      }
      const consumed = new Set(plan.consumedIds);
      const droppedIds = new Set(plan.drop.map((d) => d.id).filter(Boolean) as string[]);
      const reparkedIds = new Set(plan.park.map((p) => p.id).filter(Boolean) as string[]);
      const survivors = parked.filter(
        (p) =>
          p.id != null &&
          !consumed.has(p.id) &&
          !droppedIds.has(p.id) &&
          !reparkedIds.has(p.id),
      );
      parked = [
        ...survivors,
        ...plan.park.map((p) => ({
          id: p.id ?? `park-${parkSeq++}`,
          symbol: p.symbol,
          quantity: p.quantity,
          price: p.price,
          notionalBase: p.notionalBase,
          conviction: p.conviction,
          firstSeenAt: p.firstSeenAt,
        })),
      ];
    }

    const decisions: SimDecision[] = [];
    for (const r of routed) {
      const o = r.order;
      const side = o.side === "sell" ? "sell" : "buy";
      const cost = costOf({
        symbol: o.symbol,
        side,
        quantity: o.quantity,
        price: o.price,
        assetClass: o.assetClass,
      });
      trades.push({
        date: ctx.date,
        symbol: o.symbol,
        side,
        quantity: o.quantity,
        price: o.price,
        notional: o.quantity * o.price,
        cost,
        parkedQuantity: r.parkedQuantity,
        waitedHours: r.waitedHours,
      });
      decisions.push({
        symbol: o.symbol,
        side: side === "sell" ? "SELL" : "BUY",
        quantity: o.quantity,
        price: o.price,
        fee: cost,
      });
    }
    return decisions;
  };

  const initial: SimState = { cash: Math.max(0, Number(input.startingCash) || 0), holdings: [] };
  const result = await runBacktest(initial, input.bars, strategy as never);

  // Trades the simulator refused (no cash, no position) never happened: drop
  // them from the ledger so cost is not credited to a fill that didn't occur.
  const rejectedKeys = new Set(
    result.rejections.map((r) => `${r.date}|${engineSymbolKey(r.symbol)}|${r.side.toLowerCase()}`),
  );
  const filled = trades.filter(
    (t) => !rejectedKeys.has(`${t.date}|${engineSymbolKey(t.symbol)}|${t.side}`),
  );

  const totalCostBase = filled.reduce((a, t) => a + t.cost, 0);
  const turnoverBase = filled.reduce((a, t) => a + t.notional, 0);
  const startingValue = initial.cash;
  const finalValue = result.equityCurve.at(-1)?.totalValue ?? startingValue;
  const points = result.equityCurve.map((p) => ({
    snapshot_date: p.date,
    total_value: p.totalValue,
  }));
  const dd = computeMaxDrawdown(points);
  // Parked slices still open at the end of the window never traded.
  const stillParked = arm === "batched" ? parked.length : 0;

  return {
    arm,
    tickets: filled.length,
    trades: filled,
    totalCostBase,
    costBpsOfTurnover: turnoverBase > 0 ? (totalCostBase / turnoverBase) * 10_000 : 0,
    costBpsOfEquity: startingValue > 0 ? (totalCostBase / startingValue) * 10_000 : 0,
    turnoverBase,
    signalsSkipped,
    parkedLost: parkedLost + stillParked,
    startingValue,
    finalValue,
    returnPct: startingValue > 0 ? ((finalValue - startingValue) / startingValue) * 100 : 0,
    maxDrawdownPct: dd.maxDrawdownPct,
    sharpe: computeSharpe(dailyReturns(points)),
    equityCurve: result.equityCurve.map((p) => ({ date: p.date, totalValue: p.totalValue })),
  };
}

function fmt(n: number, digits = 1): string {
  return n.toFixed(digits);
}

/**
 * Replay the same signals with batching on and off and score the difference.
 */
export async function runOrderBatchingAb(
  input: OrderBatchingAbInput,
): Promise<OrderBatchingAbResult> {
  const [batched, unbatched] = await Promise.all([
    runArm("batched", input),
    runArm("unbatched", input),
  ]);

  const costSavingBps = unbatched.costBpsOfEquity - batched.costBpsOfEquity;
  const drawdownDeltaPct = batched.maxDrawdownPct - unbatched.maxDrawdownPct;
  const returnDeltaPct = batched.returnPct - unbatched.returnPct;
  const ticketsSaved = unbatched.tickets - batched.tickets;

  const tolerance = input.drawdownTolerancePct ?? DEFAULT_DRAWDOWN_TOLERANCE_PCT;
  const floor = input.costSavingFloorBps ?? DEFAULT_COST_SAVING_FLOOR_BPS;

  let verdict: BatchingAbVerdict;
  if (batched.tickets === 0 && unbatched.tickets === 0) {
    verdict = "inconclusive";
  } else if (costSavingBps < floor && costSavingBps > -floor) {
    verdict = "inconclusive";
  } else if (costSavingBps <= -floor) {
    verdict = "not_supported";
  } else if (drawdownDeltaPct > tolerance) {
    verdict = "costly_risk";
  } else {
    verdict = "supported";
  }

  const summary =
    verdict === "supported"
      ? `Batching saved ${fmt(costSavingBps)}bps of equity in costs (${ticketsSaved} fewer tickets) with drawdown ${drawdownDeltaPct <= 0 ? `${fmt(-drawdownDeltaPct)}pp lower` : `only ${fmt(drawdownDeltaPct)}pp higher`}. Keep the window on.`
      : verdict === "costly_risk"
        ? `Batching saved ${fmt(costSavingBps)}bps of costs but deepened max drawdown by ${fmt(drawdownDeltaPct)}pp — the delayed entries cost more risk than the commissions saved.`
        : verdict === "not_supported"
          ? `Batching cost ${fmt(-costSavingBps)}bps MORE than trading unbatched: the parked slices released into larger, later tickets without saving the floor.`
          : `No decisive difference: ${fmt(costSavingBps)}bps cost delta on ${batched.tickets + unbatched.tickets} tickets. Widen the window or lengthen the sample.`;

  return {
    batched,
    unbatched,
    costSavingBps,
    drawdownDeltaPct,
    returnDeltaPct,
    ticketsSaved,
    verdict,
    summary,
    bars: input.bars.length,
    signals: input.signals.length,
    minTicketBase: input.minTicketBase,
  };
}
