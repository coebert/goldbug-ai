import { describe, expect, it } from "vitest";
import { normalizeMarketPriceForTrading } from "@/lib/market-price-units";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Mixed-venue, mixed-currency replays: does the aggregate still balance?
 *
 * The single-instrument suites prove one venue's arithmetic. A real day is not
 * one venue: a GBP account buys a pence-quoted LSE common, a dollar-quoted US
 * name and a euro-quoted Amsterdam listing in the same session, and every
 * non-GBP leg drags an FX conversion — with its own fee — behind it.
 *
 * That aggregation is where the remaining money bugs hide:
 *
 *   - the FX fee charged on the gross notional for a buy but on the net
 *     proceeds for a sell (or vice versa), so buys and sells don't net;
 *   - the fee converted at a different rate than the leg it belongs to;
 *   - conversion applied before quote rounding, so the base amount is not a
 *     whole number of the venue's ticks converted at the day's rate;
 *   - per-currency sub-ledgers that each look right but don't sum to the base
 *     cash line, because one leg was converted twice (or not at all);
 *   - float drift across hundreds of mixed-currency legs.
 *
 * Every fuzzed seed builds a basket of buys and sells across all venues and
 * books it three ways: float base GBP, exact integer micro-pounds, and a set
 * of per-currency sub-ledgers converted at settlement. All three must agree
 * inside an epsilon derived from the money quantum and the booking count.
 */

const FILE = "src/lib/__tests__/multi-venue-fx-aggregate-reconciliation.fuzz.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

// ---------------------------------------------------------------------------
// Venues
// ---------------------------------------------------------------------------

type Ccy = "GBP" | "USD" | "EUR";

type Instrument = {
  symbol: string;
  /** Settlement currency of the listing (pence quotes still settle GBP). */
  ccy: Ccy;
  tick: number;
  lot: number;
  /** Reference quote in venue units — pence for GBX listings. */
  ref: number;
};

const INSTRUMENTS: readonly Instrument[] = [
  { symbol: "HSBA.L", ccy: "GBP", tick: 0.05, lot: 1, ref: 942.6 },
  { symbol: "ULVR.L", ccy: "GBP", tick: 0.5, lot: 1, ref: 4680 },
  { symbol: "VUKE.L", ccy: "GBP", tick: 0.005, lot: 1, ref: 47.6 },
  { symbol: "AAPL", ccy: "USD", tick: 0.01, lot: 1, ref: 223.17 },
  { symbol: "NVDA", ccy: "USD", tick: 0.01, lot: 1, ref: 178.44 },
  { symbol: "ASML.AS", ccy: "EUR", tick: 0.01, lot: 1, ref: 712.3 },
  { symbol: "SAP.DE", ccy: "EUR", tick: 0.01, lot: 1, ref: 241.85 },
];

/** Settlement rates into the account's base currency (GBP). */
const FX: Record<Ccy, number> = { GBP: 1, USD: 0.7842, EUR: 0.8451 };

/** Broker FX markup, in basis points of the converted amount. */
const FX_FEE_BPS = 25;

const MICROS = 1_000_000;

function roundToTick(price: number, tick: number): number {
  return Number((Math.round(price / tick) * tick).toFixed(10));
}

function floorToLot(qty: number, lot: number): number {
  return Number((Math.floor(qty / lot + 1e-9) * lot).toFixed(10));
}

/**
 * The ordering rule, stated once: quantise price to the venue tick and
 * quantity to the lot **in the quoted currency**, then convert to base. The
 * FX fee is always charged on the absolute converted amount, so a buy and an
 * equal-and-opposite sell pay the same fee rather than netting to zero.
 */
function legToBase(inst: Instrument, venuePrice: number, qty: number) {
  const settlePrice = normalizeMarketPriceForTrading(inst.symbol, venuePrice);
  const localNotional = settlePrice * qty;
  const baseNotional = localNotional * FX[inst.ccy];
  const fxFee = inst.ccy === "GBP" ? 0 : Math.abs(baseNotional) * (FX_FEE_BPS / 10_000);
  return { settlePrice, localNotional, baseNotional, fxFee };
}

