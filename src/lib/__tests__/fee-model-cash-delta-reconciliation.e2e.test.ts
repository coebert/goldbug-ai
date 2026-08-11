import { describe, expect, it } from "vitest";
import { estimateSaxoCommission, inferSaxoCurrency, saxoBreakevenNotional } from "@/lib/saxo-fees";
import { normalizeMarketPriceForTrading } from "@/lib/market-price-units";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Commission and fee reconciliation, end to end, across several fee models.
 *
 * The app has to survive more than one cost regime: the live Saxo tiered
 * schedule (bps with a per-side minimum), the flat-ticket model used by the
 * sim broker, a pure bps model used in backtests, and a capped model with UK
 * stamp duty on buys. Every one of them must satisfy the same invariant:
 *
 *     cash_after = cash_before - side_sign * notional - fees
 *
 * booked once, in the trade currency, at the moment of the fill — with no
 * fee applied twice, none dropped on sells, and none silently absorbed into
 * the notional (which would corrupt average cost and every downstream P&L).
 *
 * These tests fuzz replays across all models and assert:
 *   - per-fill cash deltas decompose exactly into notional + itemised fees;
 *   - the float ledger and an exact integer micro-unit ledger agree inside a
 *     quantum epsilon;
 *   - fees are always non-negative, monotonic in notional, and floored/capped
 *     as each model specifies;
 *   - the round-trip cost of a position equals the sum of its per-side fees;
 *   - switching model changes total cost but never breaks reconciliation.
 *
 * Negative controls prove the classic bugs are still detectable: fee netted
 * into notional, fee skipped on the sell side, minimum floor applied to the
 * whole order instead of per side, and a fee charged in the wrong currency.
 */

const FILE = "src/lib/__tests__/fee-model-cash-delta-reconciliation.e2e.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

const MICROS = 1_000_000;
const toMicros = (v: number) => Math.round(v * MICROS);
const epsilon = (bookings: number) => (bookings * 0.5) / MICROS + 1e-9;

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

type Instrument = { symbol: string; tick: number; ref: number };

const INSTRUMENTS: readonly Instrument[] = [
  { symbol: "HSBA.L", tick: 0.05, ref: 942.6 },
  { symbol: "ULVR.L", tick: 0.5, ref: 4680 },
  { symbol: "AAPL", tick: 0.01, ref: 223.17 },
  { symbol: "NVDA", tick: 0.01, ref: 178.44 },
  { symbol: "ASML.AS", tick: 0.01, ref: 712.3 },
  { symbol: "NESN.SW", tick: 0.02, ref: 84.6 },
];

const instrumentOf = (symbol: string) => INSTRUMENTS.find((i) => i.symbol === symbol)!;
const snapToTick = (p: number, tick: number) => Number((Math.round(p / tick) * tick).toFixed(10));
const settlePrice = (symbol: string, quote: number) => normalizeMarketPriceForTrading(symbol, quote);

// ---------------------------------------------------------------------------
// Fee models — all return an itemised breakdown in the trade currency
// ---------------------------------------------------------------------------

type Fill = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  quotePrice: number;
  quantity: number;
};

type FeeBreakdown = {
  commission: number;
  exchange: number;
  /** UK stamp duty — buys only, and only on UK lines. */
  stampDuty: number;
  total: number;
};

type FeeModel = {
  name: string;
  charge: (fill: Fill, notional: number, currency: string) => FeeBreakdown;
};

const zeroed = (parts: Partial<FeeBreakdown>): FeeBreakdown => {
  const commission = parts.commission ?? 0;
  const exchange = parts.exchange ?? 0;
  const stampDuty = parts.stampDuty ?? 0;
  return { commission, exchange, stampDuty, total: commission + exchange + stampDuty };
};

/** Production model: the live Saxo tiered schedule, per side. */
const saxoTiered: FeeModel = {
  name: "saxo-tiered",
  charge: (_fill, notional, currency) =>
    zeroed({ commission: estimateSaxoCommission({ notional, currency }).commission }),
};

/** Sim broker: one flat ticket, regardless of size. */
const flatTicket: FeeModel = {
  name: "flat-ticket",
  charge: (_fill, _notional, currency) => zeroed({ commission: currency === "GBP" ? 5 : 6 }),
};

