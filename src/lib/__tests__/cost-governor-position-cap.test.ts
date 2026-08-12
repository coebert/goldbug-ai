import { describe, expect, it } from "vitest";
import { planAdmissions, DEFAULT_GOVERNOR, DEFAULT_MAX_POSITION_PCT_OF_NAV } from "../cost-governor";

const base = {
  ...DEFAULT_GOVERNOR,
  navBase: 10_000,
  buysAlreadyToday: 0,
  trailingCostBase: 0,
  lastBuyDaysAgo: {} as Record<string, number | undefined>,
};

const buy = (symbol: string, notionalBase: number) => ({
  symbol,
  side: "buy" as const,
  notionalBase,
  estCostBase: 4,
});

describe("cost governor single-name cap", () => {
  it("blocks an add that would push one name past the NAV cap", () => {
    const plan = planAdmissions([buy("MKS.L", 400)], {
      ...base,
      positionExposureBase: { "MKS.L": 1_300 }, // 13% already
    });
    const d = plan.decisions[0]!;
    expect(d.kind).toBe("skip");
    expect((d as { reason: string }).reason).toContain("single-name cap");
  });

  it("matches broker-native holding keys against order symbols", () => {
    // Exposure keyed as the holdings table stores it, normalised on load.
    const plan = planAdmissions([buy("MKS.L", 400)], {
      ...base,
      positionExposureBase: { "MKS.L": 1_600 },
    });
    expect(plan.decisions[0]!.kind).toBe("skip");
  });

  it("admits a first entry comfortably inside the cap", () => {
    const plan = planAdmissions([buy("VUSA.L", 400)], { ...base, positionExposureBase: {} });
    expect(plan.decisions[0]!.kind).toBe("admit");
    expect(DEFAULT_MAX_POSITION_PCT_OF_NAV).toBe(0.15);
  });

  it("counts admissions inside one tick so two tickets cannot jointly breach", () => {
    const plan = planAdmissions([buy("VUSA.L", 800), buy("VUSA.L", 800)], {
      ...base,
      positionExposureBase: {},
    });
    const kinds = plan.decisions.map((d) => d.kind);
    expect(kinds).toContain("admit");
    expect(kinds).toContain("skip");
  });

  it("never gates sells on the cap", () => {
    const plan = planAdmissions(
      [{ symbol: "MKS.L", side: "sell", notionalBase: 3_000, estCostBase: 5 }],
      { ...base, positionExposureBase: { "MKS.L": 3_100 } },
    );
    expect(plan.decisions[0]!.kind).toBe("admit");
  });
});
