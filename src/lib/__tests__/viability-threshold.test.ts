import { describe, it, expect } from "vitest";
import {
  assessRiskLevel,
  assessViability,
  buildViabilityReport,
  describeRiskLevelViability,
  deriveThreshold,
  type ViabilityRow,
} from "../viability-threshold";

const row = (
  id: string,
  riskLevel: string,
  tradesPerYear: number,
  cagrPct: number,
  extra: Partial<ViabilityRow> = {},
): ViabilityRow => ({
  id,
  riskLevel,
  params: { k: tradesPerYear },
  metrics: { tradesPerYear, cagrPct, feeDragPct: tradesPerYear * 0.05 },
  check: { feasible: true, disqualified: false },
  ...extra,
});

// CAGR falls 0.1pp per extra trade/yr: 8% at 20 trades, 0% at 100.
const balanced = [
  row("a", "balanced", 20, 8),
  row("b", "balanced", 60, 4),
  row("c", "balanced", 100, 0),
  row("d", "balanced", 140, -4),
];

describe("deriveThreshold", () => {
  it("fits the zero crossing from the candidates at that risk level", () => {
    const t = deriveThreshold(balanced, "balanced");
    expect(t.source).toBe("fitted");
    expect(t.breakevenTradesPerYear).toBeCloseTo(100, 6);
    expect(t.cagrPerTrade).toBeCloseTo(-0.1, 6);
    expect(t.n).toBe(4);
  });

  it("solves for a non-zero minimum return floor", () => {
    const t = deriveThreshold(balanced, "balanced", { minCagrPct: 4 });
    expect(t.breakevenTradesPerYear).toBeCloseTo(60, 6);
    expect(t.minCagrPct).toBe(4);
  });

  it("prefers an explicit override", () => {
    const t = deriveThreshold(balanced, "balanced", {
      breakevenOverride: { balanced: 45 },
    });
    expect(t.source).toBe("override");
    expect(t.breakevenTradesPerYear).toBe(45);
  });

  it("isolates each risk level", () => {
    const rows = [...balanced, row("x", "high", 20, 2), row("y", "high", 60, -2)];
    const high = deriveThreshold(rows, "high", { minSampleToFit: 2 });
    expect(high.breakevenTradesPerYear).toBeCloseTo(40, 6);
    expect(high.n).toBe(2);
    expect(deriveThreshold(rows, "balanced").breakevenTradesPerYear).toBeCloseTo(100, 6);
  });

  it("returns no threshold below the sample floor", () => {
    const t = deriveThreshold([row("a", "low", 20, 5), row("b", "low", 60, 1)], "low");
    expect(t.source).toBe("none");
    expect(t.breakevenTradesPerYear).toBeNull();
  });

  it("returns no threshold when the fit is flat", () => {
    const flat = [row("a", "low", 20, 5), row("b", "low", 60, 5), row("c", "low", 90, 5)];
    expect(deriveThreshold(flat, "low").breakevenTradesPerYear).toBeNull();
  });

  it("returns no threshold when the crossing is negative", () => {
    const alwaysBad = [
      row("a", "low", 20, -5),
      row("b", "low", 60, -9),
      row("c", "low", 100, -13),
    ];
    expect(deriveThreshold(alwaysBad, "low").breakevenTradesPerYear).toBeNull();
  });

  it("excludes disqualified candidates unless asked", () => {
    const rows = [
      ...balanced,
      row("bad", "balanced", 400, 99, { check: { feasible: false, disqualified: true } }),
    ];
    expect(deriveThreshold(rows, "balanced").n).toBe(4);
    expect(deriveThreshold(rows, "balanced", { includeDisqualified: true }).n).toBe(5);
  });
});