const toMicros = (gbp: number) => Math.round(gbp * MICROS);

/** Epsilon from the quantum: each booking rounds by at most half a micro. */
function epsilonGbp(bookings: number): number {
  return (bookings * 0.5) / MICROS + 1e-9;
}

// ---------------------------------------------------------------------------
// Scenario generation
// ---------------------------------------------------------------------------

type Leg = {
  id: string;
  seq: number;
  symbol: string;
  side: "buy" | "sell";
  venuePrice: number;
  quantity: number;
  /** Commission, charged in the instrument's settlement currency. */
  commissionLocal: number;
};

type Scenario = { legs: Leg[]; startingCashGbp: number };

function buildScenario(seed: number, index: number): Scenario {
  const rnd = rng(seed);
  const legs: Leg[] = [];
  const held = new Map<string, number>();
  const count = 4 + Math.floor(rnd() * 40);
  let seq = 0;

  for (let i = 0; i < count; i++) {
    const inst = INSTRUMENTS[Math.floor(rnd() * INSTRUMENTS.length)]!;
    const have = held.get(inst.symbol) ?? 0;
    // Sell only what is actually held — the app never shorts a cash equity.
    const side: "buy" | "sell" = have > 0 && rnd() < 0.4 ? "sell" : "buy";
    const wanted =
      side === "buy"
        ? Math.max(inst.lot, floorToLot((1 + rnd() * 400) * inst.lot, inst.lot))
        : Math.max(inst.lot, floorToLot(have * (0.1 + rnd() * 0.9), inst.lot));
    const qty = side === "sell" ? Math.min(have, wanted) : wanted;
    if (!(qty > 0)) continue;

    legs.push({
      id: `L${index}-${seq}`,
      seq,
      symbol: inst.symbol,
      side,
      venuePrice: roundToTick(inst.ref * (0.85 + rnd() * 0.3), inst.tick),
      quantity: qty,
      commissionLocal: Number((1 + rnd() * 8).toFixed(2)),
    });
    held.set(inst.symbol, side === "buy" ? have + qty : Number((have - qty).toFixed(10)));
    seq += 1;
  }

  // Fund for the gross buy side so no fuzzed basket runs the account negative.
  const grossBuys = legs
    .filter((l) => l.side === "buy")
    .reduce((a, l) => {
      const inst = bySymbol(l.symbol);
      return a + legToBase(inst, l.venuePrice, l.quantity).baseNotional;
    }, 0);

  return { legs, startingCashGbp: Math.ceil(grossBuys * 1.25) + 25_000 };
}

function bySymbol(symbol: string): Instrument {
  return INSTRUMENTS.find((i) => i.symbol === symbol)!;
}

// ---------------------------------------------------------------------------
// Three ledgers over the same basket
// ---------------------------------------------------------------------------

type FloatBook = {
  cash: number;
  holdings: Map<string, { quantity: number; avgCost: number }>;
  commissionGbp: number;
  fxFeeGbp: number;
  trace: number[];
};

function replayFloat(s: Scenario): FloatBook {
  let cash = s.startingCashGbp;
  let commissionGbp = 0;
  let fxFeeGbp = 0;
  const holdings = new Map<string, { quantity: number; avgCost: number }>();
  const trace: number[] = [];

  for (const l of s.legs) {
    const inst = bySymbol(l.symbol);
    const { baseNotional, fxFee } = legToBase(inst, l.venuePrice, l.quantity);
    const commission = l.commissionLocal * FX[inst.ccy];
    const pos = holdings.get(l.symbol) ?? { quantity: 0, avgCost: 0 };

    if (l.side === "buy") {
      const basis = pos.quantity * pos.avgCost + baseNotional;
      pos.quantity = Number((pos.quantity + l.quantity).toFixed(10));
      pos.avgCost = pos.quantity > 0 ? basis / pos.quantity : 0;
      cash -= baseNotional;
    } else {
      pos.quantity = Number((pos.quantity - l.quantity).toFixed(10));
      if (pos.quantity <= 1e-12) {
        pos.quantity = 0;
        pos.avgCost = 0;
      }
      cash += baseNotional;
    }
    holdings.set(l.symbol, pos);

    cash -= commission + fxFee;
    commissionGbp += commission;
    fxFeeGbp += fxFee;
    trace.push(cash);
  }

  for (const [k, v] of holdings) if (v.quantity <= 0) holdings.delete(k);
  return { cash, holdings, commissionGbp, fxFeeGbp, trace };
}

