// Combined integration matrix: liquidity caps × frictions.
//
// Verifies that when partial fills are produced by BOTH a market-volume
// cap AND realistic transaction frictions (commission, buy tax,
// fixed & per-unit slippage), the core execution invariants still hold:
//
//   * cash never goes negative (no borrowing)
//   * holdings quantities never go negative (no leverage / shorting)
//   * per-snapshot totals stay internally consistent
//   * a BUY never spends more than the prior step's cash
//
// A deterministic cartesian matrix locks the small canonical cases;
// a 300-run property test covers the long tail.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  simulateBrokerExecution,
  type Frictions,
  type SimDecision,
  type SimState,
  type SimulateOptions,
} from "@/lib/broker-simulator";
import { checkExecutionInvariants } from "@/lib/execution-invariants";

const start = (cash: number, holdings: SimState["holdings"] = []): SimState =>
  ({ cash, holdings });

const buy = (
  id: string,
  symbol: string,
  qty: number,
  price: number,
  availableVolume?: number,
): SimDecision => ({ id, symbol, side: "BUY", quantity: qty, price, availableVolume });

const sell = (
  id: string,
  symbol: string,
  qty: number,
  price: number,
  availableVolume?: number,
): SimDecision => ({ id, symbol, side: "SELL", quantity: qty, price, availableVolume });

const FRICTION_MATRIX: Array<{ name: string; frictions: Frictions }> = [
  { name: "frictionless", frictions: {} },
  { name: "commission-only", frictions: { commissionBps: 5, minCommission: 1 } },
  { name: "commission+buyTax", frictions: { commissionBps: 5, minCommission: 1, buyTaxBps: 50 } },
  { name: "fixed-slippage",   frictions: { slippageBps: 25 } },
  { name: "impact-slippage",  frictions: { impactPerUnit: 0.001 } },
  { name: "everything-on",    frictions: {
    commissionBps: 8, minCommission: 2, buyTaxBps: 50,
    slippageBps: 15, impactPerUnit: 0.0005,
  } },
];

const LIQUIDITY_MATRIX: Array<{ name: string; liquidity: SimulateOptions["liquidity"] }> = [
  { name: "no-cap", liquidity: undefined },
  { name: "hard-vol-cap", liquidity: { availableVolume: { ACME: 40 } } },
  { name: "participation-only", liquidity: { availableVolume: { ACME: 1_000 }, maxParticipationRate: 0.05 } },
  { name: "vol+participation", liquidity: { availableVolume: { ACME: 200 }, maxParticipationRate: 0.10 } },
];