describe("assessViability", () => {
  const threshold = deriveThreshold(balanced, "balanced");

  it("passes a config well inside the breakeven", () => {
    const a = assessViability(row("a", "balanced", 20, 8), threshold);
    expect(a.verdict).toBe("viable");
    expect(a.turnoverHeadroom).toBeCloseTo(80, 6);
    expect(a.returnMarginPct).toBeCloseTo(8, 6);
    expect(a.reasons).toEqual([]);
  });

  it("flags a config past the breakeven turnover", () => {
    const a = assessViability(row("d", "balanced", 140, -4), threshold);
    expect(a.verdict).toBe("below_breakeven");
    expect(a.turnoverHeadroom).toBeCloseTo(-40, 6);
    expect(a.reasons.join(" ")).toContain("exceeds the 100/yr breakeven");
  });

  it("marks configs inside the marginal band", () => {
    const a = assessViability(row("m", "balanced", 95, 0.5), threshold);
    expect(a.verdict).toBe("marginal");
    expect(a.reasons.join(" ")).toContain("within 10% of the breakeven");
  });

  it("respects a custom marginal band", () => {
    const wide = assessViability(row("m", "balanced", 60, 4), threshold, {
      marginalBand: 0.5,
    });
    expect(wide.verdict).toBe("marginal");
  });

  it("flags a negative net return even below the turnover breakeven", () => {
    const a = assessViability(row("n", "balanced", 10, -1), threshold);
    expect(a.verdict).toBe("below_breakeven");
    expect(a.reasons.join(" ")).toContain("below the 0.00% floor");
  });

  it("applies a non-zero return floor", () => {
    const t = deriveThreshold(balanced, "balanced", { minCagrPct: 4 });
    const a = assessViability(row("p", "balanced", 20, 3), t, { minCagrPct: 4 });
    expect(a.verdict).toBe("below_breakeven");
    expect(a.returnMarginPct).toBeCloseTo(-1, 6);
  });

  it("does not penalise turnover when churn is not costly", () => {
    const rising = [
      row("a", "low", 20, 1),
      row("b", "low", 60, 5),
      row("c", "low", 100, 9),
    ];
    const t = deriveThreshold(rising, "low");
    expect(t.cagrPerTrade).toBeGreaterThan(0);
    const a = assessViability(row("c", "low", 100, 9), t);
    expect(a.verdict).toBe("viable");
  });

  it("always flags a disqualified configuration", () => {
    const a = assessViability(
      row("bad", "balanced", 10, 12, { check: { feasible: false, disqualified: true } }),
      threshold,
    );
    expect(a.verdict).toBe("below_breakeven");
    expect(a.reasons.join(" ")).toContain("simulator audit");
  });

  it("reports unknown when no breakeven could be fitted", () => {
    const t = deriveThreshold([row("a", "low", 20, 5)], "low");
    const a = assessViability(row("a", "low", 20, 5), t);
    expect(a.verdict).toBe("unknown");
    expect(a.turnoverHeadroom).toBeNull();
    expect(a.reasons.join(" ")).toContain("no breakeven");
  });
});

describe("assessRiskLevel", () => {
  it("counts verdicts and sorts by net CAGR", () => {
    const l = assessRiskLevel(balanced, "balanced");
    expect(l.assessments.map((a) => a.id)).toEqual(["a", "b", "c", "d"]);
    expect(l.viableCount).toBe(2); // a, b
    expect(l.marginalCount).toBe(1); // c sits on the breakeven
    expect(l.belowCount).toBe(1); // d
    expect(l.viableShare).toBeCloseTo(0.5, 6);
    expect(l.bestViable?.id).toBe("a");
    expect(l.flagged.map((a) => a.id).sort()).toEqual(["c", "d"]);
  });

  it("reports no viable configuration when everything fails", () => {
    const rows = [
      row("a", "high", 120, -1),
      row("b", "high", 160, -5),
      row("c", "high", 200, -9),
    ];
    const l = assessRiskLevel(rows, "high");
    expect(l.viableCount).toBe(0);
    expect(l.bestViable).toBeNull();
    expect(describeRiskLevelViability(l)).toContain("no viable configuration");
  });
});

describe("buildViabilityReport", () => {
  const rows = [
    ...balanced,
    row("a", "high", 30, 6),
    row("b", "high", 70, 2),
    row("c", "high", 110, -2),
    row("d", "high", 150, -6),
  ];

  it("produces one threshold per risk level", () => {
    const rep = buildViabilityReport(rows);
    expect(rep.levels.map((l) => l.riskLevel)).toEqual(["balanced", "high"]);
    expect(rep.totalAssessed).toBe(8);
    expect(rep.levels[1]!.threshold.breakevenTradesPerYear).toBeCloseTo(90, 6);
  });

  it("lists configurations that fail at every risk level", () => {
    const rep = buildViabilityReport(rows);
    expect(rep.universallyBelow).toEqual(["d"]);
  });

  it("counts flagged configurations across levels", () => {
    const rep = buildViabilityReport(rows);
    expect(rep.totalFlagged).toBe(rep.levels.reduce((a, l) => a + l.flagged.length, 0));
    expect(rep.totalFlagged).toBeGreaterThan(0);
  });

  it("handles an empty input", () => {
    const rep = buildViabilityReport([]);
    expect(rep).toMatchObject({ levels: [], totalFlagged: 0, totalAssessed: 0 });
    expect(rep.universallyBelow).toEqual([]);
  });

  it("honours per-level overrides", () => {
    const rep = buildViabilityReport(rows, { breakevenOverride: { high: 50 } });
    const high = rep.levels.find((l) => l.riskLevel === "high")!;
    expect(high.threshold.source).toBe("override");
    expect(high.assessments.find((a) => a.id === "b")!.verdict).not.toBe("viable");
  });
});

describe("describeRiskLevelViability", () => {
  it("summarises the threshold and counts", () => {
    const text = describeRiskLevelViability(assessRiskLevel(balanced, "balanced"));
    expect(text).toContain("balanced: breakeven 100/yr (fitted)");
    expect(text).toContain("2 viable");
  });
});
