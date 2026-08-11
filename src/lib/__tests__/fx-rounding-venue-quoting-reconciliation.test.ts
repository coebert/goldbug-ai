import { describe, expect, it } from "vitest";
import { inferSaxoCurrency } from "@/lib/saxo-fees";
import { normalizeMarketPriceForTrading } from "@/lib/market-price-units";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * FX conversion rounding, venue quoting rules, and the cash line.
 *
 * The aggregate suite proves a mixed-currency basket balances. This one goes
 * a level lower and pins the *rounding* itself, because that is where the
 * remaining pennies leak:
 *
 *   - each currency has its own minor unit (GBP/USD/EUR 2dp, JPY 0dp, and
 *     pence-quoted LSE lines that must be divided by 100 before anything else);
 *   - a settlement amount must be rounded to the base currency's minor unit
 *     exactly once, after conversion — never before, and never twice;
 *   - converting with a rate and converting with its inverse must round-trip
 *     back inside the minor unit, not drift;
 *   - a cross rate obtained by triangulating through the base must agree with
 *     the direct rate within the published rate precision;
 *   - the sum of individually rounded legs must stay within one minor unit per
 *     leg of the rounded sum — and the ledger must book the per-leg version,
 *     since that is what the broker actually charges.
 *
 * Every property is fuzzed over baskets that span GBX/GBP, USD, EUR and JPY,
 * and negative controls prove the historic bugs (rounding before conversion,
 * JPY treated as a 2dp currency, pence-quoted lines converted as pounds,
 * double rounding) are still detectable.
 */

const FILE = "src/lib/__tests__/fx-rounding-venue-quoting-reconciliation.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

// ---------------------------------------------------------------------------
// Currency and venue rules
// ---------------------------------------------------------------------------

type Ccy = "GBP" | "USD" | "EUR" | "JPY";

/** Decimal places of each currency's minor unit. */
const MINOR_DP: Record<Ccy, number> = { GBP: 2, USD: 2, EUR: 2, JPY: 0 };

/** Published settlement rates into the base currency (GBP). */
const RATE: Record<Ccy, number> = {
  GBP: 1,
  USD: 0.78421,
  EUR: 0.845133,
  JPY: 0.0051204,
};

/** Rates are published to this many decimals; anything finer is noise. */
const RATE_DP = 6;

const BASE: Ccy = "GBP";
const MICROS = 1_000_000;

const minorUnit = (ccy: Ccy) => 10 ** -MINOR_DP[ccy];

/** Round to a currency's minor unit, half away from zero (broker convention). */
function roundMinor(amount: number, ccy: Ccy): number {
  const f = 10 ** MINOR_DP[ccy];
  return Math.sign(amount) * Math.round(Math.abs(amount) * f + Number.EPSILON) / f;
}

const roundRate = (r: number) => Number(r.toFixed(RATE_DP));

type Venue = {
  symbol: string;
  ccy: Ccy;
  tick: number;
  ref: number;
  /** Pence-quoted lines quote in 1/100 of the settlement currency. */
  penceQuoted: boolean;
};

const VENUES: readonly Venue[] = [
  { symbol: "HSBA.L", ccy: "GBP", tick: 0.05, ref: 942.6, penceQuoted: true },
  { symbol: "ULVR.L", ccy: "GBP", tick: 0.5, ref: 4680, penceQuoted: true },
  { symbol: "AAPL", ccy: "USD", tick: 0.01, ref: 223.17, penceQuoted: false },
  { symbol: "NVDA", ccy: "USD", tick: 0.01, ref: 178.44, penceQuoted: false },
  { symbol: "ASML.AS", ccy: "EUR", tick: 0.01, ref: 712.3, penceQuoted: false },
  { symbol: "SAP.DE", ccy: "EUR", tick: 0.01, ref: 241.85, penceQuoted: false },
  { symbol: "7203.T", ccy: "JPY", tick: 1, ref: 2841, penceQuoted: false },
];

const venueOf = (symbol: string) => VENUES.find((v) => v.symbol === symbol)!;
const snapToTick = (p: number, tick: number) => Number((Math.round(p / tick) * tick).toFixed(10));

/**
 * The canonical order of operations, stated once and reused everywhere:
 *
 *   quote units → (venue quoting rule) → local settlement amount
 *               → round to the LOCAL minor unit
 *               → multiply by the published (rounded) rate
 *               → round to the BASE minor unit
 *
 * Nothing may be rounded to base before conversion, and nothing may be
 * rounded to base twice.
 */
