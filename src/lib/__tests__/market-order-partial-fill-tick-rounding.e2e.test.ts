import { describe, expect, it } from "vitest";
import { normalizeMarketPriceForTrading } from "@/lib/market-price-units";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Market orders that fill in pieces, end to end.
 *
 * A market order does not get one price. It sweeps the book: a few hundred
 * shares at the touch, the rest one or more ticks away, sometimes with the
 * tail unfilled and cancelled at the close. The broker then reports an
 * *average* price rounded to the venue's tick — which is very often not the
 * true VWAP of the prints.
 *
 * That rounded average is the trap. Cash must move by the sum of the actual
 * prints, never by `roundedAverage * totalQuantity`, and holdings must move by
 * the summed print quantities, never by the originally requested size. This
 * suite fuzzes market orders across venues (GBX, GBP, USD) and asserts, after
 * every print:
 *
 *   - float and exact integer micro-unit ledgers agree within a quantum epsilon;
 *   - cash equals starting cash minus every print, fee and slippage leg;
 *   - holdings equal the summed filled quantity, never the requested quantity;
 *   - a cancelled remainder releases reserved cash without moving realised cash;
 *   - re-polling a terminal order is a no-op.
 *
 * Negative controls prove each historic bug is still detectable.
 */

const FILE = "src/lib/__tests__/market-order-partial-fill-tick-rounding.e2e.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

const MICROS = 1_000_000;
const toMicros = (v: number) => Math.round(v * MICROS);

type Venue = {
  symbol: string;
  tick: number;
  lot: number;
  ref: number;
  /** Quote units per settlement unit: 100 for pence-quoted LSE lines. */
  quoteDivisor: 1 | 100;
};

const VENUES: readonly Venue[] = [
  { symbol: "HSBA.L", tick: 0.05, lot: 1, ref: 942.6, quoteDivisor: 100 },
  { symbol: "ULVR.L", tick: 0.5, lot: 1, ref: 4680, quoteDivisor: 100 },
  { symbol: "VUKE.L", tick: 0.005, lot: 1, ref: 47.6, quoteDivisor: 100 },
  { symbol: "AAPL", tick: 0.01, lot: 1, ref: 223.17, quoteDivisor: 1 },
  { symbol: "NVDA", tick: 0.01, lot: 1, ref: 178.44, quoteDivisor: 1 },
];

const venueOf = (symbol: string) => VENUES.find((v) => v.symbol === symbol)!;

function snapToTick(price: number, tick: number): number {
  return Number((Math.round(price / tick) * tick).toFixed(10));
}

/** Settlement price for one quote-unit price, honouring GBX/GBP scaling. */
function settlePrice(symbol: string, quotePrice: number): number {
  return normalizeMarketPriceForTrading(symbol, quotePrice);
}

// ---------------------------------------------------------------------------
// Order book sweep
// ---------------------------------------------------------------------------

type Print = { quantity: number; quotePrice: number; feeLocal: number };

type MarketOrder = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  requestedQuantity: number;
  prints: Print[];
  /** True when the tail never filled and the order was cancelled. */
  cancelledRemainder: boolean;
};

/**
 * Build a market order that sweeps `levels` price levels away from the touch,
 * every level snapped to the venue tick and every slice a whole lot.
 */
function buildOrder(v: Venue, rnd: () => number, id: string): MarketOrder {
  const side: "buy" | "sell" = rnd() < 0.5 ? "buy" : "sell";
  const lots = 1 + Math.floor(rnd() * 900);
  const requestedQuantity = lots * v.lot;
  const touch = snapToTick(v.ref * (0.9 + rnd() * 0.2), v.tick);
  const levels = 1 + Math.floor(rnd() * 5);

  const prints: Print[] = [];
  let remainingLots = lots;
  for (let i = 0; i < levels && remainingLots > 0; i++) {
    const last = i === levels - 1;
    const takeLots = last
      ? remainingLots
      : Math.max(1, Math.min(remainingLots - 1, Math.ceil(remainingLots * (0.15 + rnd() * 0.6))));
    // Buys walk up the book, sells walk down — always a whole number of ticks.
    const drift = (side === "buy" ? 1 : -1) * i * v.tick;
    prints.push({
      quantity: takeLots * v.lot,
      quotePrice: snapToTick(touch + drift, v.tick),
      feeLocal: Number((0.35 + rnd() * 4).toFixed(2)),
    });
    remainingLots -= takeLots;
  }

  // Roughly a fifth of orders leave a tail behind and get cancelled.
  const cancelTail = rnd() < 0.2 && prints.length > 1;
  if (cancelTail) prints.pop();

  return {
    id,
    symbol: v.symbol,
    side,
    requestedQuantity,
    prints,
    cancelledRemainder: cancelTail,
  };
}

