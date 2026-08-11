import { describe, expect, it } from "vitest";
import { normalizeMarketPriceForTrading } from "@/lib/market-price-units";
import { rebuildLedgerFromFills } from "@/lib/fills-ledger-rebuild";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Partial fills + tick-size rounding, reconciled end-to-end across seeds.
 *
 * A live order rarely completes in one print. The broker works it in slices,
 * each landing at its own tick-snapped price, each carrying its own commission
 * — and the book has to agree with the sum of those slices to the penny. The
 * bugs this suite exists to catch are all "small" ones that only show up once
 * a parent order is chopped up:
 *
 *   - a slice priced off the venue's tick grid, so the fill notional and the
 *     book notional drift by a fraction of a tick per print;
 *   - quantity re-rounded on each slice, so the slices no longer sum to the
 *     parent's filled quantity;
 *   - a weighted average cost recomputed from the last slice instead of the
 *     running basis;
 *   - GBX normalisation applied per slice in one path and once at the end in
 *     another, so the two ledgers disagree by 100x on LSE names;
 *   - float drift accumulating over hundreds of slices until the float ledger
 *     and the exact integer ledger diverge past a penny.
 *
 * Each fuzzed seed builds a full order lifecycle (parent → N partial fills →
 * optional partial unwind) and books it twice: once as floats in base GBP,
 * once as integer micro-pounds. The two must agree inside an epsilon derived
 * from the money quantum and the number of bookings — never a constant picked
 * to make a red test green. The float ledger is also cross-checked against the
 * production `rebuildLedgerFromFills` reducer so the harness cannot drift away
 * from what the app actually does.
 */

const FILE = "src/lib/__tests__/partial-fill-tick-rounding-reconciliation.e2e.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

type Instrument = {
  symbol: string;
  /** Minimum price increment, in the venue's quoted units. */
  tick: number;
  /** Minimum quantity increment. */
  lot: number;
  /** Reference quote in venue units (pence for GBX listings). */
  ref: number;
};

const INSTRUMENTS: readonly Instrument[] = [
  { symbol: "HSBA.L", tick: 0.05, lot: 1, ref: 942.6 },
  { symbol: "ULVR.L", tick: 0.5, lot: 1, ref: 4680 },
  { symbol: "VUKE.L", tick: 0.005, lot: 1, ref: 47.6 },
  { symbol: "AAPL", tick: 0.01, lot: 1, ref: 223.17 },
  { symbol: "NVDA", tick: 0.01, lot: 1, ref: 178.44 },
  { symbol: "BTC-GBP", tick: 1, lot: 1e-6, ref: 84_310 },
];

/** Money quantum: one micro-pound. All exact bookings are integers of this. */
const MICROS = 1_000_000;

function roundToTick(price: number, tick: number): number {
  return Number((Math.round(price / tick) * tick).toFixed(10));
}

function floorToLot(qty: number, lot: number): number {
  return Number((Math.floor(qty / lot + 1e-9) * lot).toFixed(10));
}

/** Exact micro-pound notional for a slice, quote-rounded before conversion. */
function notionalMicros(symbol: string, venuePrice: number, qty: number): number {
  const base = normalizeMarketPriceForTrading(symbol, venuePrice);
  return Math.round(base * qty * MICROS);
}

// ---------------------------------------------------------------------------
// Scenario generation
// ---------------------------------------------------------------------------

type Slice = {
  fillId: string;
  seq: number;
  side: "buy" | "sell";
  /** Tick-snapped price in venue units. */
  venuePrice: number;
  /** Lot-snapped quantity. */
  quantity: number;
  /** Commission in base GBP. */
  fee: number;
  filledAt: string;
};

type Scenario = {
  instrument: Instrument;
  /** Parent order quantity, lot-snapped. */
  intended: number;
  slices: Slice[];
  startingCashGbp: number;
};

