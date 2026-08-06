import { describe, expect, it } from "vitest";
import {
  buildLiquidityProfile,
  liquidityFrictions,
  scaleLiquidity,
  symbolLiquidity,
} from "@/lib/liquidity-profile";
import { applyLiquidity, buildCostGrid, scenarioKey, scaleFrictions } from "@/lib/cost-sweep";
import {
  liquidityCostBps,
  simulateBrokerExecution,
  type SimDecision,
} from "@/lib/broker-simulator";
import type { RawDailyBar, SymbolHistory } from "@/lib/real-market-tape";

function bars(n: number, price: number, volume: number | null): RawDailyBar[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2024-01-${String((i % 28) + 1).padStart(2, "0")}`,
    close: price * (1 + (i % 2 ? 0.01 : -0.01)),
    ...(volume === null ? {} : { volume }),
  }));
}

const HISTORIES: SymbolHistory[] = [
  { symbol: "DEEP", bars: bars(60, 100, 10_000_000) },
  { symbol: "THIN", bars: bars(60, 100, 10_000) },
  { symbol: "NOVOL", bars: bars(60, 100, null) },
];

describe("symbolLiquidity", () => {
  it("uses the median traded value and a mean-absolute-return vol proxy", () => {
    const s = symbolLiquidity("DEEP", bars(30, 100, 1_000_000));
    expect(s.adv20d).toBeGreaterThan(9e7);
    expect(s.advMissing).toBe(false);
    // alternating ±1% moves ⇒ ~2% mean absolute daily return
    expect(s.atrPct).toBeGreaterThan(0.015);
    expect(s.atrPct).toBeLessThan(0.025);
  });

  it("flags missing volume instead of inventing depth", () => {
    expect(symbolLiquidity("NOVOL", bars(30, 100, null)).advMissing).toBe(true);
  });

  it("is robust to a single volume spike (median, not mean)", () => {
    const spiky = bars(30, 100, 1_000);
    spiky[10] = { ...spiky[10]!, volume: 500_000_000 };
    const s = symbolLiquidity("SPIKE", spiky);
    expect(s.adv20d).toBeLessThan(1e6);
  });
});

describe("buildLiquidityProfile", () => {
  const profile = buildLiquidityProfile(HISTORIES);

  it("ranks the deep name far above the thin one", () => {
    expect(profile.adv20dBySymbol["DEEP"]!).toBeGreaterThan(
      profile.adv20dBySymbol["THIN"]! * 100,
    );
  });

  it("falls back to the cross-sectional median for volume-less symbols", () => {
    expect(profile.adv20dBySymbol["NOVOL"]).toBe(profile.medianAdv);
    expect(profile.medianAdv).toBeGreaterThan(0);
  });

  it("scales every ADV without touching volatility", () => {
    const thinner = scaleLiquidity(profile, 0.25);
    expect(thinner.adv20dBySymbol["DEEP"]).toBeCloseTo(profile.adv20dBySymbol["DEEP"]! * 0.25, 6);
    expect(thinner.atrPctBySymbol["DEEP"]).toBe(profile.atrPctBySymbol["DEEP"]);
  });

  it("rejects a non-positive ADV scale", () => {
    expect(() => scaleLiquidity(profile, 0)).toThrow(/advScale/);
  });
});

describe("liquidityCostBps", () => {
  const liq = liquidityFrictions(buildLiquidityProfile(HISTORIES));

  it("charges a thin name more than a deep one for the same ticket", () => {
    const thin = liquidityCostBps(liq, "THIN", 50_000);
    const deep = liquidityCostBps(liq, "DEEP", 50_000);
    expect(thin).toBeGreaterThan(deep);
  });

  it("is monotonically increasing in ticket size", () => {
    const small = liquidityCostBps(liq, "THIN", 1_000);
    const big = liquidityCostBps(liq, "THIN", 100_000);
    expect(big).toBeGreaterThan(small);
  });

  it("honours the cost scale multiplier", () => {
    const base = liquidityCostBps(liq, "DEEP", 10_000);
    const doubled = liquidityCostBps({ ...liq, costScale: 2 }, "DEEP", 10_000);
    expect(doubled).toBeCloseTo(base * 2, 6);
    expect(liquidityCostBps({ ...liq, costScale: 0 }, "DEEP", 10_000)).toBe(0);
  });

  it("still returns a finite cost for an unknown symbol via the defaults", () => {
    expect(Number.isFinite(liquidityCostBps(liq, "UNKNOWN", 10_000))).toBe(true);
  });
});

describe("simulator with liquidity-aware frictions", () => {
  const profile = buildLiquidityProfile(HISTORIES);
  const decisions: SimDecision[] = [
    { id: "1", symbol: "THIN", side: "BUY", quantity: 100, price: 100 },
  ];
  const run = (advScale: number) =>
    simulateBrokerExecution({ cash: 100_000, holdings: [] }, decisions, {
      frictions: {
        commissionBps: 0,
        liquidity: liquidityFrictions(scaleLiquidity(profile, advScale)),
      },
    });

  it("fills a BUY above the quote and worse in a thinner book", () => {
    const deepBook = run(100).snapshots[0]!;
    const thinBook = run(0.01).snapshots[0]!;
    expect(deepBook.fillPrice).toBeGreaterThan(100);
    expect(thinBook.fillPrice).toBeGreaterThan(deepBook.fillPrice);
  });

  it("keeps the no-borrow invariant under liquidity costs", () => {
    expect(run(0.01).finalState.cash).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(run(1))).toBe(JSON.stringify(run(1)));
  });
});

describe("cost grid liquidity axis", () => {
  const profile = buildLiquidityProfile(HISTORIES);
  const base = { commissionBps: 8, minCommission: 3, slippageBps: 5, impactPerUnit: 0.0002 };

  it("multiplies out as a fourth axis with distinct keys", () => {
    const grid = buildCostGrid(base, {
      scales: [0.5, 1],
      liquidity: [
        { label: "thin", advScale: 0.25 },
        { label: "deep", advScale: 4 },
      ],
      liquidityProfile: profile,
    });
    expect(grid).toHaveLength(4);
    expect(new Set(grid.map(scenarioKey)).size).toBe(4);
    expect(grid.every((s) => s.frictions.liquidity)).toBe(true);
  });

  it("folds the commission scale into the modelled bps, not into ADV", () => {
    const grid = buildCostGrid(base, {
      scales: [0.5],
      liquidity: [{ label: "as-traded", advScale: 1 }],
      liquidityProfile: profile,
    });
    const liq = grid[0]!.frictions.liquidity!;
    expect(liq.costScale).toBeCloseTo(0.5, 10);
    expect(liq.adv20dBySymbol!["DEEP"]).toBeCloseTo(profile.adv20dBySymbol["DEEP"]!, 6);
  });

  it("requires a profile when a liquidity axis is requested", () => {
    expect(() =>
      buildCostGrid(base, { scales: [1], liquidity: [{ label: "x", advScale: 1 }] }),
    ).toThrow(/liquidityProfile/);
  });

  it("leaves the grid untouched when no liquidity axis is given", () => {
    const grid = buildCostGrid(base, { scales: [1] });
    expect(grid[0]!.frictions.liquidity).toBeUndefined();
  });

  it("preserves the liquidity block through scaleFrictions", () => {
    const withLiq = applyLiquidity(base, { label: "as-traded", advScale: 1 }, profile);
    const scaled = scaleFrictions(withLiq, 2);
    expect(scaled.liquidity?.costScale).toBe(2);
  });

  it("rejects an invalid advScale", () => {
    expect(() => applyLiquidity(base, { label: "bad", advScale: -1 }, profile)).toThrow(
      /advScale/,
    );
  });
});
