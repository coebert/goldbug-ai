import { describe, expect, it } from "vitest";
import { isDiversifiedFund } from "../diversified-fund";
import { planAdmissions, DEFAULT_GOVERNOR } from "../cost-governor";

const base = {
  ...DEFAULT_GOVERNOR,
  navBase: 10_000,
  buysAlreadyToday: 0,
  trailingCostBase: 0,
  lastBuyDaysAgo: {} as Record<string, number | undefined>,
};

describe("isDiversifiedFund", () => {
  it("recognises broad trackers", () => {
    expect(isDiversifiedFund({ symbol: "VWRL.L", assetClass: "etf" })).toBe(true);
    expect(isDiversifiedFund({ symbol: "VUSA.L:xlon", assetClass: "etf" })).toBe(true);
  });

  it("rejects single stocks and concentrating products", () => {
    expect(isDiversifiedFund({ symbol: "BP.L", assetClass: "stock" })).toBe(false);
    expect(
      isDiversifiedFund({ symbol: "XUKS.L", assetClass: "etf", name: "Xtrackers FTSE 100 Short Daily ETF" }),
    ).toBe(false);
    expect(isDiversifiedFund({ symbol: "SGLN.L", assetClass: "etf", name: "iShares Physical Gold ETC" })).toBe(false);
  });
});

describe("position cap", () => {
  const candidate = (symbol: string, diversifiedFund: boolean) => ({
    symbol,
    side: "buy" as const,
    notionalBase: 1_000,
    estCostBase: 5,
    edgeScore: 0.8,
    expectedMovePct: 0.05,
    diversifiedFund,
  });

  it("blocks a single name above 15% of NAV", () => {
    const plan = planAdmissions([candidate("BP.L", false)], {
      ...base,
      positionExposureBase: { "BP.L": 900 },
    });
    const d = plan.decisions[0]!;
    expect(d.kind).toBe("skip");
    expect((d as { reason: string }).reason).toContain("single-name cap");
  });

  it("allows a broad fund past the single-name cap", () => {
    const plan = planAdmissions([candidate("VWRL.L", true)], {
      ...base,
      positionExposureBase: { "VWRL.L": 900 },
    });
    expect(plan.decisions[0]!.kind).toBe("admit");
  });

  it("still caps a broad fund at the wider limit", () => {
    const plan = planAdmissions([candidate("VWRL.L", true)], {
      ...base,
      positionExposureBase: { "VWRL.L": 3_400 },
    });
    const d = plan.decisions[0]!;
    expect(d.kind).toBe("skip");
    expect((d as { reason: string }).reason).toContain("diversified-fund cap");
  });
});