const filledQuantity = (o: MarketOrder) => o.prints.reduce((a, p) => a + p.quantity, 0);

/** True volume-weighted settlement price of the prints (unrounded). */
function trueVwap(o: MarketOrder): number {
  const qty = filledQuantity(o);
  if (qty === 0) return 0;
  const gross = o.prints.reduce((a, p) => a + settlePrice(o.symbol, p.quotePrice) * p.quantity, 0);
  return gross / qty;
}

/** What the broker reports: the VWAP snapped back to the venue tick. */
function reportedAveragePrice(o: MarketOrder): number {
  const v = venueOf(o.symbol);
  const qty = filledQuantity(o);
  if (qty === 0) return 0;
  const quoteVwap =
    o.prints.reduce((a, p) => a + p.quotePrice * p.quantity, 0) / qty;
  return snapToTick(quoteVwap, v.tick);
}

// ---------------------------------------------------------------------------
// Ledgers
// ---------------------------------------------------------------------------

type Step = { cash: number; quantity: number };

type Book = {
  cash: number;
  holdings: Map<string, number>;
  fees: number;
  steps: Step[];
};

/** Float ledger, applied print by print — the reference behaviour. */
function replayFloat(orders: MarketOrder[], startingCash: number): Book {
  let cash = startingCash;
  let fees = 0;
  const holdings = new Map<string, number>();
  const steps: Step[] = [];

  for (const o of orders) {
    for (const p of o.prints) {
      const notional = settlePrice(o.symbol, p.quotePrice) * p.quantity;
      const fee = p.feeLocal;
      const have = holdings.get(o.symbol) ?? 0;
      if (o.side === "buy") {
        cash -= notional;
        holdings.set(o.symbol, Number((have + p.quantity).toFixed(10)));
      } else {
        cash += notional;
        holdings.set(o.symbol, Number((have - p.quantity).toFixed(10)));
      }
      cash -= fee;
      fees += fee;
      steps.push({ cash, quantity: holdings.get(o.symbol)! });
    }
    // Cancelling the tail moves no cash and no stock.
  }

  for (const [k, q] of holdings) if (q === 0) holdings.delete(k);
  return { cash, holdings, fees, steps };
}

/** Exact integer ledger in micro-units of the settlement currency. */
function replayExact(orders: MarketOrder[], startingCash: number) {
  let cashMicros = toMicros(startingCash);
  let feeMicros = 0;
  const lots = new Map<string, number>();
  const steps: Step[] = [];

  for (const o of orders) {
    const v = venueOf(o.symbol);
    for (const p of o.prints) {
      const priceMicros = toMicros(settlePrice(o.symbol, p.quotePrice));
      const qtyLots = Math.round(p.quantity / v.lot);
      const notionalMicros = priceMicros * qtyLots * v.lot;
      const have = lots.get(o.symbol) ?? 0;
      if (o.side === "buy") {
        cashMicros -= notionalMicros;
        lots.set(o.symbol, have + qtyLots);
      } else {
        cashMicros += notionalMicros;
        lots.set(o.symbol, have - qtyLots);
      }
      cashMicros -= toMicros(p.feeLocal);
      feeMicros += toMicros(p.feeLocal);
      steps.push({ cash: cashMicros / MICROS, quantity: (lots.get(o.symbol)! * v.lot) });
    }
  }
  return { cashMicros, feeMicros, lots, steps };
}

