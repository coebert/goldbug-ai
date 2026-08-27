import { describe, it, expect } from "vitest";
import { checkPositionsConsistency } from "@/lib/positions-consistency";

const engine = [
  { symbol: "AAPL:xnas", quantity: 10 },
  { symbol: "BP.L", quantity: 200 },
];

describe("checkPositionsConsistency", () => {
  it("passes when counts, quantities and totals agree", () => {
    const r = checkPositionsConsistency({
      enginePositions: engine,
      renderedPositions: [
        { symbol: "AAPL:xnas", quantity: 10, value: 1500 },
        { symbol: "BP.L", quantity: 200, value: 800 },
      ],
      investedTotal: 2300,
    });
    expect(r.ok).toBe(true);
    expect(r.engineCount).toBe(2);
    expect(r.renderedCount).toBe(2);
    expect(r.summary).toContain("2 positions reconciled");
  });

  it("flags a position the UI drops (the invisible FX-leg class of bug)", () => {
    const r = checkPositionsConsistency({
      enginePositions: [...engine, { symbol: "MKS.L", quantity: 500 }],
      renderedPositions: [
        { symbol: "AAPL:xnas", quantity: 10, value: 1500 },
        { symbol: "BP.L", quantity: 200, value: 800 },
      ],
      investedTotal: 2300,
    });
    expect(r.ok).toBe(false);
    expect(r.missingInUi).toEqual(["MKS.L"]);
    expect(r.summary).toContain("not shown");
  });

  it("does not count FX funding legs as missing positions", () => {
    const r = checkPositionsConsistency({
      enginePositions: [...engine, { symbol: "GBPUSD", quantity: -2325.78, isFxLeg: true }],
      renderedPositions: [
        { symbol: "AAPL:xnas", quantity: 10, value: 1500 },
        { symbol: "BP.L", quantity: 200, value: 800 },
      ],
      investedTotal: 2300,
    });
    expect(r.ok).toBe(true);
    expect(r.fxLegCount).toBe(1);
    expect(r.summary).toContain("FX funding leg");
  });

  it("flags rows that do not sum to the invested tile", () => {
    const r = checkPositionsConsistency({
      enginePositions: engine,
      renderedPositions: [
        { symbol: "AAPL:xnas", quantity: 10, value: 1500 },
        { symbol: "BP.L", quantity: 200, value: 800 },
      ],
      investedTotal: 2500,
    });
    expect(r.ok).toBe(false);
    expect(r.totalsDelta).toBe(-200);
    expect(r.summary).toContain("rows sum off by");
  });

  it("tolerates sub-penny rounding residue", () => {
    const r = checkPositionsConsistency({
      enginePositions: [{ symbol: "BP.L", quantity: 200 }],
      renderedPositions: [{ symbol: "BP.L", quantity: 200, value: 800.004 }],
      investedTotal: 800,
    });
    expect(r.ok).toBe(true);
  });

  it("flags quantity drift and duplicate rows, case-insensitively", () => {
    const r = checkPositionsConsistency({
      enginePositions: [{ symbol: "bp.l", quantity: 200 }],
      renderedPositions: [
        { symbol: "BP.L", quantity: 150, value: 600 },
        { symbol: "BP.L", quantity: 50, value: 200 },
      ],
      investedTotal: 800,
    });
    expect(r.duplicateRows).toEqual(["BP.L"]);
    expect(r.ok).toBe(false);
    // Quantities still add back to 200, so only duplication is at fault.
    expect(r.quantityMismatches).toEqual([]);
  });

  it("reports extra rows the engine does not hold", () => {
    const r = checkPositionsConsistency({
      enginePositions: [{ symbol: "BP.L", quantity: 200 }],
      renderedPositions: [
        { symbol: "BP.L", quantity: 200, value: 800 },
        { symbol: "GHOST", quantity: 1, value: 0 },
      ],
      investedTotal: 800,
    });
    expect(r.extraInUi).toEqual(["GHOST"]);
    expect(r.ok).toBe(false);
  });
});