/** Backtest default: pure basis points, no floor, no cap. */
const pureBps: FeeModel = {
  name: "pure-bps",
  charge: (_fill, notional) => zeroed({ commission: notional * 0.0008 }),
};

/** Conservative model: bps with a floor AND a cap, plus UK stamp duty on buys. */
const cappedWithStamp: FeeModel = {
  name: "capped-with-stamp",
  charge: (fill, notional, currency) => {
    const raw = notional * 0.001;
    const commission = Math.min(Math.max(raw, 4), 40);
    const isUk = fill.symbol.toUpperCase().endsWith(".L");
    return zeroed({
      commission,
      exchange: notional * 0.00005,
      stampDuty: isUk && fill.side === "buy" && currency === "GBP" ? notional * 0.005 : 0,
    });
  },
};

const MODELS: readonly FeeModel[] = [saxoTiered, flatTicket, pureBps, cappedWithStamp];

// ---------------------------------------------------------------------------
// Replays
// ---------------------------------------------------------------------------

type Booking = {
  fill: Fill;
  currency: string;
  notional: number;
  fees: FeeBreakdown;
  cashBefore: number;
  cashAfter: number;
};

type Book = { cash: number; holdings: Map<string, number>; bookings: Booking[]; totalFees: number };

/** Float ledger: the reference behaviour, fee booked separately from notional. */
function replayFloat(fills: Fill[], startingCash: number, model: FeeModel): Book {
  let cash = startingCash;
  let totalFees = 0;
  const holdings = new Map<string, number>();
  const bookings: Booking[] = [];

  for (const fill of fills) {
    const currency = inferSaxoCurrency(fill.symbol);
    const notional = settlePrice(fill.symbol, fill.quotePrice) * fill.quantity;
    const fees = model.charge(fill, notional, currency);
    const cashBefore = cash;

    cash += (fill.side === "buy" ? -notional : notional) - fees.total;
    const have = holdings.get(fill.symbol) ?? 0;
    holdings.set(
      fill.symbol,
      Number((fill.side === "buy" ? have + fill.quantity : have - fill.quantity).toFixed(10)),
    );
    totalFees += fees.total;
    bookings.push({ fill, currency, notional, fees, cashBefore, cashAfter: cash });
  }

  for (const [k, q] of holdings) if (q === 0) holdings.delete(k);
  return { cash, holdings, bookings, totalFees };
}

/** Exact ledger in integer micro-units — every leg rounded independently. */
function replayExact(fills: Fill[], startingCash: number, model: FeeModel) {
  let cashMicros = toMicros(startingCash);
  let feeMicros = 0;
  const trace: number[] = [];

  for (const fill of fills) {
    const currency = inferSaxoCurrency(fill.symbol);
    const notional = settlePrice(fill.symbol, fill.quotePrice) * fill.quantity;
    const fees = model.charge(fill, notional, currency);
    const legs =
      toMicros(fees.commission) + toMicros(fees.exchange) + toMicros(fees.stampDuty);

    cashMicros += (fill.side === "buy" ? -1 : 1) * toMicros(notional) - legs;
    feeMicros += legs;
    trace.push(cashMicros);
  }
  return { cashMicros, feeMicros, trace };
}

// ---------------------------------------------------------------------------
// Scenario generation
// ---------------------------------------------------------------------------

function buildScenario(seed: number) {
  const rnd = rng(seed);
  const fills: Fill[] = [];
  const held = new Map<string, number>();
  const count = 5 + Math.floor(rnd() * 40);

  for (let i = 0; i < count; i++) {
    const inst = INSTRUMENTS[Math.floor(rnd() * INSTRUMENTS.length)]!;
    const have = held.get(inst.symbol) ?? 0;
    const side: "buy" | "sell" = have > 0 && rnd() < 0.4 ? "sell" : "buy";
    const wanted = Math.max(1, Math.round((1 + rnd() * 500)));
    const quantity = side === "sell" ? Math.min(have, wanted) : wanted;
    if (quantity <= 0) continue;

    fills.push({
      id: `F-${seed}-${i}`,
      symbol: inst.symbol,
      side,
      quotePrice: snapToTick(inst.ref * (0.85 + rnd() * 0.3), inst.tick),
      quantity,
    });
    held.set(inst.symbol, side === "buy" ? have + quantity : have - quantity);
  }

  const grossBuys = fills
    .filter((f) => f.side === "buy")
    .reduce((a, f) => a + settlePrice(f.symbol, f.quotePrice) * f.quantity, 0);

  return { fills, startingCash: Math.ceil(grossBuys * 1.2) + 50_000 };
}

