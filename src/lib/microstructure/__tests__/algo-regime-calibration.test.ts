import { describe, it, expect } from "vitest";
import {
  calibrateRegime,
  type EquityPoint,
  type RegimeObservation,
} from "@/lib/microstructure/algo-regime-calibration";

const eq = (rows: Array<[string, number]>): EquityPoint[] =>
  rows.map(([date, totalValue]) => ({ date, totalValue }));

describe("calibrateRegime", () => {
  it("returns zeroed tiers when no observations match equity", () => {
    const r = calibrateRegime([], eq([["2025-01-01", 100]]));
    expect(r.matched).toBe(0);
    expect(r.perTier.every((t) => t.count === 0)).toBe(true);
    expect(r.monotone).toBe(false);
  });

  it("computes monotone mean returns when extreme tier precedes drawdowns", () => {
    const equity = eq([
      ["2025-01-01", 100],
      ["2025-01-02", 101], // +1% after normal
      ["2025-01-03", 101.5], // +0.5% after elevated
      ["2025-01-04", 96.4], // -5% after extreme
    ]);
    const obs: RegimeObservation[] = [
      { date: "2025-01-01", tier: "normal" },
      { date: "2025-01-02", tier: "elevated" },
      { date: "2025-01-03", tier: "extreme" },
    ];
    const r = calibrateRegime(obs, equity);
    expect(r.matched).toBe(3);
    expect(r.unmatched).toBe(0);
    const [n, e, x] = r.perTier;
    expect(n.meanReturn).toBeGreaterThan(e.meanReturn);
    expect(e.meanReturn).toBeGreaterThan(x.meanReturn);
    expect(x.worstReturn).toBeCloseTo(-0.0505, 3);
    expect(r.monotone).toBe(true);
  });

  it("drops observations without a forward equity point", () => {
    const r = calibrateRegime(
      [{ date: "2025-02-01", tier: "extreme" }],
      eq([["2025-01-01", 100]]),
    );
    expect(r.matched).toBe(0);
    expect(r.unmatched).toBe(1);
  });
});
