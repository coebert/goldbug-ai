import { describe, expect, it } from "vitest";
import {
  isLseGbxDisplayQuoted,
  marketQuoteCurrency,
  normalizeMarketPriceForTrading,
} from "@/lib/market-price-units";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Tick size and currency quoting rules, reconciled against the ledger.
 *
 * The existing precision suite fuzzes abstract sizes. This one puts real
 * instrument metadata in front of the arithmetic, because that is where the
 * app's historic money bugs actually came from:
 *
 *   - an LSE common stock quoted in GBX (pence) treated as GBP → 100x
 *   - a GBP-quoted Vanguard LSE ETF divided by 100 anyway → 1/100x
 *   - a price that never got snapped to the instrument's tick, so the fill
 *     notional and the ledger notional disagreed by a fraction of a tick
 *   - a fractional-lot instrument rounded to whole units in one path only
 *
 * The rule enforced here is the ordering rule: **round in the quoted currency
 * to the instrument's tick, quantise quantity to its lot, THEN convert to the
 * portfolio base (GBP)**. Doing it the other way round produces a price that
 * is not on the venue's tick grid, and the venue's fill will not match the
 * book. Every fuzzed replay is booked twice — once as floats in base currency,
 * once as integer micro-pounds — and the two must agree inside an epsilon
 * derived from the quantum, not from a number picked to make the test pass.
 *
 * The GBX/GBP decision is delegated to the production helpers in
 * `market-price-units`, so this file also pins those rules in place.
 */

const FILE = "src/lib/__tests__/instrument-tick-precision-reconciliation.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

// ---------------------------------------------------------------------------
// Instruments: quoting rules, tick grid and lot grid
// ---------------------------------------------------------------------------

type QuoteCcy = "GBX" | "GBP" | "USD" | "EUR";

type Instrument = {
  symbol: string;
  /** Currency the venue quotes in, before any normalisation. */
  quote: QuoteCcy;
  /** Minimum price increment, expressed in the quoted currency's units. */
  tick: number;
  /** Minimum quantity increment (1 = whole shares, 1e-6 = fractional). */
  lot: number;
  /** Major-currency → GBP rate. GBX converts via its GBP major, so 1. */
  fx: number;
  /** Typical quoted price, used to seed the fuzzer in a realistic range. */
  ref: number;
};

/**
 * A deliberately awkward mix: pence-quoted LSE commons, a pound-quoted LSE
 * ETF from the allowlist, a US name, a euro name, and a fractional-lot
 * instrument. Between them they exercise every branch of the quoting rules.
 */
const INSTRUMENTS: readonly Instrument[] = [
  { symbol: "HSBA.L", quote: "GBX", tick: 0.05, lot: 1, fx: 1, ref: 942.6 },
  { symbol: "MKS.L", quote: "GBX", tick: 0.1, lot: 1, fx: 1, ref: 404.2 },
  { symbol: "ISF.L", quote: "GBX", tick: 0.5, lot: 1, fx: 1, ref: 1062 },
  { symbol: "VUKE.L", quote: "GBP", tick: 0.005, lot: 1, fx: 1, ref: 47.6 },
  { symbol: "VWRL.L", quote: "GBP", tick: 0.01, lot: 1, fx: 1, ref: 118.4 },
  { symbol: "AAPL", quote: "USD", tick: 0.01, lot: 1, fx: 0.7842, ref: 223.17 },
  { symbol: "NVDA", quote: "USD", tick: 0.01, lot: 1, fx: 0.7842, ref: 178.44 },
  { symbol: "ASML.AS", quote: "EUR", tick: 0.01, lot: 1, fx: 0.8451, ref: 712.3 },
  { symbol: "BTC-GBP", quote: "GBP", tick: 1, lot: 1e-6, fx: 1, ref: 84_310 },
];

const bySymbol = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));

/** Snap a price onto the instrument's tick grid, in the quoted currency. */
function roundToTick(price: number, tick: number): number {
  const ticks = Math.round(price / tick);
  // Re-derive from the integer tick count and trim the representation error
  // that `ticks * tick` leaves behind (e.g. 0.1 * 3 = 0.30000000000000004).
  return Number((ticks * tick).toFixed(10));
}

/** Snap a quantity onto the instrument's lot grid. */
function roundToLot(qty: number, lot: number): number {
  return Number((Math.round(qty / lot) * lot).toFixed(10));
}

const onGrid = (value: number, grid: number) => Math.abs(value / grid - Math.round(value / grid)) < 1e-6;

/**
 * Convert a tick-rounded quoted price into the portfolio base (GBP).
 *
 * GBX handling is delegated to the production normaliser so this test cannot
 * drift from the app: pence-quoted LSE names divide by 100, the GBP-quoted
 * allowlist passes through, and everything else applies its FX rate.
 */