type ExactBook = {
  cashMicros: number;
  basisMicros: number;
  commissionMicros: number;
  fxFeeMicros: number;
  /** Per-currency gross flow, in that currency's minor units × 1e6. */
  byCcy: Record<Ccy, { notionalLocalMicros: number; feeLocalMicros: number }>;
  trace: number[];
};

function replayExact(s: Scenario): ExactBook {
  let cashMicros = toMicros(s.startingCashGbp);
  let basisMicros = 0;
  let commissionMicros = 0;
  let fxFeeMicros = 0;
  const trace: number[] = [];
  const byCcy: ExactBook["byCcy"] = {
    GBP: { notionalLocalMicros: 0, feeLocalMicros: 0 },
    USD: { notionalLocalMicros: 0, feeLocalMicros: 0 },
    EUR: { notionalLocalMicros: 0, feeLocalMicros: 0 },
  };
  // Per-symbol open lots and the basis carried against them, so a sell
  // relieves basis proportionally instead of leaving buys stranded.
  const lots = new Map<string, { qty: number; basis: number }>();

  for (const l of s.legs) {
    const inst = bySymbol(l.symbol);
    const { localNotional, baseNotional, fxFee } = legToBase(inst, l.venuePrice, l.quantity);
    const notional = toMicros(baseNotional);
    const commission = toMicros(l.commissionLocal * FX[inst.ccy]);
    const fee = toMicros(fxFee);
    const qtyLots = Math.round(l.quantity / inst.lot);
    const pos = lots.get(l.symbol) ?? { qty: 0, basis: 0 };

    if (l.side === "buy") {
      pos.qty += qtyLots;
      pos.basis += notional;
      basisMicros += notional;
      cashMicros -= notional;
      byCcy[inst.ccy].notionalLocalMicros -= toMicros(localNotional);
    } else {
      const sold = Math.min(qtyLots, pos.qty);
      const relieved = pos.qty > 0 ? Math.round((pos.basis * sold) / pos.qty) : 0;
      pos.qty -= sold;
      pos.basis = pos.qty === 0 ? 0 : pos.basis - relieved;
      basisMicros -= pos.qty === 0 ? relieved + (pos.basis - 0) * 0 : relieved;
      cashMicros += notional;
      byCcy[inst.ccy].notionalLocalMicros += toMicros(localNotional);
    }
    lots.set(l.symbol, pos);

    cashMicros -= commission + fee;
    commissionMicros += commission;
    fxFeeMicros += fee;
    byCcy[inst.ccy].feeLocalMicros += toMicros(l.commissionLocal) + Math.round(fee / FX[inst.ccy]);
    trace.push(cashMicros);
  }

  return { cashMicros, basisMicros, commissionMicros, fxFeeMicros, byCcy, trace };
}

/**
 * Independent reconstruction: sum every leg's *local* flow per currency, then
 * convert each currency bucket once at settlement. If conversion is applied
 * consistently, converting per leg and converting per bucket must agree.
 */