function buildScenario(seed: number, index: number): Scenario {
  const rnd = rng(seed);
  const inst = INSTRUMENTS[Math.floor(rnd() * INSTRUMENTS.length)]!;

  const rawIntended = inst.lot === 1 ? 1 + Math.floor(rnd() * 3_000) : rnd() * 4;
  const intended = Math.max(inst.lot, floorToLot(rawIntended, inst.lot));

  // Chop the parent into 1..12 partials that sum to <= intended. The last one
  // may leave a working remainder — a partially filled order is normal.
  const count = 1 + Math.floor(rnd() * 12);
  const slices: Slice[] = [];
  let remaining = intended;
  let seq = 0;

  for (let i = 0; i < count && remaining > 0; i++) {
    const wanted = i === count - 1 ? remaining * (0.5 + rnd() * 0.5) : remaining * (0.1 + rnd() * 0.6);
    const qty = Math.min(remaining, Math.max(inst.lot, floorToLot(wanted, inst.lot)));
    if (!(qty > 0)) break;
    const venuePrice = roundToTick(inst.ref * (0.9 + rnd() * 0.2), inst.tick);
    slices.push({
      fillId: `F${index}-${seq}`,
      seq,
      side: "buy",
      venuePrice,
      quantity: qty,
      fee: Number((1 + rnd() * 6).toFixed(2)),
      filledAt: `2026-08-11T${String(9 + (seq % 8)).padStart(2, "0")}:${String((seq * 7) % 60).padStart(2, "0")}:00Z`,
    });
    remaining = Number((remaining - qty).toFixed(10));
    seq += 1;
  }

  // Optionally sell part of what filled, also in partials.
  const bought = slices.reduce((a, s) => a + s.quantity, 0);
  if (bought > 0 && rnd() < 0.5) {
    let toSell = floorToLot(bought * (0.1 + rnd() * 0.8), inst.lot);
    const sellCount = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < sellCount && toSell > 0; i++) {
      const qty = i === sellCount - 1 ? toSell : Math.max(inst.lot, floorToLot(toSell * rnd(), inst.lot));
      const q = Math.min(toSell, qty);
      if (!(q > 0)) break;
      slices.push({
        fillId: `F${index}-${seq}`,
        seq,
        side: "sell",
        venuePrice: roundToTick(inst.ref * (0.9 + rnd() * 0.2), inst.tick),
        quantity: q,
        fee: Number((1 + rnd() * 6).toFixed(2)),
        filledAt: `2026-08-11T1${String(seq % 10)}:30:00Z`,
      });
      toSell = Number((toSell - q).toFixed(10));
      seq += 1;
    }
  }

  return { instrument: inst, intended, slices, startingCashGbp: 250_000 };
}

// ---------------------------------------------------------------------------
// Two ledgers over the same slices
// ---------------------------------------------------------------------------

type FloatLedger = {
  cash: number;
  quantity: number;
  avgCost: number;
  fees: number;
  /** Cash after each slice, in order. */
  trace: number[];
};

function replayFloat(s: Scenario): FloatLedger {
  let cash = s.startingCashGbp;
  let quantity = 0;
  let avgCost = 0;
  let fees = 0;
  const trace: number[] = [];

  for (const sl of s.slices) {
    const price = normalizeMarketPriceForTrading(s.instrument.symbol, sl.venuePrice);
    const notional = price * sl.quantity;
    if (sl.side === "buy") {
      const basis = quantity * avgCost + notional;
      quantity += sl.quantity;
      avgCost = quantity > 0 ? basis / quantity : 0;
      cash -= notional;
    } else {
      const sold = Math.min(sl.quantity, quantity);
      quantity = Number((quantity - sold).toFixed(10));
      if (quantity <= 0) {
        quantity = 0;
        avgCost = 0;
      }
      cash += price * sold;
    }
    cash -= sl.fee;
    fees += sl.fee;
    trace.push(cash);
  }

  return { cash, quantity, avgCost, fees, trace };
}

type ExactLedger = {
  cashMicros: number;
  /** Quantity in lot units, as an integer count of lots. */
  lots: number;
  basisMicros: number;
  feeMicros: number;
  trace: number[];
};

function replayExact(s: Scenario): ExactLedger {
  const lot = s.instrument.lot;
  let cashMicros = Math.round(s.startingCashGbp * MICROS);
  let lots = 0;
  let basisMicros = 0;
  let feeMicros = 0;
  const trace: number[] = [];

  for (const sl of s.slices) {
    const qtyLots = Math.round(sl.quantity / lot);
    const notional = notionalMicros(s.instrument.symbol, sl.venuePrice, sl.quantity);
    if (sl.side === "buy") {
      lots += qtyLots;
      basisMicros += notional;
      cashMicros -= notional;
    } else {
      const soldLots = Math.min(qtyLots, lots);
      // Relieve basis proportionally so avg cost stays put on a partial sell.
      const relieved = lots > 0 ? Math.round((basisMicros * soldLots) / lots) : 0;
      lots -= soldLots;
      basisMicros -= relieved;
      if (lots === 0) basisMicros = 0;
      cashMicros += notionalMicros(s.instrument.symbol, sl.venuePrice, soldLots * lot);
    }
    const fee = Math.round(sl.fee * MICROS);
    cashMicros -= fee;
    feeMicros += fee;
    trace.push(cashMicros);
  }

  return { cashMicros, lots, basisMicros, feeMicros, trace };
}