function quoteToBase(inst: Instrument, quotedPrice: number): number {
  if (inst.symbol.toUpperCase().endsWith(".L") || inst.symbol.toUpperCase().endsWith(":XLON")) {
    return normalizeMarketPriceForTrading(inst.symbol, quotedPrice);
  }
  return quotedPrice * inst.fx;
}

// ---------------------------------------------------------------------------
// Fuzzed fills
// ---------------------------------------------------------------------------

type Fill = {
  step: number;
  symbol: string;
  side: "buy" | "sell";
  /** Quantity already snapped to the instrument's lot grid. */
  qty: number;
  /** Price already snapped to the instrument's tick grid, in quote currency. */
  quotedPrice: number;
};

function randomFills(r: () => number, n: number): Fill[] {
  const held = new Map<string, number>();
  const fills: Fill[] = [];
  for (let step = 0; step < n; step++) {
    const inst = INSTRUMENTS[Math.floor(r() * INSTRUMENTS.length)];
    const drift = 1 + (r() - 0.5) * 0.12;
    const quotedPrice = roundToTick(Math.max(inst.tick, inst.ref * drift), inst.tick);
    const openQty = held.get(inst.symbol) ?? 0;
    // Sell only what is held, so holdings can never legitimately go short and
    // any negative balance is a genuine reconciliation failure.
    const side: "buy" | "sell" = openQty > 0 && r() < 0.45 ? "sell" : "buy";
    const rawQty =
      side === "sell"
        ? openQty * (r() < 0.4 ? 1 : Math.max(inst.lot / Math.max(openQty, inst.lot), r()))
        : inst.lot === 1
          ? 1 + Math.floor(r() * 400)
          : r() * 0.5;
    const qty = Math.max(inst.lot, roundToLot(rawQty, inst.lot));
    const capped = side === "sell" ? Math.min(qty, openQty) : qty;
    if (capped <= 0) continue;
    held.set(inst.symbol, side === "buy" ? openQty + capped : openQty - capped);
    fills.push({ step, symbol: inst.symbol, side, qty: capped, quotedPrice });
  }
  return fills;
}

// ---------------------------------------------------------------------------
// Two independent ledgers over the same fills
// ---------------------------------------------------------------------------

const MICRO = 1_000_000; // micro-pounds; 1e-6 GBP is finer than any real venue
const toMicro = (gbp: number) => Math.round(gbp * MICRO);

type Ledger = {
  /** Float ledger, base currency. */
  cash: number;
  /** Integer ledger, micro-pounds. */
  cashMicro: number;
  holdings: Map<string, number>;
  /** Holdings in integer lot counts, so quantity precision is exact. */
  lots: Map<string, number>;
  /** Per-step trace of both cash figures for step-wise reconciliation. */
  trace: { step: number; cash: number; cashMicro: number; notionalBase: number; notionalMicro: number }[];
};

function runLedger(fills: readonly Fill[], startCash: number): Ledger {
  const led: Ledger = {
    cash: startCash,
    cashMicro: toMicro(startCash),
    holdings: new Map(),
    lots: new Map(),
    trace: [],
  };

  for (const fill of fills) {
    const inst = bySymbol.get(fill.symbol)!;
    // ORDER MATTERS: tick in quote ccy → lot on quantity → convert to base.
    const basePrice = quoteToBase(inst, fill.quotedPrice);
    const notionalBase = basePrice * fill.qty;
    const notionalMicro = toMicro(notionalBase);
    const sign = fill.side === "buy" ? -1 : 1;

    led.cash += sign * notionalBase;
    led.cashMicro += sign * notionalMicro;

    const lotDelta = Math.round(fill.qty / inst.lot) * (fill.side === "buy" ? 1 : -1);
    const lots = (led.lots.get(fill.symbol) ?? 0) + lotDelta;
    if (lots === 0) led.lots.delete(fill.symbol);
    else led.lots.set(fill.symbol, lots);

    const qty = (led.holdings.get(fill.symbol) ?? 0) + (fill.side === "buy" ? fill.qty : -fill.qty);
    if (Math.abs(qty) < inst.lot / 2) led.holdings.delete(fill.symbol);
    else led.holdings.set(fill.symbol, qty);

    led.trace.push({ step: fill.step, cash: led.cash, cashMicro: led.cashMicro, notionalBase, notionalMicro });
  }
  return led;
}

// ---------------------------------------------------------------------------
// Tolerances — each derived from a quantum, not chosen to make a test pass
// ---------------------------------------------------------------------------

