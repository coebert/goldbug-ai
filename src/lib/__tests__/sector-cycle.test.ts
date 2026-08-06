import { describe, it, expect } from "vitest";
import {
  classifySectorCycle,
  sectorAcceleration,
  sectorCycleFor,
  sectorPhaseMultiplier,
  formatSectorCycleBlock,
} from "../sector-cycle";

const mk = (sector: string, m30: number | null, m90: number | null = null) => ({
  sector,
  etf: sector.slice(0, 3).toUpperCase(),
  momentum_30d: m30,
  momentum_90d: m90,
});

describe("sectorAcceleration", () => {
  it("is positive when the recent pace beats the long pace", () => {
    expect(sectorAcceleration(0.06, 0.09)).toBeGreaterThan(0);
  });
  it("is negative when the move is fading", () => {
    expect(sectorAcceleration(0.01, 0.12)).toBeLessThan(0);
  });
  it("returns 0 with no 30d reading", () => {
    expect(sectorAcceleration(null, 0.1)).toBe(0);
  });
});

describe("classifySectorCycle", () => {
  it("labels leaders growing and laggards shrinking", () => {
    const c = classifySectorCycle([
      mk("technology", 0.08, 0.15),
      mk("energy", -0.06, -0.1),
      mk("utilities", 0.001, 0.005),
    ]);
    expect(sectorCycleFor(c, "technology")?.phase).toBe("growing");
    expect(sectorCycleFor(c, "energy")?.phase).toBe("shrinking");
    expect(sectorCycleFor(c, "utilities")?.phase).toBe("stagnating");
  });

  it("does not call every sector growing in a broad rally", () => {
    const c = classifySectorCycle([
      mk("a", 0.1, 0.2),
      mk("b", 0.1, 0.2),
      mk("c", 0.1, 0.2),
    ]);
    // All identical → none beats the median, so none is a genuine leader.
    expect(c.rows.every((r) => r.phase !== "growing")).toBe(true);
    expect(c.breadth_growing).toBe(0);
  });

  it("marks deep declines as shrinking even in a market-wide selloff", () => {
    const c = classifySectorCycle([mk("a", -0.12, -0.2), mk("b", -0.12, -0.2)]);
    expect(c.rows.every((r) => r.phase === "shrinking")).toBe(true);
    expect(c.laggards.length).toBeGreaterThan(0);
  });

  it("keeps strength sign consistent with the phase", () => {
    const c = classifySectorCycle([mk("up", 0.09, 0.05), mk("down", -0.09, -0.05)]);
    for (const r of c.rows) {
      if (r.phase === "growing") expect(r.strength).toBeGreaterThanOrEqual(0);
      if (r.phase === "shrinking") expect(r.strength).toBeLessThanOrEqual(0);
    }
  });

  it("is deterministic and sorts strongest first", () => {
    const input = [mk("a", 0.05, 0.02), mk("b", -0.04, -0.05), mk("c", 0.0, 0.01)];
    const a = classifySectorCycle(input);
    const b = classifySectorCycle(input);
    expect(a).toEqual(b);
    expect(a.rows[0].strength).toBeGreaterThanOrEqual(a.rows[a.rows.length - 1].strength);
  });

  it("tolerates missing momentum", () => {
    const c = classifySectorCycle([mk("a", null, null), mk("b", 0.07, 0.09)]);
    expect(sectorCycleFor(c, "a")?.phase).toBe("stagnating");
  });

  it("handles an empty universe", () => {
    const c = classifySectorCycle([]);
    expect(c.rows).toHaveLength(0);
    expect(c.breadth_growing).toBe(0);
  });
});

describe("sectorPhaseMultiplier", () => {
  const cycle = classifySectorCycle([
    mk("technology", 0.09, 0.12),
    mk("energy", -0.08, -0.12),
    mk("utilities", 0.0, 0.0),
  ]);

  it("boosts growing sectors, bounded at 1.2x", () => {
    const m = sectorPhaseMultiplier(sectorCycleFor(cycle, "technology"));
    expect(m.mult).toBeGreaterThan(1);
    expect(m.mult).toBeLessThanOrEqual(1.2);
  });

  it("cuts shrinking sectors, floored at 0.5x", () => {
    const m = sectorPhaseMultiplier(sectorCycleFor(cycle, "energy"));
    expect(m.mult).toBeLessThan(1);
    expect(m.mult).toBeGreaterThanOrEqual(0.5);
  });

  it("mildly trims stagnating sectors", () => {
    expect(sectorPhaseMultiplier(sectorCycleFor(cycle, "utilities")).mult).toBe(0.9);
  });

  it("is neutral for sells and unknown sectors", () => {
    expect(sectorPhaseMultiplier(sectorCycleFor(cycle, "energy"), "sell").mult).toBe(1);
    expect(sectorPhaseMultiplier(null).mult).toBe(1);
  });
});

describe("formatSectorCycleBlock", () => {
  it("names every sector with its phase and rules", () => {
    const block = formatSectorCycleBlock(
      classifySectorCycle([mk("technology", 0.09, 0.12), mk("energy", -0.08, -0.12)]),
    );
    expect(block).toContain("SECTOR CYCLE");
    expect(block).toContain("GROWING");
    expect(block).toContain("SHRINKING");
    expect(block).toContain("avoid new BUYs in SHRINKING sectors");
  });

  it("degrades gracefully with no data", () => {
    expect(formatSectorCycleBlock(null)).toBe("SECTOR CYCLE: unavailable.");
  });
});