/**
 * Epsilon derived from the quantum, not chosen: each booking can round by at
 * most half a micro-pound, and a slice books a notional and a fee.
 */
function epsilonGbp(bookings: number): number {
  return (bookings * 0.5) / MICROS + 1e-9;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

const CASES = 250;

describe("partial fills with tick rounding — fuzzed reconciliation", () => {
  it("keeps the float and exact ledgers within a quantum-derived epsilon", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "ledger", c);
      const s = buildScenario(seed, c);
      const msg = `${REPRO} (case ${c}, seed ${seed}, ${s.instrument.symbol}, ${s.slices.length} slices)`;

      const f = replayFloat(s);
      const x = replayExact(s);

      expect(f.cash, msg).toBeCloseTo(x.cashMicros / MICROS, 6);
      expect(Math.abs(f.cash - x.cashMicros / MICROS), msg).toBeLessThanOrEqual(
        epsilonGbp(s.slices.length * 2),
      );
      expect(f.fees, msg).toBeCloseTo(x.feeMicros / MICROS, 9);
      expect(f.quantity, msg).toBeCloseTo(x.lots * s.instrument.lot, 9);

      // Step-by-step, not just at the end: drift must not accumulate.
      for (let i = 0; i < f.trace.length; i++) {
        expect(
          Math.abs(f.trace[i]! - x.trace[i]! / MICROS),
          `${msg} @slice ${i}`,
        ).toBeLessThanOrEqual(epsilonGbp((i + 1) * 2));
      }
    }
  });

  it("keeps every slice on the tick and lot grids and never over-fills the parent", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "grids", c);
      const s = buildScenario(seed, c);
      const msg = `${REPRO} (case ${c}, seed ${seed}, ${s.instrument.symbol})`;
      const { tick, lot } = s.instrument;

      let bought = 0;
      for (const sl of s.slices) {
        expect(roundToTick(sl.venuePrice, tick), msg).toBe(sl.venuePrice);
        expect(Number((sl.quantity / lot).toFixed(6)) % 1, msg).toBeCloseTo(0, 6);
        expect(sl.quantity, msg).toBeGreaterThan(0);
        if (sl.side === "buy") bought += sl.quantity;
      }
      // Partials sum to the parent's filled quantity and never exceed intent.
      expect(bought, msg).toBeLessThanOrEqual(s.intended + 1e-9);
    }
  });

  it("holds cash and holdings non-negative through every partial", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "solvency", c);
      const s = buildScenario(seed, c);
      const msg = `${REPRO} (case ${c}, seed ${seed}, ${s.instrument.symbol})`;

      let cashMicros = Math.round(s.startingCashGbp * MICROS);
      let qty = 0;
      for (const sl of s.slices) {
        const n = notionalMicros(s.instrument.symbol, sl.venuePrice, sl.quantity);
        if (sl.side === "buy") {
          cashMicros -= n + Math.round(sl.fee * MICROS);
          qty += sl.quantity;
        } else {
          const sold = Math.min(sl.quantity, qty);
          cashMicros += notionalMicros(s.instrument.symbol, sl.venuePrice, sold) - Math.round(sl.fee * MICROS);
          qty = Number((qty - sold).toFixed(10));
        }
        expect(qty, msg).toBeGreaterThanOrEqual(0);
        expect(cashMicros, msg).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("agrees with the production fills reducer on positions and cash movement", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "reducer", c);
      const s = buildScenario(seed, c);
      const msg = `${REPRO} (case ${c}, seed ${seed}, ${s.instrument.symbol})`;

      const rebuilt = rebuildLedgerFromFills(
        s.slices.map((sl) => {
          const price = normalizeMarketPriceForTrading(s.instrument.symbol, sl.venuePrice);
          return {
            id: sl.fillId,
            symbol: s.instrument.symbol,
            side: sl.side,
            quantity: sl.quantity,
            fill_price: price,
            filled_at: sl.filledAt,
            price,
          };
        }),
      );

      const f = replayFloat(s);
      // The reducer knows nothing about commission, so compare pre-fee cash.
      expect(rebuilt.cashDelta, msg).toBeCloseTo(f.cash - s.startingCashGbp + f.fees, 6);
      const pos = rebuilt.positions[0];
      if (f.quantity > 0) {
        expect(pos?.quantity, msg).toBeCloseTo(f.quantity, 9);
        expect(pos?.avgCost, msg).toBeCloseTo(f.avgCost, 6);
      } else {
        expect(rebuilt.positions, msg).toHaveLength(0);
      }
    }
  });

  it("closes the books: cash + holdings value == capital + realised P&L − fees", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "closeout", c);
      const s = buildScenario(seed, c);
      const msg = `${REPRO} (case ${c}, seed ${seed}, ${s.instrument.symbol})`;

      const x = replayExact(s);
      // Unwind the residual position at its own book basis: the identity then
      // reduces to capital − fees + realised P&L with no mark-to-market noise.
      const closedCash = x.cashMicros + x.basisMicros;
      const realised = closedCash - Math.round(s.startingCashGbp * MICROS) + x.feeMicros;

      const f = replayFloat(s);
      const realisedFloat = f.cash + f.quantity * f.avgCost - s.startingCashGbp + f.fees;
      expect(realised / MICROS, msg).toBeCloseTo(realisedFloat, 5);
      expect(Math.abs(realised / MICROS - realisedFloat), msg).toBeLessThanOrEqual(
        epsilonGbp(s.slices.length * 3),
      );
    }
  });

  it("is deterministic: the same seed replays to identical traces", () => {
    for (let c = 0; c < 60; c++) {
      const seed = caseSeed(BASE_SEED, "determinism", c);
      const a = buildScenario(seed, c);
      const b = buildScenario(seed, c);
      expect(a.slices).toEqual(b.slices);
      expect(replayExact(a)).toEqual(replayExact(b));
      expect(replayFloat(a).trace).toEqual(replayFloat(b).trace);
    }
  });
});

