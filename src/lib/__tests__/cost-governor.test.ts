import { describe, it, expect } from "vitest";
import {
  planAdmissions,
  minTicketBase,
  governorForNav,
  DEFAULT_GOVERNOR,
  type GovernorCandidate,
} from "../cost-governor";

const base = {
  navBase: 10_300,
  buysAlreadyToday: 0,
  trailingCostBase: 0,
  lastBuyDaysAgo: {} as Record<string, number>,
  ...DEFAULT_GOVERNOR,
};

const buy = (symbol: string, notionalBase: number, estCostBase = 5): GovernorCandidate => ({
  symbol,
  side: "buy",
  notionalBase,
  estCostBase,
});

describe("cost governor", () => {
  it("uses the larger of the percentage and absolute minimum ticket", () => {
    expect(minTicketBase({ navBase: 10_300, minTicketPctOfNav: 0.03, absoluteMinTicketBase: 250 })).toBeCloseTo(309);
    expect(minTicketBase({ navBase: 5_000, minTicketPctOfNav: 0.03, absoluteMinTicketBase: 250 })).toBe(250);
  });

  it("blocks the sub-scale tickets that caused the live cost drag", () => {
    // Real July/August tickets: VMID.L £104, VUKE.L £70.
    const plan = planAdmissions([buy("VMID.L", 104), buy("VUKE.L", 70), buy("HSBA.L", 800)], base);
    const skipped = plan.decisions.filter((d) => d.kind === "skip").map((d) => d.candidate.symbol);
    expect(skipped).toEqual(expect.arrayContaining(["VMID.L", "VUKE.L"]));
    expect(plan.decisions.find((d) => d.candidate.symbol === "HSBA.L")?.kind).toBe("admit");
  });

  it("never gates sells", () => {
    const plan = planAdmissions(
      [{ symbol: "MKS.L", side: "sell", notionalBase: 12, estCostBase: 3 }],
      { ...base, trailingCostBase: 9_999, buysAlreadyToday: 99 },
    );
    expect(plan.decisions[0]!.kind).toBe("admit");
  });

  it("enforces the daily buy-ticket cap, largest tickets first", () => {
    const plan = planAdmissions(
      [buy("A", 400), buy("B", 1_200), buy("C", 900), buy("D", 700)],
      base,
    );
    const admitted = plan.decisions.filter((d) => d.kind === "admit").map((d) => d.candidate.symbol);
    expect(admitted).toEqual(["B", "C", "D"]);
    const capped = plan.decisions.find((d) => d.candidate.symbol === "A");
    expect(capped?.kind).toBe("skip");
    expect(capped && "reason" in capped ? capped.reason : "").toMatch(/daily buy-ticket cap/);
  });

  it("stops new buys once the rolling friction budget is spent", () => {
    // 40bps of a £10,300 NAV = £41.20 budget; £40 already spent.
    const plan = planAdmissions([buy("HSBA.L", 900, 7)], { ...base, trailingCostBase: 40 });
    const d = plan.decisions[0]!;
    expect(d.kind).toBe("skip");
    expect("reason" in d ? d.reason : "").toMatch(/trailing cost budget exhausted/);
  });

  it("rests a symbol after a recent buy (anti-fragmentation)", () => {
    // MKS.L was bought nine separate times; the cooldown collapses that.
    const plan = planAdmissions([buy("MKS.L", 900)], {
      ...base,
      lastBuyDaysAgo: { "MKS.L": 1 },
    });
    const d = plan.decisions[0]!;
    expect(d.kind).toBe("skip");
    expect("reason" in d ? d.reason : "").toMatch(/churn guard/);
    // Past the cooldown it is admitted again.
    expect(
      planAdmissions([buy("MKS.L", 900)], { ...base, lastBuyDaysAgo: { "MKS.L": 9 } }).decisions[0]!.kind,
    ).toBe("admit");
  });

  it("loosens caps as the account grows", () => {
    expect(governorForNav(10_000).maxBuysPerDay).toBe(3);
    expect(governorForNav(60_000).maxBuysPerDay).toBe(5);
    expect(governorForNav(500_000).minTicketPctOfNav).toBe(0.01);
  });

  it("keeps the budget denominated in NAV, so it scales with the account", () => {
    const small = planAdmissions([buy("X", 900, 20)], { ...base, trailingCostBase: 30 });
    expect(small.decisions[0]!.kind).toBe("skip");
    const large = planAdmissions([buy("X", 9_000, 20)], {
      ...base,
      navBase: 100_000,
      trailingCostBase: 30,
      ...governorForNav(100_000),
    });
    expect(large.decisions[0]!.kind).toBe("admit");
  });
});
