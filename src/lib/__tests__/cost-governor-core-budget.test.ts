import { describe, it, expect } from "vitest";
import { planAdmissions, type GovernorCandidate } from "../cost-governor";

const base = {
  navBase: 10_000,
  minTicketPctOfNav: 0.03,
  absoluteMinTicketBase: 250,
  maxBuysPerDay: 3,
  buysAlreadyToday: 0,
  costBudgetPctOfNav: 0.004,
  // Window budget long since spent by short-term churn.
  trailingCostBase: 190,
  addCooldownDays: 5,
  lastBuyDaysAgo: {} as Record<string, number | undefined>,
};

const core: GovernorCandidate = {
  symbol: "VWRL.L",
  side: "buy",
  notionalBase: 800,
  estCostBase: 3.3,
  edgeScore: 0.4,
  expectedMovePct: 0.01,
  diversifiedFund: true,
};

describe("core top-ups vs the friction budget", () => {
  it("admits the owner-set core holding when the window budget is exhausted", () => {
    const plan = planAdmissions([core], {
      ...base,
      coreSymbolKey: "VWRL.L",
      coreCapPctOfNav: 0.55,
    });
    expect(plan.decisions[0]!.kind).toBe("admit");
  });

  it("still blocks an ordinary idea on the same exhausted budget", () => {
    const plan = planAdmissions([{ ...core, symbol: "BP.L", diversifiedFund: false }], {
      ...base,
      coreSymbolKey: "VWRL.L",
      coreCapPctOfNav: 0.55,
    });
    const d = plan.decisions[0]!;
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") expect(d.reason).toMatch(/trailing cost budget exhausted/);
  });

  it("still enforces the core cap on the core symbol", () => {
    const plan = planAdmissions([{ ...core, notionalBase: 5_000 }], {
      ...base,
      coreSymbolKey: "VWRL.L",
      coreCapPctOfNav: 0.55,
      positionExposureBase: { VWRL: 0 },
    });
    const d = plan.decisions[0]!;
    expect(d.kind).toBe("admit");

    const over = planAdmissions([{ ...core, notionalBase: 6_000 }], {
      ...base,
      coreSymbolKey: "VWRL.L",
      coreCapPctOfNav: 0.55,
      positionExposureBase: { VWRL: 2_000 },
    });
    const o = over.decisions[0]!;
    expect(o.kind).toBe("skip");
    if (o.kind === "skip") expect(o.reason).toMatch(/core-holding cap/);
  });
});