// ---------------------------------------------------------------------------
// Negative controls
// ---------------------------------------------------------------------------

describe("negative controls", () => {
  const scenario = (): Scenario => ({
    instrument: { symbol: "HSBA.L", tick: 0.05, lot: 1, ref: 942.6 },
    intended: 300,
    startingCashGbp: 100_000,
    slices: [0, 1, 2].map((i) => ({
      fillId: `N${i}`,
      seq: i,
      side: "buy" as const,
      venuePrice: roundToTick(942.6 + i * 0.15, 0.05),
      quantity: 100,
      fee: 3,
      filledAt: `2026-08-11T1${i}:00:00Z`,
    })),
  });

  it("catches a slice priced off the tick grid", () => {
    const s = scenario();
    const bad = { ...s, slices: s.slices.map((sl, i) => (i === 1 ? { ...sl, venuePrice: 942.673 } : sl)) };
    expect(roundToTick(bad.slices[1]!.venuePrice, 0.05)).not.toBe(bad.slices[1]!.venuePrice);
    expect(replayExact(bad).cashMicros).not.toBe(replayExact(s).cashMicros);
  });

  it("catches a dropped partial fill", () => {
    const s = scenario();
    const dropped = { ...s, slices: s.slices.slice(0, 2) };
    expect(replayExact(dropped).lots).toBe(200);
    expect(replayExact(s).lots).toBe(300);
    expect(replayExact(dropped).cashMicros).toBeGreaterThan(replayExact(s).cashMicros);
  });

  it("catches a duplicated partial fill", () => {
    const s = scenario();
    const dupe = { ...s, slices: [...s.slices, s.slices[0]!] };
    expect(replayExact(dupe).lots).toBe(400);
    expect(replayExact(dupe).cashMicros).toBeLessThan(replayExact(s).cashMicros);
  });

  it("catches GBX normalisation skipped on a slice (100x notional)", () => {
    const sl = scenario().slices[0]!;
    const correct = notionalMicros("HSBA.L", sl.venuePrice, sl.quantity);
    const buggy = Math.round(sl.venuePrice * sl.quantity * MICROS); // no /100
    expect(buggy).toBe(correct * 100);
  });

  it("catches average cost taken from the last slice instead of the running basis", () => {
    const s = scenario();
    const f = replayFloat(s);
    const lastPrice = normalizeMarketPriceForTrading("HSBA.L", s.slices.at(-1)!.venuePrice);
    expect(f.avgCost).toBeLessThan(lastPrice);
    expect(f.avgCost).toBeCloseTo(
      s.slices.reduce((a, sl) => a + normalizeMarketPriceForTrading("HSBA.L", sl.venuePrice) * sl.quantity, 0) / 300,
      9,
    );
  });
});