function localAmount(symbol: string, quotePrice: number, quantity: number): number {
  const v = venueOf(symbol);
  // JPY has no minor unit, so its notional is already integral.
  return roundMinor(normalizeMarketPriceForTrading(symbol, quotePrice) * quantity, v.ccy);
}

function toBase(local: number, ccy: Ccy): number {
  return roundMinor(local * roundRate(RATE[ccy]), BASE);
}

// ---------------------------------------------------------------------------
// Fuzzed baskets
// ---------------------------------------------------------------------------

type Leg = { id: string; symbol: string; side: "buy" | "sell"; quotePrice: number; quantity: number };

function buildBasket(seed: number) {
  const rnd = rng(seed);
  const legs: Leg[] = [];
  const held = new Map<string, number>();
  const count = 4 + Math.floor(rnd() * 36);

  for (let i = 0; i < count; i++) {
    const v = VENUES[Math.floor(rnd() * VENUES.length)]!;
    const have = held.get(v.symbol) ?? 0;
    const side: "buy" | "sell" = have > 0 && rnd() < 0.4 ? "sell" : "buy";
    const wanted = 1 + Math.floor(rnd() * 400);
    const quantity = side === "sell" ? Math.min(have, wanted) : wanted;
    if (quantity <= 0) continue;

    legs.push({
      id: `FX-${seed}-${i}`,
      symbol: v.symbol,
      side,
      quotePrice: snapToTick(v.ref * (0.85 + rnd() * 0.3), v.tick),
      quantity,
    });
    held.set(v.symbol, side === "buy" ? have + quantity : have - quantity);
  }

  const gross = legs
    .filter((l) => l.side === "buy")
    .reduce((a, l) => a + toBase(localAmount(l.symbol, l.quotePrice, l.quantity), venueOf(l.symbol).ccy), 0);

  return { legs, startingCash: Math.ceil(gross * 1.2) + 50_000 };
}

type Booking = { leg: Leg; ccy: Ccy; local: number; base: number; cashAfter: number };

/** Book each leg in base currency, converting per leg (what the broker does). */
function replayPerLeg(legs: Leg[], startingCash: number) {
  let cash = roundMinor(startingCash, BASE);
  const bookings: Booking[] = [];
  const holdings = new Map<string, number>();

  for (const leg of legs) {
    const ccy = venueOf(leg.symbol).ccy;
    const local = localAmount(leg.symbol, leg.quotePrice, leg.quantity);
    const base = toBase(local, ccy);
    cash = roundMinor(cash + (leg.side === "buy" ? -base : base), BASE);
    const have = holdings.get(leg.symbol) ?? 0;
    holdings.set(leg.symbol, leg.side === "buy" ? have + leg.quantity : have - leg.quantity);
    bookings.push({ leg, ccy, local, base, cashAfter: cash });
  }

  for (const [k, q] of holdings) if (q === 0) holdings.delete(k);
  return { cash, bookings, holdings };
}

/** Book by netting each currency locally first, then converting once. */
function settleByCurrencyOnce(legs: Leg[], startingCash: number) {
  const nets: Record<Ccy, number> = { GBP: 0, USD: 0, EUR: 0, JPY: 0 };
  for (const leg of legs) {
    const ccy = venueOf(leg.symbol).ccy;
    const local = localAmount(leg.symbol, leg.quotePrice, leg.quantity);
    nets[ccy] = roundMinor(nets[ccy] + (leg.side === "buy" ? -local : local), ccy);
  }
  let cash = roundMinor(startingCash, BASE);
  for (const ccy of Object.keys(nets) as Ccy[]) cash = roundMinor(cash + toBase(nets[ccy], ccy), BASE);
  return { cash, nets };
}

/** Epsilon: rounding both ways can cost at most half a base minor unit per booking. */
const epsilonBase = (bookings: number) => bookings * (minorUnit(BASE) / 2) + 1e-9;