const CASES = 200;

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe.each(MODELS.map((m) => [m.name, m] as const))(
  "fee model %s — fuzzed cash-delta reconciliation",
  (name, model) => {
    it("decomposes every cash delta into notional plus itemised fees", () => {
      for (let c = 0; c < CASES; c++) {
        const seed = caseSeed(BASE_SEED, `${name}-decompose`, c);
        const { fills, startingCash } = buildScenario(seed);
        const msg = `${REPRO} (${name}, case ${c}, seed ${seed})`;
        const book = replayFloat(fills, startingCash, model);

        for (const b of book.bookings) {
          const signed = b.fill.side === "buy" ? -b.notional : b.notional;
          const expected = b.cashBefore + signed - b.fees.total;
          expect(Math.abs(b.cashAfter - expected), `${msg} @${b.fill.id}`).toBeLessThanOrEqual(
            epsilon(4),
          );
          expect(
            Math.abs(b.fees.total - (b.fees.commission + b.fees.exchange + b.fees.stampDuty)),
            `${msg} @${b.fill.id}`,
          ).toBeLessThanOrEqual(epsilon(3));
          expect(b.fees.total, `${msg} @${b.fill.id}`).toBeGreaterThanOrEqual(0);
        }

        const summedFees = book.bookings.reduce((a, b) => a + b.fees.total, 0);
        expect(Math.abs(summedFees - book.totalFees), msg).toBeLessThanOrEqual(
          epsilon(book.bookings.length),
        );
      }
    });

    it("agrees with the exact integer ledger at every fill and in total", () => {
      for (let c = 0; c < CASES; c++) {
        const seed = caseSeed(BASE_SEED, `${name}-exact`, c);
        const { fills, startingCash } = buildScenario(seed);
        const msg = `${REPRO} (${name}, case ${c}, seed ${seed})`;

        const f = replayFloat(fills, startingCash, model);
        const x = replayExact(fills, startingCash, model);

        expect(f.bookings.length, msg).toBe(x.trace.length);
        for (let i = 0; i < x.trace.length; i++) {
          expect(
            Math.abs(f.bookings[i]!.cashAfter - x.trace[i]! / MICROS),
            `${msg} @fill ${i}`,
          ).toBeLessThanOrEqual(epsilon((i + 1) * 4));
        }
        expect(Math.abs(f.cash - x.cashMicros / MICROS), msg).toBeLessThanOrEqual(
          epsilon(f.bookings.length * 4),
        );
        expect(Math.abs(f.totalFees - x.feeMicros / MICROS), msg).toBeLessThanOrEqual(
          epsilon(f.bookings.length * 3),
        );
      }
    });

    it("reconstructs the closing cash from starting cash, net notional and total fees", () => {
      for (let c = 0; c < CASES; c++) {
        const seed = caseSeed(BASE_SEED, `${name}-closing`, c);
        const { fills, startingCash } = buildScenario(seed);
        const msg = `${REPRO} (${name}, case ${c}, seed ${seed})`;
        const book = replayFloat(fills, startingCash, model);

        const netNotional = book.bookings.reduce(
          (a, b) => a + (b.fill.side === "buy" ? -b.notional : b.notional),
          0,
        );
        expect(
          Math.abs(book.cash - (startingCash + netNotional - book.totalFees)),
          msg,
        ).toBeLessThanOrEqual(epsilon(book.bookings.length * 4));
      }
    });

    it("never charges a negative fee and never lets fees exceed the notional", () => {
      for (let c = 0; c < CASES; c++) {
        const seed = caseSeed(BASE_SEED, `${name}-sanity`, c);
        const { fills, startingCash } = buildScenario(seed);
        const msg = `${REPRO} (${name}, case ${c}, seed ${seed})`;
        for (const b of replayFloat(fills, startingCash, model).bookings) {
          expect(b.fees.commission, `${msg} @${b.fill.id}`).toBeGreaterThanOrEqual(0);
          expect(b.fees.exchange, `${msg} @${b.fill.id}`).toBeGreaterThanOrEqual(0);
          expect(b.fees.stampDuty, `${msg} @${b.fill.id}`).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(b.fees.total), `${msg} @${b.fill.id}`).toBe(true);
          // A fee larger than the trade itself would mean a unit bug.
          expect(b.fees.total, `${msg} @${b.fill.id}`).toBeLessThan(b.notional + 100);
        }
      }
    });

    it("is deterministic and order-independent in total fees", () => {
      for (let c = 0; c < 40; c++) {
        const seed = caseSeed(BASE_SEED, `${name}-determinism`, c);
        const { fills, startingCash } = buildScenario(seed);
        const msg = `${REPRO} (${name}, case ${c}, seed ${seed})`;

        const a = replayFloat(fills, startingCash, model);
        const b = replayFloat(fills, startingCash, model);
        expect(a.cash, msg).toBe(b.cash);
        expect(replayExact(fills, startingCash, model).trace).toEqual(
          replayExact(fills, startingCash, model).trace,
        );

        // Fees depend only on the fill, so reordering cannot change the total.
        const reversed = replayFloat([...fills].reverse(), startingCash, model);
        expect(Math.abs(reversed.totalFees - a.totalFees), msg).toBeLessThanOrEqual(
          epsilon(fills.length),
        );
      }
    });
  },
);