const TOLERANCE = {
  /** One micro-pound per booking is the most the integer ledger can lose. */
  perBookingGbp: 1 / MICRO,
  /** IEEE-754 drift on the float ledger, relative to the running magnitude. */
  relative: 1e-11,
  /** Floor so near-zero balances are not held to an impossible standard. */
  absoluteFloor: 1e-9,
} as const;

function closeEnough(a: number, b: number, abs: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= Math.max(abs, scale * TOLERANCE.relative, TOLERANCE.absoluteFloor);
}

const CASES = 40;

const fuzzCase = (c: number, tag: string) => {
  const r = rng(caseSeed(BASE_SEED, tag, c));
  const fills = randomFills(r, 40 + Math.floor(r() * 160));
  return { fills, startCash: 10_000 + r() * 990_000, ctx: `case ${c} — ${REPRO}` };
};

// ---------------------------------------------------------------------------

describe("instrument quoting rules", () => {
  it("classifies every fixture instrument the way the production helpers do", () => {
    for (const inst of INSTRUMENTS) {
      const gbx = isLseGbxDisplayQuoted(inst.symbol);
      expect(gbx, `${inst.symbol} quote classification drifted from the app rule`).toBe(inst.quote === "GBX");
      expect(marketQuoteCurrency(inst.symbol)).toBe(inst.quote === "GBX" ? "GBX" : null);
    }
  });

  it("converts pence quotes to pounds and leaves pound-quoted names alone", () => {
    // The two regressions this app has actually shipped, pinned as a pair.
    expect(quoteToBase(bySymbol.get("HSBA.L")!, 942.6)).toBeCloseTo(9.426, 10);
    expect(quoteToBase(bySymbol.get("ISF.L")!, 1062)).toBeCloseTo(10.62, 10);
    expect(quoteToBase(bySymbol.get("VUKE.L")!, 47.6)).toBeCloseTo(47.6, 10);
    expect(quoteToBase(bySymbol.get("AAPL")!, 100)).toBeCloseTo(78.42, 10);
    expect(quoteToBase(bySymbol.get("ASML.AS")!, 100)).toBeCloseTo(84.51, 10);
  });

  it("keeps every fuzzed price on its instrument's tick grid and quantity on its lot grid", () => {
    for (let c = 0; c < CASES; c++) {
      const { fills, ctx } = fuzzCase(c, "grids");
      for (const fill of fills) {
        const inst = bySymbol.get(fill.symbol)!;
        expect(onGrid(fill.quotedPrice, inst.tick), `${fill.symbol} price off the tick grid: ${ctx}`).toBe(true);
        expect(onGrid(fill.qty, inst.lot), `${fill.symbol} quantity off the lot grid: ${ctx}`).toBe(true);
        expect(fill.quotedPrice, `${fill.symbol} priced at or below zero: ${ctx}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("tick/lot precision reconciles to the cash and holdings ledger", () => {
  it("float and integer ledgers agree at every step within the booking epsilon", () => {
    for (let c = 0; c < CASES; c++) {
      const { fills, startCash, ctx } = fuzzCase(c, "steps");
      const led = runLedger(fills, startCash);
      led.trace.forEach((t, i) => {
        // Worst case: one micro-pound of rounding per booking so far, plus the
        // rounding of the opening balance itself.
        const bound = TOLERANCE.perBookingGbp * (i + 2);
        expect(
          closeEnough(t.cash, t.cashMicro / MICRO, bound),
          `cash ledgers diverged beyond ${bound} GBP at step ${t.step}: ${ctx}`,
        ).toBe(true);
        expect(
          closeEnough(t.notionalBase, t.notionalMicro / MICRO, TOLERANCE.perBookingGbp),
          `notional rounding exceeded one micro-pound at step ${t.step}: ${ctx}`,
        ).toBe(true);
      });
    }
  });

  it("holdings are exact multiples of the lot size and never go short", () => {
    for (let c = 0; c < CASES; c++) {
      const { fills, startCash, ctx } = fuzzCase(c, "holdings");
      const led = runLedger(fills, startCash);
      for (const [symbol, qty] of led.holdings) {
        const inst = bySymbol.get(symbol)!;
        expect(qty, `${symbol} went short: ${ctx}`).toBeGreaterThan(0);
        expect(onGrid(qty, inst.lot), `${symbol} holding is not a whole number of lots: ${ctx}`).toBe(true);
        // The integer lot ledger is the source of truth for quantity; the float
        // one must match it exactly once scaled back.
        const lots = led.lots.get(symbol) ?? 0;
        expect(
          closeEnough(qty, lots * inst.lot, inst.lot * 1e-6),
          `${symbol} float holding drifted from its lot count: ${ctx}`,
        ).toBe(true);
      }
      for (const [symbol, lots] of led.lots) {
        expect(lots, `${symbol} lot count went negative: ${ctx}`).toBeGreaterThan(0);
      }
    }
  });

  it("closing cash equals opening cash plus every signed notional, within epsilon", () => {
    for (let c = 0; c < CASES; c++) {
      const { fills, startCash, ctx } = fuzzCase(c, "totals");
      const led = runLedger(fills, startCash);
      const summed = led.trace.reduce((a, t, i) => {
        const fill = fills[i];
        return a + (fill.side === "buy" ? -t.notionalBase : t.notionalBase);
      }, startCash);
      const bound = TOLERANCE.perBookingGbp * (led.trace.length + 2);
      expect(closeEnough(led.cash, summed, bound), `closing cash != sum of notionals: ${ctx}`).toBe(true);
      expect(
        closeEnough(led.cashMicro / MICRO, summed, bound),
        `integer closing cash != sum of notionals: ${ctx}`,
      ).toBe(true);
    }
  });

  it("unwinding the whole book returns holdings to zero and cash to a marked-out total", () => {
    for (let c = 0; c < CASES; c++) {
      const { fills, startCash, ctx } = fuzzCase(c, "unwind");
      const led = runLedger(fills, startCash);
      // Close every open position at its last traded price, on the tick grid.
      const lastPrice = new Map<string, number>();
      for (const f of fills) lastPrice.set(f.symbol, f.quotedPrice);
      const closing: Fill[] = [...led.holdings].map(([symbol, qty], i) => ({
        step: fills.length + i,
        symbol,
        side: "sell" as const,
        qty,
        quotedPrice: lastPrice.get(symbol)!,
      }));
      const full = runLedger([...fills, ...closing], startCash);
      expect(full.holdings.size, `book not flat after unwind: ${ctx}`).toBe(0);
      expect(full.lots.size, `lot ledger not flat after unwind: ${ctx}`).toBe(0);
      const bound = TOLERANCE.perBookingGbp * (full.trace.length + 2);
      expect(
        closeEnough(full.cash, full.cashMicro / MICRO, bound),
        `cash ledgers diverged across the unwind: ${ctx}`,
      ).toBe(true);
    }
  });
});

describe("negative controls — the epsilons are tight enough to catch real bugs", () => {
  it("treating a GBX quote as GBP blows the reconciliation apart", () => {
    const inst = bySymbol.get("HSBA.L")!;
    const correct = quoteToBase(inst, 942.6) * 100;
    const buggy = 942.6 * 100; // the 100x bug: pence booked as pounds
    expect(closeEnough(correct, buggy, TOLERANCE.perBookingGbp * 4)).toBe(false);
  });

  it("dividing a GBP-quoted LSE ETF by 100 blows it apart too", () => {
    const inst = bySymbol.get("VUKE.L")!;
    const correct = quoteToBase(inst, 47.6);
    const buggy = 47.6 / 100; // the 1/100x bug: allowlist ignored
    expect(closeEnough(correct, buggy, TOLERANCE.perBookingGbp * 4)).toBe(false);
  });

  it("skipping tick rounding shows up as a notional mismatch", () => {
    const inst = bySymbol.get("ISF.L")!; // 0.5p tick
    const raw = 1062.37; // not on the grid
    const snapped = roundToTick(raw, inst.tick);
    expect(onGrid(raw, inst.tick)).toBe(false);
    expect(onGrid(snapped, inst.tick)).toBe(true);
    const qty = 500;
    const gap = Math.abs(quoteToBase(inst, raw) * qty - quoteToBase(inst, snapped) * qty);
    expect(gap, "an off-tick price must move the notional by more than the epsilon").toBeGreaterThan(
      TOLERANCE.perBookingGbp * qty,
    );
  });

  it("rounding the base price instead of the quoted price leaves the venue grid", () => {
    // Converting first and snapping afterwards produces a price the venue
    // cannot fill; the resulting quoted price is off its own tick grid.
    const inst = bySymbol.get("HSBA.L")!;
    const quoted = 942.63;
    const wrong = Number((Math.round(quoteToBase(inst, quoted) / 0.01) * 0.01).toFixed(10)) * 100;
    expect(onGrid(wrong, inst.tick), "base-first rounding must not land on the venue tick grid").toBe(false);
  });

  it("one micro-pound of injected drift per booking is detected at the total", () => {
    const { fills, startCash } = fuzzCase(0, "control");
    const led = runLedger(fills, startCash);
    const drifted = led.cash + TOLERANCE.perBookingGbp * (led.trace.length + 8);
    const bound = TOLERANCE.perBookingGbp * (led.trace.length + 2);
    expect(closeEnough(drifted, led.cashMicro / MICRO, bound), `injected drift went undetected — ${REPRO}`).toBe(false);
  });
});