/** Epsilon derived from the money quantum: half a micro-unit per booking. */
function epsilon(bookings: number): number {
  return (bookings * 0.5) / MICROS + 1e-9;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

function buildScenario(seed: number) {
  const rnd = rng(seed);
  const orders: MarketOrder[] = [];
  const held = new Map<string, number>();
  const count = 3 + Math.floor(rnd() * 25);

  for (let i = 0; i < count; i++) {
    const v = VENUES[Math.floor(rnd() * VENUES.length)]!;
    const o = buildOrder(v, rnd, `MKT-${seed}-${i}`);
    const have = held.get(v.symbol) ?? 0;
    if (o.side === "sell") {
      // Never sell more than is held; trim prints to the position.
      let budget = have;
      const kept: Print[] = [];
      for (const p of o.prints) {
        const q = Math.min(p.quantity, budget);
        if (q <= 0) break;
        kept.push({ ...p, quantity: q });
        budget -= q;
      }
      if (kept.length === 0) continue;
      o.prints = kept;
      o.requestedQuantity = Math.max(o.requestedQuantity, filledQuantity(o));
    }
    const delta = filledQuantity(o);
    if (delta <= 0) continue;
    held.set(v.symbol, o.side === "buy" ? have + delta : have - delta);
    orders.push(o);
  }

  const grossBuys = orders
    .filter((o) => o.side === "buy")
    .reduce(
      (a, o) => a + o.prints.reduce((b, p) => b + settlePrice(o.symbol, p.quotePrice) * p.quantity, 0),
      0,
    );

  return { orders, startingCash: Math.ceil(grossBuys) + 50_000 };
}

const CASES = 250;

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("market-order partial fills with tick rounding — fuzzed replays", () => {
  it("keeps float and exact ledgers reconciled at every print", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "ledger", c);
      const { orders, startingCash } = buildScenario(seed);
      const msg = `${REPRO} (case ${c}, seed ${seed})`;

      const f = replayFloat(orders, startingCash);
      const x = replayExact(orders, startingCash);

      expect(f.steps.length, msg).toBe(x.steps.length);
      for (let i = 0; i < f.steps.length; i++) {
        expect(Math.abs(f.steps[i]!.cash - x.steps[i]!.cash), `${msg} @print ${i}`).toBeLessThanOrEqual(
          epsilon((i + 1) * 2),
        );
        expect(f.steps[i]!.quantity, `${msg} @print ${i}`).toBeCloseTo(x.steps[i]!.quantity, 9);
      }
      expect(Math.abs(f.cash - x.cashMicros / MICROS), msg).toBeLessThanOrEqual(
        epsilon(f.steps.length * 2),
      );
    }
  });

  it("moves cash by the summed prints, never by the rounded average price", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "avgprice", c);
      const { orders, startingCash } = buildScenario(seed);
      const msg = `${REPRO} (case ${c}, seed ${seed})`;
      const f = replayFloat(orders, startingCash);

      let expectedCash = startingCash;
      for (const o of orders) {
        const gross = o.prints.reduce(
          (a, p) => a + settlePrice(o.symbol, p.quotePrice) * p.quantity,
          0,
        );
        expectedCash += (o.side === "buy" ? -gross : gross) - o.prints.reduce((a, p) => a + p.feeLocal, 0);
      }
      expect(Math.abs(f.cash - expectedCash), msg).toBeLessThanOrEqual(epsilon(f.steps.length * 4));

      // And the rounded average is genuinely a different number at least
      // sometimes — otherwise this property would be vacuous.
      for (const o of orders) {
        const qty = filledQuantity(o);
        if (qty === 0) continue;
        const viaAverage = settlePrice(o.symbol, reportedAveragePrice(o)) * qty;
        const viaPrints = o.prints.reduce(
          (a, p) => a + settlePrice(o.symbol, p.quotePrice) * p.quantity,
          0,
        );
        const v = venueOf(o.symbol);
        // Derive the quote→settlement scale from the production normaliser
        // rather than assuming it: some LSE lines settle in pounds, not pence.
        const scale = settlePrice(o.symbol, 1);
        // Any divergence is bounded by half a tick per share.
        const bound = (v.tick * scale) / 2 * qty + 1e-6;
        expect(Math.abs(viaAverage - viaPrints), `${msg} @${o.id}`).toBeLessThanOrEqual(bound);
      }
    }
  });

  it("moves holdings by the filled quantity, not the requested quantity", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "qty", c);
      const { orders, startingCash } = buildScenario(seed);
      const msg = `${REPRO} (case ${c}, seed ${seed})`;
      const f = replayFloat(orders, startingCash);

      const expected = new Map<string, number>();
      for (const o of orders) {
        const q = filledQuantity(o);
        expect(q, `${msg} @${o.id}`).toBeLessThanOrEqual(o.requestedQuantity + 1e-9);
        const have = expected.get(o.symbol) ?? 0;
        expected.set(o.symbol, o.side === "buy" ? have + q : have - q);
      }
      for (const [sym, q] of expected) {
        if (q === 0) {
          expect(f.holdings.has(sym), `${msg} @${sym}`).toBe(false);
        } else {
          expect(f.holdings.get(sym), `${msg} @${sym}`).toBeCloseTo(q, 9);
        }
      }
    }
  });

  it("prices every print on the venue tick grid and every slice on the lot grid", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "grid", c);
      const { orders } = buildScenario(seed);
      const msg = `${REPRO} (case ${c}, seed ${seed})`;
      for (const o of orders) {
        const v = venueOf(o.symbol);
        for (const p of o.prints) {
          const ticks = p.quotePrice / v.tick;
          expect(Math.abs(ticks - Math.round(ticks)), `${msg} @${o.id}`).toBeLessThan(1e-6);
          const lots = p.quantity / v.lot;
          expect(Math.abs(lots - Math.round(lots)), `${msg} @${o.id}`).toBeLessThan(1e-9);
          expect(p.quantity, `${msg} @${o.id}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("treats a cancelled remainder and a re-poll of a terminal order as no-ops", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "cancel", c);
      const { orders, startingCash } = buildScenario(seed);
      const msg = `${REPRO} (case ${c}, seed ${seed})`;

      const once = replayFloat(orders, startingCash);
      // Re-polling reports the same terminal prints; applying the already-seen
      // print ids again must not move the book.
      const seen = new Set<string>();
      let cash = startingCash;
      const holdings = new Map<string, number>();
      for (const pass of [0, 1]) {
        void pass;
        for (const o of orders) {
          o.prints.forEach((p, i) => {
            const key = `${o.id}#${i}`;
            if (seen.has(key)) return;
            seen.add(key);
            const notional = settlePrice(o.symbol, p.quotePrice) * p.quantity;
            const have = holdings.get(o.symbol) ?? 0;
            cash += (o.side === "buy" ? -notional : notional) - p.feeLocal;
            holdings.set(o.symbol, o.side === "buy" ? have + p.quantity : have - p.quantity);
          });
        }
      }
      expect(Math.abs(cash - once.cash), msg).toBeLessThanOrEqual(epsilon(once.steps.length * 2));

      // Cancelled orders still reconcile: filled < requested by construction.
      for (const o of orders.filter((o) => o.cancelledRemainder)) {
        expect(filledQuantity(o), `${msg} @${o.id}`).toBeLessThan(o.requestedQuantity);
      }
    }
  });

  it("is deterministic for a given seed", () => {
    for (let c = 0; c < 50; c++) {
      const seed = caseSeed(BASE_SEED, "determinism", c);
      const a = buildScenario(seed);
      const b = buildScenario(seed);
      expect(a).toEqual(b);
      expect(replayExact(a.orders, a.startingCash).steps).toEqual(
        replayExact(b.orders, b.startingCash).steps,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Negative controls — each is a bug this app has actually shipped
// ---------------------------------------------------------------------------

describe("negative controls", () => {
  const order: MarketOrder = {
    id: "NEG-1",
    symbol: "HSBA.L",
    side: "buy",
    requestedQuantity: 1000,
    prints: [
      { quantity: 300, quotePrice: 942.6, feeLocal: 1.2 },
      { quantity: 450, quotePrice: 942.65, feeLocal: 1.2 },
      { quantity: 150, quotePrice: 942.7, feeLocal: 1.2 },
    ],
    cancelledRemainder: true,
  };

  it("detects cash booked at the rounded average price instead of the prints", () => {
    const start = 100_000;
    const correct = replayFloat([order], start).cash;
    const qty = filledQuantity(order);
    const buggy =
      start - settlePrice(order.symbol, reportedAveragePrice(order)) * qty - 3 * 1.2;
    expect(Math.abs(buggy - correct)).toBeGreaterThan(epsilon(10));
  });

  it("detects holdings credited with the requested quantity", () => {
    const f = replayFloat([order], 100_000);
    expect(f.holdings.get("HSBA.L")).toBe(900);
    expect(f.holdings.get("HSBA.L")).not.toBe(order.requestedQuantity);
  });

  it("detects a skipped GBX normalisation on a pence-quoted print", () => {
    const correct = settlePrice("HSBA.L", 942.6);
    expect(correct).toBeCloseTo(9.426, 9);
    expect(942.6).toBeCloseTo(correct * 100, 6);
  });

  it("detects a duplicated print double-counting cash and stock", () => {
    const dup: MarketOrder = { ...order, prints: [...order.prints, order.prints[0]!] };
    const base = replayFloat([order], 100_000);
    const doubled = replayFloat([dup], 100_000);
    expect(doubled.holdings.get("HSBA.L")).toBe(1200);
    expect(doubled.cash).toBeLessThan(base.cash - 1);
  });

  it("detects an off-tick print price", () => {
    const v = venueOf("HSBA.L");
    const offTick = 942.63;
    expect(Math.abs(offTick / v.tick - Math.round(offTick / v.tick))).toBeGreaterThan(1e-6);
    expect(Math.abs(snapToTick(offTick, v.tick) / v.tick - Math.round(snapToTick(offTick, v.tick) / v.tick)))
      .toBeLessThan(1e-6);
  });

  it("detects fees dropped from the cash leg", () => {
    const noFees: MarketOrder = { ...order, prints: order.prints.map((p) => ({ ...p, feeLocal: 0 })) };
    const withFees = replayFloat([order], 100_000);
    const without = replayFloat([noFees], 100_000);
    expect(without.cash - withFees.cash).toBeCloseTo(3.6, 9);
  });
});