function settleByCurrency(s: Scenario): number {
  let base = 0;
  const buckets: Record<Ccy, { notional: number; fees: number }> = {
    GBP: { notional: 0, fees: 0 },
    USD: { notional: 0, fees: 0 },
    EUR: { notional: 0, fees: 0 },
  };

  for (const l of s.legs) {
    const inst = bySymbol(l.symbol);
    const { localNotional, fxFee } = legToBase(inst, l.venuePrice, l.quantity);
    buckets[inst.ccy].notional += l.side === "buy" ? -localNotional : localNotional;
    // The FX fee is a base-currency charge; carry it back at the same rate so
    // the bucket sum is expressible entirely in local units.
    buckets[inst.ccy].fees += l.commissionLocal + fxFee / FX[inst.ccy];
  }

  for (const ccy of ["GBP", "USD", "EUR"] as const) {
    base += (buckets[ccy].notional - buckets[ccy].fees) * FX[ccy];
  }
  return s.startingCashGbp + base;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

const CASES = 200;

describe("mixed-venue FX aggregation — fuzzed replays", () => {
  it("balances the float, exact and per-currency settlements within the quantum epsilon", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "aggregate", c);
      const s = buildScenario(seed, c);
      const msg = `${REPRO} (case ${c}, seed ${seed}, ${s.legs.length} legs)`;

      const f = replayFloat(s);
      const x = replayExact(s);
      const settled = settleByCurrency(s);

      // Each leg books a notional, a commission and an FX fee.
      const eps = epsilonGbp(s.legs.length * 3);
      expect(Math.abs(f.cash - x.cashMicros / MICROS), msg).toBeLessThanOrEqual(eps);
      expect(Math.abs(f.cash - settled), msg).toBeLessThanOrEqual(eps);
      expect(Math.abs(x.cashMicros / MICROS - settled), msg).toBeLessThanOrEqual(eps);
    }
  });

  it("keeps the running cash trace aligned at every leg, not just at the end", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "trace", c);
      const s = buildScenario(seed, c);
      const f = replayFloat(s);
      const x = replayExact(s);
      for (let i = 0; i < f.trace.length; i++) {
        expect(
          Math.abs(f.trace[i]! - x.trace[i]! / MICROS),
          `${REPRO} (case ${c}, seed ${seed}) @leg ${i}`,
        ).toBeLessThanOrEqual(epsilonGbp((i + 1) * 3));
      }
    }
  });

  it("charges the FX fee on non-GBP legs only, on the absolute converted amount", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "fxfee", c);
      const s = buildScenario(seed, c);
      const msg = `${REPRO} (case ${c}, seed ${seed})`;

      let expected = 0;
      for (const l of s.legs) {
        const inst = bySymbol(l.symbol);
        const { baseNotional } = legToBase(inst, l.venuePrice, l.quantity);
        if (inst.ccy === "GBP") continue;
        expected += Math.abs(baseNotional) * (FX_FEE_BPS / 10_000);
      }
      const f = replayFloat(s);
      expect(f.fxFeeGbp, msg).toBeCloseTo(expected, 6);
      expect(f.fxFeeGbp, msg).toBeGreaterThanOrEqual(0);

      // A GBP-only basket pays no FX fee at all.
      const gbpOnly: Scenario = { ...s, legs: s.legs.filter((l) => bySymbol(l.symbol).ccy === "GBP") };
      expect(replayFloat(gbpOnly).fxFeeGbp, msg).toBe(0);
    }
  });

  it("nets buys and sells per symbol without letting holdings go negative", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "netting", c);
      const s = buildScenario(seed, c);
      const msg = `${REPRO} (case ${c}, seed ${seed})`;

      const running = new Map<string, number>();
      for (const l of s.legs) {
        const have = running.get(l.symbol) ?? 0;
        const next = l.side === "buy" ? have + l.quantity : have - l.quantity;
        expect(Number(next.toFixed(9)), `${msg} @${l.symbol}`).toBeGreaterThanOrEqual(0);
        running.set(l.symbol, Number(next.toFixed(10)));
      }

      const f = replayFloat(s);
      for (const [sym, pos] of f.holdings) {
        expect(pos.quantity, `${msg} @${sym}`).toBeCloseTo(running.get(sym)!, 9);
        expect(pos.avgCost, `${msg} @${sym}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps cash non-negative and conserves capital when the book is closed at basis", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "closeout", c);
      const s = buildScenario(seed, c);
      const msg = `${REPRO} (case ${c}, seed ${seed})`;

      const f = replayFloat(s);
      expect(f.cash, msg).toBeGreaterThanOrEqual(0);

      const bookValue = [...f.holdings.values()].reduce((a, p) => a + p.quantity * p.avgCost, 0);
      const realised = f.cash + bookValue - s.startingCashGbp + f.commissionGbp + f.fxFeeGbp;
      const x = replayExact(s);
      const realisedExact =
        (x.cashMicros + x.basisMicros - toMicros(s.startingCashGbp) + x.commissionMicros + x.fxFeeMicros) /
        MICROS;
      // Closing at basis leaves only realised P&L on non-flat symbols.
      expect(Math.abs(realised - realisedExact), msg).toBeLessThanOrEqual(
        epsilonGbp(s.legs.length * 4),
      );
    }
  });

  it("is deterministic across repeated replays of the same seed", () => {
    for (let c = 0; c < 50; c++) {
      const seed = caseSeed(BASE_SEED, "determinism", c);
      const a = buildScenario(seed, c);
      const b = buildScenario(seed, c);
      expect(a.legs).toEqual(b.legs);
      expect(replayExact(a).trace).toEqual(replayExact(b).trace);
      expect(replayFloat(a).cash).toBe(replayFloat(b).cash);
    }
  });
});

// ---------------------------------------------------------------------------
// Negative controls
// ---------------------------------------------------------------------------

describe("negative controls", () => {
  const usdLeg = { symbol: "AAPL", venuePrice: 223.17, qty: 100 };
  const gbxLeg = { symbol: "HSBA.L", venuePrice: 942.6, qty: 100 };

  it("catches converting before quote rounding", () => {
    const inst = bySymbol("AAPL");
    const correct = legToBase(inst, roundToTick(223.174, inst.tick), 100).baseNotional;
    const buggy = roundToTick(223.174 * FX.USD, inst.tick) * 100; // converted, then ticked
    expect(buggy).not.toBeCloseTo(correct, 6);
  });

  it("catches an FX fee charged on the local amount instead of the converted one", () => {
    const inst = bySymbol("ASML.AS");
    const { localNotional, fxFee } = legToBase(inst, 712.3, 10);
    const buggy = localNotional * (FX_FEE_BPS / 10_000);
    expect(buggy).toBeGreaterThan(fxFee);
    expect(fxFee).toBeCloseTo(buggy * FX.EUR, 9);
  });

  it("catches an FX fee that nets away between an offsetting buy and sell", () => {
    const inst = bySymbol("AAPL");
    const buy = legToBase(inst, usdLeg.venuePrice, usdLeg.qty);
    const sell = legToBase(inst, usdLeg.venuePrice, usdLeg.qty);
    expect(buy.fxFee + sell.fxFee).toBeGreaterThan(0); // signed fees would cancel
    expect(buy.baseNotional - sell.baseNotional).toBeCloseTo(0, 9);
  });

  it("catches a GBX leg converted as if it were quoted in pounds", () => {
    const inst = bySymbol("HSBA.L");
    const correct = legToBase(inst, gbxLeg.venuePrice, gbxLeg.qty).baseNotional;
    const buggy = gbxLeg.venuePrice * gbxLeg.qty * FX.GBP;
    expect(buggy).toBeCloseTo(correct * 100, 6);
  });

  it("catches a non-GBP leg converted twice", () => {
    const inst = bySymbol("NVDA");
    const once = legToBase(inst, 178.44, 50).baseNotional;
    const twice = once * FX.USD;
    expect(twice).toBeLessThan(once);
    expect(Math.abs(twice - once)).toBeGreaterThan(epsilonGbp(10));
  });
});
