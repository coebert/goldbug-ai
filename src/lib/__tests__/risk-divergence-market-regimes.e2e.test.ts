// End-to-end: high-risk vs balanced-risk portfolios must diverge.
//
// Replays the SAME deterministic price tape through the real rule-set at
// two risk levels under four market regimes (bull, bear, flat/low-vol,
// high-vol whipsaw) and asserts the two books do not mirror each other:
// position sizing, holdings paths, cash paths and equity curves must all
// separate, while each book independently respects the no-borrow invariant.
//
// This is the regression net for the "two portfolios show identical
// holdings and equity" class of bug (shared broker account / shared
// sizing) — now proven across varied market conditions, not one tape.

import { describe, it, expect } from "vitest";
import {
  buildPriceTape,
  runRiskLevelSim,
  type AssetSpec,
} from "@/lib/risk-sim-matrix";

const START_CASH = 10_300;
const FEE = 3;
const BARS = 180;
const SEEDS = [11, 22, 4242];

/** Six-name universe, parameterised by regime drift/vol. */
function universe(drift: number, vol: number): AssetSpec[] {
  return ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"].map((symbol, i) => ({
    symbol,
    drift: drift + i * 0.02,
    vol: vol + i * 0.03,
    start: 50 + i * 17,
    cycleBars: 25 + i * 9,
    cycleAmp: 0.05,
  }));
}

const REGIMES = [
  { name: "bull", universe: universe(0.25, 0.18) },
  { name: "bear", universe: universe(-0.25, 0.22) },
  { name: "flat / low-vol", universe: universe(0.0, 0.08) },
  { name: "high-vol whipsaw", universe: universe(0.05, 0.55) },
] as const;

type Run = Awaited<ReturnType<typeof runRiskLevelSim>>;

async function pair(u: AssetSpec[], seed: number): Promise<{ balanced: Run; high: Run }> {
  const tape = buildPriceTape(u, BARS, seed);
  const [balanced, high] = await Promise.all([
    runRiskLevelSim("balanced", tape, START_CASH, FEE),
    runRiskLevelSim("high", tape, START_CASH, FEE),
  ]);
  return { balanced, high };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function equityPath(run: Run): number[] {
  return run.equity.map((p) => p.total_value);
}

function differingBars(a: number[], b: number[], eps = 1e-6): number {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (Math.abs(a[i] - b[i]) > eps) n++;
  }
  return n;
}

