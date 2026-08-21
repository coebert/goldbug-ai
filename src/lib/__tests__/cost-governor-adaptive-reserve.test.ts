import { describe, expect, it } from "vitest";
import {
  adaptiveReserveCap,
  planAdmissions,
  CHURN_CALM_FILLS,
  CHURN_WINDOW_DAYS,
  type GovernorCandidate,
} from "../cost-governor";

describe("adaptiveReserveCap", () => {
  it("leaves the reserve intact on a calm tape at a normal cadence", () => {
    const cap = adaptiveReserveCap({ baseTickets: 2, recentBuyFills: CHURN_CALM_FILLS, tapeVolZ: 0 });
    expect(cap.tickets).toBe(2);
    expect(cap.churning).toBe(false);
    expect(cap.reason).toBeNull();
  });

  it("halves the allowed cadence on a fully violent tape", () => {
    const cap = adaptiveReserveCap({ baseTickets: 2, recentBuyFills: 3, tapeVolZ: 2 });
    expect(cap.allowedFills).toBeCloseTo(CHURN_CALM_FILLS / 2, 6);
    expect(cap.churning).toBe(true);
    expect(cap.tickets).toBe(1);
  });

  it("burns one reserve ticket per fill over the allowance", () => {
    const cap = adaptiveReserveCap({ baseTickets: 2, recentBuyFills: 6, tapeVolZ: 2 });
    expect(cap.tickets).toBe(0);
  });

  it("never returns a negative ticket count", () => {
    const cap = adaptiveReserveCap({ baseTickets: 1, recentBuyFills: 20, tapeVolZ: 3 });
    expect(cap.tickets).toBe(0);
  });

  it("scales the allowance with a longer churn window", () => {
    const cap = adaptiveReserveCap({
      baseTickets: 1,
      recentBuyFills: CHURN_CALM_FILLS * 2,
      churnWindowDays: CHURN_WINDOW_DAYS * 2,
      tapeVolZ: 0,
    });
    expect(cap.churning).toBe(false);
  });

  it("withdraws the stall relief only when churning on a violent tape", () => {
    expect(
      adaptiveReserveCap({ baseTickets: 2, recentBuyFills: 9, tapeVolZ: 1.5, stalled: true })
        .suppressStallRelief,
    ).toBe(true);
    expect(
      adaptiveReserveCap({ baseTickets: 2, recentBuyFills: 9, tapeVolZ: 0, stalled: true })
        .suppressStallRelief,
    ).toBe(false);
  });
});

const buy = (symbol: string): GovernorCandidate => ({
  symbol,
  side: "buy",
  notionalBase: 1_000,
  estCostBase: 10,
  edgeScore: 0.9,
  expectedMovePct: 0.1,
});

const base = {
  navBase: 20_000,
  buysAlreadyToday: 0,
  // Budget already spent, so only the reserve can admit anything.
  trailingCostBase: 10_000,
  lastBuyDaysAgo: {},
  minTicketPctOfNav: 0.03,
  absoluteMinTicketBase: 250,
  maxBuysPerDay: 3,
  costBudgetPctOfNav: 0.004,
  addCooldownDays: 5,
};

describe("planAdmissions with churn-capped reserve", () => {
  it("admits the reserve ticket when the book is quiet", () => {
    const plan = planAdmissions([buy("AAA")], { ...base, recentBuyFills: 0, tapeVolZ: 2 });
    expect(plan.decisions[0]!.kind).toBe("admit");
  });

  it("blocks the reserve ticket when churning through a violent tape", () => {
    const plan = planAdmissions([buy("AAA")], { ...base, recentBuyFills: 5, tapeVolZ: 2 });
    const d = plan.decisions[0]!;
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") expect(d.reason).toContain("churn cadence");
  });

  it("still allows the reserve at the same cadence when the tape is calm", () => {
    const plan = planAdmissions([buy("AAA")], { ...base, recentBuyFills: 4, tapeVolZ: 0 });
    expect(plan.decisions[0]!.kind).toBe("admit");
  });

  it("never gates sells on the churn cap", () => {
    const plan = planAdmissions(
      [{ ...buy("AAA"), side: "sell" }],
      { ...base, recentBuyFills: 20, tapeVolZ: 3 },
    );
    expect(plan.decisions[0]!.kind).toBe("admit");
  });
});