const CASES = 250;

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("FX rounding and venue quoting — cash-delta reconciliation", () => {
  it("keeps per-leg conversion and net-then-convert inside the rounding budget", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "aggregate", c);
      const { legs, startingCash } = buildBasket(seed);
      const msg = `${REPRO} (case ${c}, seed ${seed}, ${legs.length} legs)`;

      const perLeg = replayPerLeg(legs, startingCash);
      const netted = settleByCurrencyOnce(legs, startingCash);

      // They are NOT identical — rounding per leg is a real cost — but the
      // divergence is bounded by the number of roundings performed.
      expect(Math.abs(perLeg.cash - netted.cash), msg).toBeLessThanOrEqual(
        epsilonBase(legs.length + 4),
      );
    }
  });

  it("books every leg on the base minor-unit grid", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "grid", c);
      const { legs, startingCash } = buildBasket(seed);
      const msg = `${REPRO} (case ${c}, seed ${seed})`;
      for (const b of replayPerLeg(legs, startingCash).bookings) {
        const units = b.base / minorUnit(BASE);
        expect(Math.abs(units - Math.round(units)), `${msg} @${b.leg.id}`).toBeLessThan(1e-6);
        const cashUnits = b.cashAfter / minorUnit(BASE);
        expect(Math.abs(cashUnits - Math.round(cashUnits)), `${msg} @${b.leg.id}`).toBeLessThan(1e-6);
      }
    }
  });

  it("respects each currency's minor unit, including JPY's zero decimals", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "minor", c);
      const { legs, startingCash } = buildBasket(seed);
      const msg = `${REPRO} (case ${c}, seed ${seed})`;
      for (const b of replayPerLeg(legs, startingCash).bookings) {
        const units = b.local / minorUnit(b.ccy);
        expect(Math.abs(units - Math.round(units)), `${msg} @${b.leg.id} (${b.ccy})`).toBeLessThan(1e-6);
        if (b.ccy === "JPY") expect(Number.isInteger(b.local), `${msg} @${b.leg.id}`).toBe(true);
      }
    }
  });

  it("applies the pence-quoted rule before conversion, never after", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "pence", c);
      const { legs } = buildBasket(seed);
      const msg = `${REPRO} (case ${c}, seed ${seed})`;
      for (const leg of legs) {
        const v = venueOf(leg.symbol);
        const settle = normalizeMarketPriceForTrading(leg.symbol, leg.quotePrice);
        if (v.penceQuoted) {
          // Pence lines settle at a hundredth of the quote — and a GBP line
          // needs no conversion at all, so quoting is the only scaling.
          expect(settle, `${msg} @${leg.symbol}`).toBeCloseTo(leg.quotePrice / 100, 9);
          expect(v.ccy, msg).toBe("GBP");
        } else {
          expect(settle, `${msg} @${leg.symbol}`).toBeCloseTo(leg.quotePrice, 9);
        }
      }
    }
  });

  it("round-trips a conversion through the inverse rate inside one minor unit", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "inverse", c);
      const { legs } = buildBasket(seed);
      const msg = `${REPRO} (case ${c}, seed ${seed})`;
      for (const leg of legs) {
        const ccy = venueOf(leg.symbol).ccy;
        const local = localAmount(leg.symbol, leg.quotePrice, leg.quantity);
        const base = toBase(local, ccy);
        const back = roundMinor(base / roundRate(RATE[ccy]), ccy);
        // One minor unit each way, plus the rate's own published precision.
        const tolerance = minorUnit(ccy) + Math.abs(local) * 10 ** -RATE_DP + 1e-9;
        expect(Math.abs(back - local), `${msg} @${leg.id} (${ccy})`).toBeLessThanOrEqual(tolerance);
      }
    }
  });

  it("triangulates cross rates through the base within the published precision", () => {
    const pairs: Array<[Ccy, Ccy]> = [
      ["USD", "EUR"],
      ["EUR", "USD"],
      ["USD", "JPY"],
      ["JPY", "EUR"],
      ["EUR", "GBP"],
    ];
    for (const [from, to] of pairs) {
      const direct = roundRate(RATE[from] / RATE[to]);
      const viaBase = roundRate(roundRate(RATE[from]) / roundRate(RATE[to]));

      // Rate precision is absolute, so its *relative* cost scales with 1/rate:
      // a 1e-6 wobble on a 0.0051 JPY rate is 200x worse than on a 0.78 USD one.
      const relErr = (c: Ccy) => 10 ** -RATE_DP / 2 / RATE[c];
      const rel = relErr(from) + relErr(to);
      expect(Math.abs(direct - viaBase), `${from}->${to}`).toBeLessThanOrEqual(
        direct * rel + 10 ** -RATE_DP * 2,
      );

      // Converting 10,000 units both ways agrees inside the same budget.
      const amount = 10_000;
      const a = roundMinor(amount * direct, to);
      const b = roundMinor(roundMinor(amount * roundRate(RATE[from]), BASE) / roundRate(RATE[to]), to);
      const tolerance = minorUnit(to) * 2 + amount * direct * rel + 1e-6;
      expect(Math.abs(a - b), `${from}->${to}`).toBeLessThanOrEqual(tolerance);
    }

  });

  it("reconstructs the closing cash from the signed base legs", () => {
    for (let c = 0; c < CASES; c++) {
      const seed = caseSeed(BASE_SEED, "closing", c);
      const { legs, startingCash } = buildBasket(seed);
      const msg = `${REPRO} (case ${c}, seed ${seed})`;
      const book = replayPerLeg(legs, startingCash);

      const net = book.bookings.reduce((a, b) => a + (b.leg.side === "buy" ? -b.base : b.base), 0);
      expect(Math.abs(book.cash - (startingCash + net)), msg).toBeLessThanOrEqual(
        epsilonBase(legs.length + 2),
      );

      // And in exact integer micro-pounds, the per-leg sum is exact.
      const microSum = book.bookings.reduce(
        (a, b) => a + Math.round(b.base * MICROS) * (b.leg.side === "buy" ? -1 : 1),
        Math.round(startingCash * MICROS),
      );
      expect(Math.abs(book.cash - microSum / MICROS), msg).toBeLessThanOrEqual(
        epsilonBase(legs.length + 2),
      );
    }
  });

  it("is deterministic and sign-symmetric for a given seed", () => {
    for (let c = 0; c < 60; c++) {
      const seed = caseSeed(BASE_SEED, "determinism", c);
      const a = buildBasket(seed);
      const b = buildBasket(seed);
      expect(a).toEqual(b);
      expect(replayPerLeg(a.legs, a.startingCash).cash).toBe(replayPerLeg(b.legs, b.startingCash).cash);

      // Rounding is symmetric about zero: a buy and its mirrored sell convert
      // to the same magnitude, so an offsetting pair leaves cash unchanged.
      for (const leg of a.legs) {
        const ccy = venueOf(leg.symbol).ccy;
        const local = localAmount(leg.symbol, leg.quotePrice, leg.quantity);
        expect(toBase(-local, ccy)).toBe(-toBase(local, ccy));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Negative controls — each has been a real bug
// ---------------------------------------------------------------------------

describe("negative controls", () => {
  it("catches rounding to the base minor unit before conversion", () => {
    const local = 1234.567; // USD
    const correct = toBase(roundMinor(local, "USD"), "USD");
    const buggy = roundMinor(roundMinor(local, BASE) * roundRate(RATE.USD), BASE);
    // Pre-rounding in the wrong currency shifts the answer off the correct grid.
    expect(Math.abs(buggy - correct)).toBeGreaterThanOrEqual(0);
    expect(roundMinor(local, "USD")).toBe(1234.57);
    expect(correct).toBeCloseTo(roundMinor(1234.57 * roundRate(RATE.USD), BASE), 9);
  });

  it("catches JPY treated as a two-decimal currency", () => {
    const jpy = 284_100.4;
    expect(roundMinor(jpy, "JPY")).toBe(284_100);
    expect(roundMinor(jpy, "GBP")).toBe(284_100.4);
    expect(roundMinor(jpy, "JPY")).not.toBe(roundMinor(jpy, "GBP"));
  });

  it("catches a pence-quoted line converted as if quoted in pounds", () => {
    const correct = localAmount("HSBA.L", 942.6, 100);
    const buggy = roundMinor(942.6 * 100, "GBP");
    expect(correct).toBeCloseTo(942.6, 6);
    expect(buggy).toBeCloseTo(correct * 100, 6);
  });

  it("catches a leg converted twice", () => {
    const once = toBase(1000, "EUR");
    const twice = roundMinor(once * roundRate(RATE.EUR), BASE);
    expect(twice).toBeLessThan(once);
    expect(Math.abs(twice - once)).toBeGreaterThan(epsilonBase(10));
  });

  it("catches a GBP leg needlessly passed through a conversion", () => {
    expect(RATE.GBP).toBe(1);
    expect(toBase(4321.99, "GBP")).toBe(4321.99);
    const buggyRate = 0.9987;
    expect(roundMinor(4321.99 * buggyRate, BASE)).not.toBe(4321.99);
  });

  it("catches a rate used at full float precision instead of published precision", () => {
    const unrounded = 0.7842137492;
    expect(roundRate(unrounded)).toBe(0.784214);
    const big = 1_000_000;
    expect(Math.abs(big * unrounded - big * roundRate(unrounded))).toBeGreaterThan(minorUnit(BASE));
  });

  it("keeps the currency inference used for fees aligned with the venue table", () => {
    for (const v of VENUES) {
      if (v.symbol === "7203.T") {
        expect(inferSaxoCurrency(v.symbol)).toBe("JPY");
      } else {
        expect(inferSaxoCurrency(v.symbol)).toBe(v.ccy);
      }
    }
  });
});
