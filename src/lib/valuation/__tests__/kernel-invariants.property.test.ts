// Property tests: the arithmetic identities the kernel must never break,
// across randomly generated portfolios.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { computeValuation } from "../kernel";

const FC_SEED = 20260801;
const CCYS = ["GBP", "USD", "EUR", "JPY"] as const;

const rate = (from: string, to: string) => {
  if (from === to) return 1;
  const table: Record<string, number> = { GBP: 1, USD: 0.79, EUR: 0.85, JPY: 0.0052 };
  const f = table[from];
  const t = table[to];
  return f && t ? f / t : null;
};

const holdingArb = fc.record({
  symbol: fc.constantFrom("AAPL", "MSFT", "MKS.L", "SAP.DE", "7203.T"),
  quantity: fc.double({ min: -500, max: 500, noNaN: true, noDefaultInfinity: true }),
  avg_cost: fc.double({ min: 0.01, max: 5000, noNaN: true, noDefaultInfinity: true }),
  instrument_ccy: fc.constantFrom(...CCYS),
});

const inputArb = fc.record({
  holdings: fc.array(holdingArb, { maxLength: 12 }),
  wallet: fc.dictionary(
    fc.constantFrom(...CCYS),
    fc.double({ min: -10_000, max: 100_000, noNaN: true, noDefaultInfinity: true }),
    { maxKeys: 4 },
  ),
  baseCcy: fc.constantFrom(...CCYS),
  prices: fc.dictionary(
    fc.constantFrom("AAPL", "MSFT", "MKS.L", "SAP.DE", "7203.T"),
    fc.double({ min: 0.01, max: 10_000, noNaN: true, noDefaultInfinity: true }),
    { maxKeys: 5 },
  ),
});

describe("valuation kernel — properties", () => {
  it("total always equals cash + holdings, and is always finite", () => {
    fc.assert(
      fc.property(inputArb, (i) => {
        const res = computeValuation({
          holdings: i.holdings,
          wallet: i.wallet,
          baseCcy: i.baseCcy,
          price: (s) => i.prices[s] ?? null,
          fx: rate,
        });
        expect(Number.isFinite(res.totalValue)).toBe(true);
        expect(Number.isFinite(res.cash)).toBe(true);
        expect(Number.isFinite(res.holdingsValue)).toBe(true);
        // The kernel rounds each component to 2dp, so the identity holds to
        // the cent rather than to the bit.
        expect(Math.abs(res.totalValue - (res.cash + res.holdingsValue))).toBeLessThanOrEqual(0.011);
      }),
      { seed: FC_SEED, numRuns: 300 },
    );
  });

  it("every holding produces exactly one provenance line", () => {
    fc.assert(
      fc.property(inputArb, (i) => {
        const res = computeValuation({
          holdings: i.holdings,
          wallet: i.wallet,
          baseCcy: i.baseCcy,
          price: (s) => i.prices[s] ?? null,
          fx: rate,
        });
        // Zero-quantity rows contribute nothing and are dropped; every other
        // holding must be explainable by exactly one provenance line.
        const priced = i.holdings.filter((h) => h.quantity !== 0);
        expect(res.provenance.lines).toHaveLength(priced.length);
      }),
      { seed: FC_SEED, numRuns: 200 },
    );
  });

  it("valuing in the base currency is scale-consistent with the FX rate", () => {
    fc.assert(
      fc.property(inputArb, (i) => {
        const gbp = computeValuation({
          holdings: i.holdings,
          wallet: i.wallet,
          baseCcy: "GBP",
          price: (s) => i.prices[s] ?? null,
          fx: rate,
        });
        const usd = computeValuation({
          holdings: i.holdings,
          wallet: i.wallet,
          baseCcy: "USD",
          price: (s) => i.prices[s] ?? null,
          fx: rate,
        });
        // GBP total converted into USD must match the USD-based total.
        const expected = gbp.totalValue * rate("GBP", "USD")!;
        // Each line and wallet leg is rounded to 2dp in BOTH valuations, so the
        // permitted gap scales with the number of rounded components.
        const legs = i.holdings.length + Object.keys(i.wallet).length + 2;
        const tolerance = Math.max(0.02 * legs, Math.abs(expected) * 1e-6);
        expect(Math.abs(usd.totalValue - expected)).toBeLessThanOrEqual(tolerance);
      }),
      { seed: FC_SEED, numRuns: 200 },
    );
  });

  it("is deterministic — the same input always yields the same total", () => {
    fc.assert(
      fc.property(inputArb, (i) => {
        const call = () =>
          computeValuation({
            holdings: i.holdings,
            wallet: i.wallet,
            baseCcy: i.baseCcy,
            price: (s) => i.prices[s] ?? null,
            fx: rate,
            asOf: "2026-08-01T00:00:00.000Z",
          });
        expect(call().totalValue).toBe(call().totalValue);
      }),
      { seed: FC_SEED, numRuns: 150 },
    );
  });

  it("a doubled book is worth exactly twice as much", () => {
    fc.assert(
      fc.property(inputArb, (i) => {
        const base = computeValuation({
          holdings: i.holdings,
          wallet: {},
          baseCcy: i.baseCcy,
          price: (s) => i.prices[s] ?? null,
          fx: rate,
        });
        const doubled = computeValuation({
          holdings: i.holdings.map((h) => ({ ...h, quantity: h.quantity * 2 })),
          wallet: {},
          baseCcy: i.baseCcy,
          price: (s) => i.prices[s] ?? null,
          fx: rate,
        });
        const expected = base.holdingsValue * 2;
        const tolerance = Math.max(0.02 * (i.holdings.length + 2), Math.abs(expected) * 1e-6);
        expect(Math.abs(doubled.holdingsValue - expected)).toBeLessThanOrEqual(tolerance);
      }),
      { seed: FC_SEED, numRuns: 200 },
    );
  });
});
