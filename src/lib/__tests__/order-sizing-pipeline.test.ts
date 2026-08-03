// Focused unit tests for the order-sizing pipeline as the trading engine
// composes it: risk dial → vol-target scaling → correlation-cluster cap.
//
// The individual helpers have their own tests; what is untested is the
// *composition*, which is where sizing bugs have historically hidden:
// a defensive dial must never out-size an aggressive one, a vol-target
// trim must never be undone by the cluster step, and no path may ever
// produce a negative, NaN, or cap-breaching spend.
import { describe, it, expect } from "vitest";

import { resolveAggressiveness, aggressiveBuySpend } from "../risk-aggressiveness";
import { RISK_LEVELS, riskPresetConfig } from "../risk-presets";
import { volTargetSize } from "../sizing/vol-target";
import { sizeAgainstClusterCap } from "../sizing/correlation-cluster";

/** The composed sizer: dial → vol-target → cluster cap → cash spend. */
function sizeBuy(args: {
  level: number;
  nav: number;
  cash: number;
  baseFraction: number;
  realizedVol: number;
  targetVol?: number;
  maxFraction?: number;
  currentWeights?: Record<string, number>;
  clusters?: string[][];
  clusterCap?: number;
  symbol?: string;
}) {
  const symbol = args.symbol ?? "AAA";
  const agg = resolveAggressiveness(riskPresetConfig(args.level));
  const vol = volTargetSize({
    baseFraction: args.baseFraction,
    targetVol: args.targetVol ?? 0.15,
    realizedVol: args.realizedVol,
    maxFraction: args.maxFraction ?? 0.25,
  });
  const cluster = sizeAgainstClusterCap({
    currentWeights: args.currentWeights ?? {},
    proposedSymbol: symbol,
    proposedWeight: vol.fraction,
    clusters: args.clusters ?? [[symbol]],
    clusterCap: args.clusterCap ?? 1,
  });
  const targetNotional = cluster.allowed_weight * args.nav;
  const spend = Math.min(aggressiveBuySpend(targetNotional, agg), args.cash);
  return { agg, vol, cluster, spend: Math.max(0, spend) };
}

const NAV = 100_000;

describe("composed buy sizing — determinism", () => {
  it("is pure: the same inputs give the same spend every time", () => {
    const call = () =>
      sizeBuy({ level: 3, nav: NAV, cash: NAV, baseFraction: 0.1, realizedVol: 0.22 });
    const a = call();
    const b = call();
    expect(a.spend).toBe(b.spend);
    expect(a.vol.reason).toBe(b.vol.reason);
    expect(a.cluster.reason).toBe(b.cluster.reason);
  });

  it("is insensitive to the order of unrelated cluster members", () => {
    const weights = { BBB: 0.1, CCC: 0.05 };
    const forward = sizeBuy({
      level: 3, nav: NAV, cash: NAV, baseFraction: 0.1, realizedVol: 0.2,
      currentWeights: weights, clusters: [["AAA", "BBB", "CCC"]], clusterCap: 0.3,
    });
    const reversed = sizeBuy({
      level: 3, nav: NAV, cash: NAV, baseFraction: 0.1, realizedVol: 0.2,
      currentWeights: { CCC: 0.05, BBB: 0.1 }, clusters: [["CCC", "BBB", "AAA"]], clusterCap: 0.3,
    });
    expect(reversed.spend).toBeCloseTo(forward.spend, 9);
  });
});

describe("composed buy sizing — risk levels", () => {
  it("is strictly monotonic in the risk dial for identical market inputs", () => {
    const spends = RISK_LEVELS.map(
      (level) =>
        sizeBuy({ level, nav: NAV, cash: NAV, baseFraction: 0.1, realizedVol: 0.18 }).spend,
    );
    for (let i = 1; i < spends.length; i++) {
      expect(spends[i]).toBeGreaterThan(spends[i - 1]);
    }
  });

  it("keeps the ordering intact under a hard vol trim", () => {
    const calm = RISK_LEVELS.map(
      (l) => sizeBuy({ level: l, nav: NAV, cash: NAV, baseFraction: 0.1, realizedVol: 0.05 }).spend,
    );
    const stormy = RISK_LEVELS.map(
      (l) => sizeBuy({ level: l, nav: NAV, cash: NAV, baseFraction: 0.1, realizedVol: 0.9 }).spend,
    );
    for (let i = 0; i < RISK_LEVELS.length; i++) {
      expect(stormy[i]).toBeLessThan(calm[i]);
      if (i > 0) expect(stormy[i]).toBeGreaterThan(stormy[i - 1]);
    }
  });

  it("never lets even the hottest dial exceed available cash", () => {
    const hot = sizeBuy({
      level: 5, nav: NAV, cash: 250, baseFraction: 0.25, realizedVol: 0.05,
    });
    expect(hot.spend).toBe(250);
  });
});