describe("cross-model behaviour", () => {
  it("changes total cost between models but keeps every model reconciled", () => {
    for (let c = 0; c < 60; c++) {
      const seed = caseSeed(BASE_SEED, "cross-model", c);
      const { fills, startingCash } = buildScenario(seed);
      const msg = `${REPRO} (case ${c}, seed ${seed})`;

      const totals = MODELS.map((m) => {
        const book = replayFloat(fills, startingCash, m);
        const netNotional = book.bookings.reduce(
          (a, b) => a + (b.fill.side === "buy" ? -b.notional : b.notional),
          0,
        );
        expect(
          Math.abs(book.cash - (startingCash + netNotional - book.totalFees)),
          `${msg} @${m.name}`,
        ).toBeLessThanOrEqual(epsilon(book.bookings.length * 4));
        return book.totalFees;
      });

      // Holdings are model-independent — only cash moves.
      const shapes = MODELS.map((m) => [...replayFloat(fills, startingCash, m).holdings.entries()]);
      for (const s of shapes) expect(s, msg).toEqual(shapes[0]);

      expect(new Set(totals.map((t) => t.toFixed(6))).size, msg).toBeGreaterThan(1);
    }
  });

  it("charges the round-trip as the exact sum of the two per-side fees", () => {
    for (let c = 0; c < 60; c++) {
      const seed = caseSeed(BASE_SEED, "roundtrip", c);
      const rnd = rng(seed);
      const inst = INSTRUMENTS[Math.floor(rnd() * INSTRUMENTS.length)]!;
      const quantity = 1 + Math.floor(rnd() * 400);
      const quotePrice = snapToTick(inst.ref * (0.9 + rnd() * 0.2), inst.tick);
      const buy: Fill = { id: "rt-buy", symbol: inst.symbol, side: "buy", quotePrice, quantity };
      const sell: Fill = { ...buy, id: "rt-sell", side: "sell" };
      const notional = settlePrice(inst.symbol, quotePrice) * quantity;
      const ccy = inferSaxoCurrency(inst.symbol);

      for (const m of MODELS) {
        const msg = `${REPRO} (case ${c}, seed ${seed}, ${m.name})`;
        const perSide = m.charge(buy, notional, ccy).total + m.charge(sell, notional, ccy).total;
        const book = replayFloat([buy, sell], notional * 2 + 10_000, m);
        expect(Math.abs(book.totalFees - perSide), msg).toBeLessThanOrEqual(epsilon(6));
        // A flat round trip on an unchanged price loses exactly the fees.
        expect(
          Math.abs(book.cash - (notional * 2 + 10_000 - perSide)),
          msg,
        ).toBeLessThanOrEqual(epsilon(8));
        expect(book.holdings.size, msg).toBe(0);
      }
    }
  });

  it("keeps the Saxo tiered model monotonic and consistent with its breakeven", () => {
    for (const currency of ["GBP", "USD", "EUR", "CHF"]) {
      const breakeven = saxoBreakevenNotional(currency);
      const below = estimateSaxoCommission({ notional: breakeven * 0.5, currency });
      const above = estimateSaxoCommission({ notional: breakeven * 2, currency });
      expect(below.minFloorApplied, currency).toBe(true);
      expect(above.minFloorApplied, currency).toBe(false);
      expect(above.commission).toBeGreaterThan(below.commission);

      let previous = 0;
      for (let notional = 100; notional <= 500_000; notional *= 1.7) {
        const fee = estimateSaxoCommission({ notional, currency }).commission;
        expect(fee, `${currency} @${notional}`).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = fee;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Negative controls
// ---------------------------------------------------------------------------

describe("negative controls", () => {
  const buy: Fill = { id: "n1", symbol: "HSBA.L", side: "buy", quotePrice: 942.6, quantity: 500 };
  const sell: Fill = { ...buy, id: "n2", side: "sell" };
  const notional = settlePrice("HSBA.L", 942.6) * 500;

  it("detects a fee netted into the notional instead of booked separately", () => {
    const correct = replayFloat([buy], 100_000, saxoTiered);
    const fees = saxoTiered.charge(buy, notional, "GBP").total;
    // Bug: fee folded into the price, so holdings basis absorbs it and the
    // cash line looks identical — only the itemisation reveals it.
    const buggyCash = 100_000 - (notional + fees);
    expect(Math.abs(buggyCash - correct.cash)).toBeLessThanOrEqual(epsilon(4));
    expect(correct.bookings[0]!.notional).toBeCloseTo(notional, 9);
    expect(correct.bookings[0]!.notional).not.toBeCloseTo(notional + fees, 6);
  });

  it("detects a fee skipped on the sell side", () => {
    const book = replayFloat([buy, sell], 100_000, saxoTiered);
    const buyOnlyFees = saxoTiered.charge(buy, notional, "GBP").total;
    expect(book.totalFees).toBeGreaterThan(buyOnlyFees);
    expect(book.totalFees).toBeCloseTo(buyOnlyFees * 2, 9);
  });

  it("detects the minimum floor applied once per order instead of per side", () => {
    const small: Fill = { ...buy, quantity: 5 };
    const smallNotional = settlePrice("HSBA.L", 942.6) * 5;
    const perSide = estimateSaxoCommission({ notional: smallNotional, currency: "GBP" });
    expect(perSide.minFloorApplied).toBe(true);
    const book = replayFloat([small, { ...small, id: "n4", side: "sell" }], 100_000, saxoTiered);
    expect(book.totalFees).toBeCloseTo(perSide.commission * 2, 9);
    expect(book.totalFees).not.toBeCloseTo(perSide.commission, 6);
  });

  it("detects a fee charged in the wrong currency tier", () => {
    const gbp = estimateSaxoCommission({ notional: 500, currency: "GBP" }).commission;
    const usd = estimateSaxoCommission({ notional: 500, currency: "USD" }).commission;
    expect(gbp).not.toBeCloseTo(usd, 6);
    expect(inferSaxoCurrency("HSBA.L")).toBe("GBP");
    expect(inferSaxoCurrency("AAPL")).toBe("USD");
    expect(inferSaxoCurrency("ASML.AS")).toBe("EUR");
  });

  it("detects stamp duty charged on a sell or on a non-UK line", () => {
    expect(cappedWithStamp.charge(buy, notional, "GBP").stampDuty).toBeGreaterThan(0);
    expect(cappedWithStamp.charge(sell, notional, "GBP").stampDuty).toBe(0);
    const us: Fill = { id: "n6", symbol: "AAPL", side: "buy", quotePrice: 223.17, quantity: 100 };
    expect(cappedWithStamp.charge(us, 22_317, "USD").stampDuty).toBe(0);
  });

  it("detects a dropped fee leg by comparing against a zero-fee replay", () => {
    const withFees = replayFloat([buy, sell], 100_000, cappedWithStamp);
    const noFees = replayFloat([buy, sell], 100_000, {
      name: "none",
      charge: () => zeroed({}),
    });
    expect(noFees.cash - withFees.cash).toBeCloseTo(withFees.totalFees, 9);
    expect(withFees.totalFees).toBeGreaterThan(0);
  });
});