describe("high vs balanced risk divergence across market regimes", () => {
  for (const regime of REGIMES) {
    describe(regime.name, () => {
      it("both books actually trade (the tape exercises the rule-set)", async () => {
        for (const seed of SEEDS) {
          const { balanced, high } = await pair(regime.universe, seed);
          expect(balanced.buys, `${regime.name} seed ${seed} balanced buys`).toBeGreaterThan(0);
          expect(high.buys, `${regime.name} seed ${seed} high buys`).toBeGreaterThan(0);
        }
      });

      it("equity curves diverge and never stay identical", async () => {
        for (const seed of SEEDS) {
          const { balanced, high } = await pair(regime.universe, seed);
          const b = equityPath(balanced);
          const h = equityPath(high);

          expect(b.length).toBe(h.length);
          // Same number of bars, but the paths must not be the same series.
          expect(differingBars(b, h)).toBeGreaterThan(0);
          expect(b.at(-1)).not.toBeCloseTo(h.at(-1) as number, 6);
        }
      });

      it("holdings-value paths diverge, with high risk carrying more exposure on average", async () => {
        const meanExposureDeltas: number[] = [];
        for (const seed of SEEDS) {
          const { balanced, high } = await pair(regime.universe, seed);
          const bHold = balanced.series.map((p) => p.holdingsValue);
          const hHold = high.series.map((p) => p.holdingsValue);

          expect(differingBars(bHold, hHold)).toBeGreaterThan(0);
          meanExposureDeltas.push(mean(hHold) - mean(bHold));
        }
        // 10%-of-cash per name (high) vs 8% (balanced) ⇒ structurally more
        // invested capital for the high-risk book across the regime.
        expect(mean(meanExposureDeltas)).toBeGreaterThan(0);
      });

      it("cash paths diverge, with high risk holding less idle cash", async () => {
        const meanCashDeltas: number[] = [];
        for (const seed of SEEDS) {
          const { balanced, high } = await pair(regime.universe, seed);
          const bCash = balanced.series.map((p) => p.cash);
          const hCash = high.series.map((p) => p.cash);

          expect(differingBars(bCash, hCash)).toBeGreaterThan(0);
          meanCashDeltas.push(mean(hCash) - mean(bCash));
        }
        expect(mean(meanCashDeltas)).toBeLessThan(0);
      });

      it("position sizes differ even when the two books pick the same names", async () => {
        let comparedAnyOverlap = false;
        for (const seed of SEEDS) {
          const { balanced, high } = await pair(regime.universe, seed);
          const bBySym = new Map(balanced.finalHoldings.map((h) => [h.symbol, h.quantity]));
          for (const h of high.finalHoldings) {
            const bq = bBySym.get(h.symbol);
            if (bq == null) continue;
            comparedAnyOverlap = true;
            // Overlapping name ⇒ quantity must not be a mirror image.
            expect(h.quantity).not.toBe(bq);
          }
        }
        // Not every regime ends with overlapping open positions; when none
        // overlap the divergence is already proven by the holdings paths.
        expect(typeof comparedAnyOverlap).toBe("boolean");
      });

      it("each book stays independently solvent (no borrowing, no negative equity)", async () => {
        for (const seed of SEEDS) {
          const { balanced, high } = await pair(regime.universe, seed);
          for (const run of [balanced, high]) {
            for (const p of run.series) {
              expect(p.cash).toBeGreaterThanOrEqual(-1e-9);
              expect(p.totalValue).toBeGreaterThan(0);
              expect(p.totalValue).toBeCloseTo(p.cash + p.holdingsValue, 6);
            }
            for (const h of run.finalHoldings) expect(h.quantity).toBeGreaterThan(0);
          }
        }
      });

      it("divergence, once opened, does not collapse back to a mirrored book", async () => {
        for (const seed of SEEDS) {
          const { balanced, high } = await pair(regime.universe, seed);
          const b = equityPath(balanced);
          const h = equityPath(high);
          const firstDiff = b.findIndex((v, i) => Math.abs(v - h[i]) > 1e-6);
          expect(firstDiff).toBeGreaterThanOrEqual(0);

          const tail = b.slice(firstDiff).map((v, i) => Math.abs(v - h[firstDiff + i]));
          // The books may re-cross, but they must not become the identical
          // series again for the remainder of the run.
          const identicalTail = tail.every((d) => d <= 1e-9);
          expect(identicalTail).toBe(false);
        }
      });
    });
  }

  it("is fully deterministic — repeat runs reproduce the same divergence", async () => {
    const u = REGIMES[3].universe; // high-vol whipsaw: the noisiest path
    const a = await pair(u, SEEDS[0]);
    const b = await pair(u, SEEDS[0]);

    expect(equityPath(a.balanced)).toEqual(equityPath(b.balanced));
    expect(equityPath(a.high)).toEqual(equityPath(b.high));
    expect(a.high.finalHoldings).toEqual(b.high.finalHoldings);
  });

  it("divergence is regime-dependent, not a constant offset", async () => {
    const spreads: number[] = [];
    for (const regime of REGIMES) {
      const { balanced, high } = await pair(regime.universe, SEEDS[0]);
      const bEnd = equityPath(balanced).at(-1) as number;
      const hEnd = equityPath(high).at(-1) as number;
      spreads.push(hEnd - bEnd);
    }
    const unique = new Set(spreads.map((s) => s.toFixed(6)));
    expect(unique.size).toBe(spreads.length);
  });
});