describe("composed buy sizing — vol target", () => {
  it("scales down monotonically as realised vol rises", () => {
    const vols = [0.05, 0.1, 0.2, 0.4, 0.8];
    const spends = vols.map(
      (v) => sizeBuy({ level: 3, nav: NAV, cash: NAV, baseFraction: 0.1, realizedVol: v }).spend,
    );
    for (let i = 1; i < spends.length; i++) {
      expect(spends[i]).toBeLessThan(spends[i - 1]);
    }
  });

  it("floors near-zero realised vol instead of blowing up", () => {
    for (const v of [0, -1, Number.NaN, 1e-12]) {
      const r = sizeBuy({ level: 5, nav: NAV, cash: NAV, baseFraction: 0.1, realizedVol: v });
      expect(Number.isFinite(r.spend)).toBe(true);
      expect(r.vol.fraction).toBeLessThanOrEqual(0.25 + 1e-12);
    }
  });

  it("respects the hard max fraction of NAV before the dial is applied", () => {
    const r = sizeBuy({
      level: 3, nav: NAV, cash: NAV, baseFraction: 0.2, realizedVol: 0.05, maxFraction: 0.1,
    });
    expect(r.vol.fraction).toBeCloseTo(0.1, 9);
  });
});

describe("composed buy sizing — cluster cap", () => {
  it("trims to the remaining cluster headroom and flags the breach", () => {
    const r = sizeBuy({
      level: 3, nav: NAV, cash: NAV, baseFraction: 0.2, realizedVol: 0.15,
      currentWeights: { BBB: 0.25 }, clusters: [["AAA", "BBB"]], clusterCap: 0.3,
    });
    expect(r.cluster.breached_cap).toBe(true);
    expect(r.cluster.allowed_weight).toBeCloseTo(0.05, 9);
  });

  it("returns zero — not a negative spend — when the cluster is already full", () => {
    const r = sizeBuy({
      level: 5, nav: NAV, cash: NAV, baseFraction: 0.2, realizedVol: 0.15,
      currentWeights: { BBB: 0.4 }, clusters: [["AAA", "BBB"]], clusterCap: 0.3,
    });
    expect(r.cluster.allowed_weight).toBe(0);
    expect(r.spend).toBe(0);
  });

  it("leaves an uncorrelated name untouched", () => {
    const capped = sizeBuy({
      level: 3, nav: NAV, cash: NAV, baseFraction: 0.1, realizedVol: 0.15,
      currentWeights: { BBB: 0.28 }, clusters: [["BBB", "CCC"]], clusterCap: 0.3,
    });
    const free = sizeBuy({ level: 3, nav: NAV, cash: NAV, baseFraction: 0.1, realizedVol: 0.15 });
    expect(capped.cluster.scale).toBe(1);
    expect(capped.spend).toBeCloseTo(free.spend, 9);
  });
});

describe("composed buy sizing — degenerate inputs", () => {
  it("never emits NaN, Infinity, or a negative spend", () => {
    const grid = [0, -5, Number.NaN, Infinity, 1e12];
    for (const level of RISK_LEVELS) {
      for (const nav of grid) {
        for (const vol of grid) {
          const r = sizeBuy({
            level, nav, cash: Math.abs(nav) || 0, baseFraction: 0.1, realizedVol: vol,
          });
          expect(Number.isFinite(r.spend)).toBe(true);
          expect(r.spend).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("spends nothing when there is no cash, whatever the dial says", () => {
    for (const level of RISK_LEVELS) {
      expect(
        sizeBuy({ level, nav: NAV, cash: 0, baseFraction: 0.2, realizedVol: 0.1 }).spend,
      ).toBe(0);
    }
  });
});
