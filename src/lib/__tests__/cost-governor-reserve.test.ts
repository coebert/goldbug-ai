import { describe, it, expect } from "vitest";
import {
  planAdmissions,
  DEFAULT_GOVERNOR,
  RESERVE_EDGE_MULTIPLE,
  type GovernorCandidate,
} from "../cost-governor";

const base = {
  navBase: 10_300,
  buysAlreadyToday: 0,
  trailingCostBase: 500, // window comprehensively blown
  lastBuyDaysAgo: {} as Record<string, number>,
  ...DEFAULT_GOVERNOR,
};

const strong: GovernorCandidate = {
  symbol: "VUSA.L",
  side: "buy",
  notionalBase: 1_000,
  estCostBase: 5,
  edgeScore: 0.85,
  expectedMovePct: 0.05, // 0.85 * 0.05 * 1000 = £42.5 gross edge vs £5 cost
};

describe("high-edge reserve", () => {
  it("lets one exceptional idea through an exhausted budget", () => {
    const plan = planAdmissions([strong], base);
    expect(plan.decisions[0]!.kind).toBe("admit");
    expect(strong.edgeScore! * strong.expectedMovePct! * strong.notionalBase).toBeGreaterThan(
      RESERVE_EDGE_MULTIPLE * strong.estCostBase,
    );
  });

  it("admits at most one reserve ticket per tick", () => {
    const plan = planAdmissions(
      [strong, { ...strong, symbol: "ISF.L" }, { ...strong, symbol: "VWRL.L" }],
      base,
    );
    expect(plan.decisions.filter((d) => d.kind === "admit")).toHaveLength(1);
  });

  it("still blocks weak or thin-edge ideas when the budget is spent", () => {
    const weak = planAdmissions([{ ...strong, edgeScore: 0.3 }], base);
    expect(weak.decisions[0]!.kind).toBe("skip");
    const thin = planAdmissions([{ ...strong, expectedMovePct: 0.005 }], base);
    expect(thin.decisions[0]!.kind).toBe("skip");
  });

  it("admits a moderately convicted idea whose edge covers friction 10x", () => {
    // conviction 0.45 (below the 0.6 bar) but 0.45 * 0.08 * 1500 = £54 vs £3 cost
    const plan = planAdmissions(
      [{ ...strong, edgeScore: 0.45, expectedMovePct: 0.08, notionalBase: 1_500, estCostBase: 3 }],
      base,
    );
    expect(plan.decisions[0]!.kind).toBe("admit");
  });

  it("can be turned off entirely", () => {
    const plan = planAdmissions([strong], { ...base, highEdgeReserveTickets: 0 });
    expect(plan.decisions[0]!.kind).toBe("skip");
  });
});