describe("broker-simulator — liquidity × frictions matrix", () => {
  for (const f of FRICTION_MATRIX) {
    for (const l of LIQUIDITY_MATRIX) {
      it(`invariants hold: frictions=${f.name}, liquidity=${l.name}`, () => {
        const initial = start(5_000, [
          { symbol: "ACME", quantity: 25, avgCost: 10 },
        ]);
        const decisions: SimDecision[] = [
          // Big BUY that will be trimmed by liquidity and/or cash.
          buy("b1", "ACME", 500, 10),
          // SELL that a hard vol cap would trim below requested.
          sell("s1", "ACME", 80, 11),
          // Small BUY that most matrix cells should be able to fill fully.
          buy("b2", "ACME", 3, 10),
        ];
        const res = simulateBrokerExecution(initial, decisions, {
          frictions: f.frictions,
          liquidity: l.liquidity,
          markPrices: { ACME: 10 },
        });

        // Every decision produced either a snapshot or a rejection.
        for (const d of decisions) {
          const hit = res.snapshots.some((s) => s.decisionId === d.id)
            || res.rejections.some((r) => r.decisionId === d.id);
          expect(hit).toBe(true);
        }

        // Cash & holdings invariants — the point of the matrix.
        for (const s of res.snapshots) {
          expect(s.cash).toBeGreaterThanOrEqual(-1e-6);
          for (const h of s.holdings) {
            expect(h.quantity).toBeGreaterThanOrEqual(-1e-6);
          }
          // Partial flag matches the fill-vs-request comparison.
          const isPartial = s.fillQuantity < s.requestedQuantity - 1e-9;
          expect(s.partial).toBe(isPartial);
          if (s.partial) expect(s.truncationReason).not.toBeNull();
          else expect(s.truncationReason).toBeNull();
        }

        // Full invariant audit — this is the authoritative check.
        const report = checkExecutionInvariants({
          initial,
          decisions,
          snapshots: res.snapshots,
          rejections: res.rejections,
          markPrices: { ACME: 10 },
        });
        if (!report.ok) {
          throw new Error(
            `invariants failed for frictions=${f.name}, liquidity=${l.name}:\n`
            + report.violations.map((v) => `  ${v.code}: ${v.message}`).join("\n"),
          );
        }
      });
    }
  }

  it("fuzz: random liquidity + friction combinations preserve invariants", () => {
    const symbolArb = fc.constantFrom("ACME", "XYZ", "ZZZ");
    const decisionArb = fc.record({
      id: fc.string({ minLength: 1, maxLength: 6 }).filter((s) => s.trim().length > 0),
      symbol: symbolArb,
      side: fc.constantFrom<"BUY" | "SELL">("BUY", "SELL"),
      quantity: fc.double({ min: 0.1, max: 500, noNaN: true, noDefaultInfinity: true }),
      price: fc.double({ min: 1, max: 200, noNaN: true, noDefaultInfinity: true }),
      availableVolume: fc.option(
        fc.double({ min: 0.5, max: 400, noNaN: true, noDefaultInfinity: true }),
        { nil: undefined, freq: 3 },
      ),
    });

    const frictionsArb = fc.record({
      commissionBps: fc.double({ min: 0, max: 20, noNaN: true, noDefaultInfinity: true }),
      minCommission: fc.double({ min: 0, max: 3, noNaN: true, noDefaultInfinity: true }),
      buyTaxBps: fc.double({ min: 0, max: 60, noNaN: true, noDefaultInfinity: true }),
      slippageBps: fc.double({ min: 0, max: 30, noNaN: true, noDefaultInfinity: true }),
      impactPerUnit: fc.double({ min: 0, max: 0.002, noNaN: true, noDefaultInfinity: true }),
    });

    const liquidityArb = fc.record({
      participation: fc.double({ min: 0.01, max: 1, noNaN: true, noDefaultInfinity: true }),
      symbolCap: fc.double({ min: 1, max: 500, noNaN: true, noDefaultInfinity: true }),
      minFill: fc.double({ min: 0, max: 2, noNaN: true, noDefaultInfinity: true }),
    });

    fc.assert(
      fc.property(
        fc.double({ min: 100, max: 100_000, noNaN: true, noDefaultInfinity: true }),
        fc.array(decisionArb, { minLength: 1, maxLength: 25 }),
        frictionsArb,
        liquidityArb,
        (startingCash, rawDecs, frictions, liq) => {
          const seen = new Set<string>();
          const decisions: SimDecision[] = [];
          for (let i = 0; i < rawDecs.length; i += 1) {
            const d = { ...rawDecs[i], id: `${rawDecs[i].id}-${i}` };
            if (seen.has(d.id)) continue;
            seen.add(d.id);
            decisions.push(d);
          }
          const initial = start(startingCash);
          const res = simulateBrokerExecution(initial, decisions, {
            frictions,
            liquidity: {
              availableVolume: { ACME: liq.symbolCap, XYZ: liq.symbolCap, ZZZ: liq.symbolCap },
              maxParticipationRate: liq.participation,
              minFillQuantity: liq.minFill,
            },
          });
          const report = checkExecutionInvariants({
            initial,
            decisions,
            snapshots: res.snapshots,
            rejections: res.rejections,
          });
          if (!report.ok) {
            throw new Error(
              "invariants failed under random liquidity+frictions:\n"
              + report.violations.map((v) => `  ${v.code}: ${v.message}`).join("\n"),
            );
          }
          // Belt-and-braces: pure cash/quantity floors on every snapshot.
          for (const s of res.snapshots) {
            expect(s.cash).toBeGreaterThanOrEqual(-1e-6);
            for (const h of s.holdings) {
              expect(h.quantity).toBeGreaterThanOrEqual(-1e-6);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
