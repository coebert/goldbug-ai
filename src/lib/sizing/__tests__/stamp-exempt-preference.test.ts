import { describe, it, expect } from "vitest";
import {
  stampPreferenceWeight,
  stampPreferenceSurcharge,
  edgesComparable,
  breakEvenBps,
} from "../stamp-exempt-preference";
import { planAdmissions, edgePerCost, type GovernorCandidate } from "../../cost-governor";

const base = {
  navBase: 20_000,
  minTicketPctOfNav: 0.03,
  absoluteMinTicketBase: 250,
  maxBuysPerDay: 1,
  buysAlreadyToday: 0,
  costBudgetPctOfNav: 0.5,
  trailingCostBase: 0,
  addCooldownDays: 5,
  lastBuyDaysAgo: {} as Record<string, number | undefined>,
};

const ukStock: GovernorCandidate = {
  symbol: "MKS:xlon",
  side: "buy",
  notionalBase: 1_000,
  estCostBase: 9,
  edgeScore: 0.62,
  stampLiable: true,
};
const etf: GovernorCandidate = {
  symbol: "ISF:xlon",
  side: "buy",
  notionalBase: 1_000,
  estCostBase: 4,
  edgeScore: 0.6,
  stampLiable: false,
};

describe("stamp-exempt preference", () => {
  it("weights each level", () => {
    expect(stampPreferenceWeight("off")).toBe(0);
    expect(stampPreferenceWeight("balanced")).toBe(0.5);
    expect(stampPreferenceWeight("strong")).toBe(1);
    expect(stampPreferenceWeight(undefined)).toBe(0);
  });

  it("only surcharges stamp-liable tickets", () => {
    expect(stampPreferenceSurcharge({ notionalBase: 1_000, stampLiable: false, level: "strong" })).toBe(0);
    expect(stampPreferenceSurcharge({ notionalBase: 1_000, stampLiable: true, level: "strong" })).toBeCloseTo(5, 6);
    expect(stampPreferenceSurcharge({ notionalBase: 1_000, stampLiable: true, level: "balanced" })).toBeCloseTo(2.5, 6);
    expect(stampPreferenceSurcharge({ notionalBase: 1_000, stampLiable: true, level: "off" })).toBe(0);
  });

  it("reports break-even bps", () => {
    expect(breakEvenBps({ notionalBase: 1_000, estCostBase: 9 })).toBeCloseTo(90, 6);
    expect(breakEvenBps({ notionalBase: 0, estCostBase: 9 })).toBe(Infinity);
  });

  it("treats near-equal edges as comparable", () => {
    expect(edgesComparable(1, 1.05)).toBe(true);
    expect(edgesComparable(1, 1.5)).toBe(false);
  });

  it("lowers the ranked edge of a stamp-liable ticket", () => {
    expect(edgePerCost(ukStock, "strong")).toBeLessThan(edgePerCost(ukStock, "off"));
    expect(edgePerCost(etf, "strong")).toBe(edgePerCost(etf, "off"));
  });
});

describe("planAdmissions with the preference", () => {
  it("admits the stamp-exempt ETF over a comparable UK single stock", () => {
    const plan = planAdmissions([ukStock, etf], { ...base, stampExemptPreference: "balanced" });
    const admitted = plan.decisions.filter((d) => d.kind === "admit").map((d) => d.candidate.symbol);
    expect(admitted).toEqual(["ISF:xlon"]);
  });

  it("still admits a UK stock whose signal is clearly stronger", () => {
    const strongStock: GovernorCandidate = { ...ukStock, edgeScore: 1, expectedMovePct: 0.2 };
    const plan = planAdmissions([strongStock, etf], { ...base, stampExemptPreference: "strong" });
    const admitted = plan.decisions.filter((d) => d.kind === "admit").map((d) => d.candidate.symbol);
    expect(admitted).toEqual(["MKS:xlon"]);
  });

  it("is inert when the preference is off", () => {
    const cheapStock: GovernorCandidate = { ...ukStock, estCostBase: 3, edgeScore: 0.61 };
    const plan = planAdmissions([cheapStock, etf], { ...base, stampExemptPreference: "off" });
    const admitted = plan.decisions.filter((d) => d.kind === "admit").map((d) => d.candidate.symbol);
    expect(admitted).toEqual(["MKS:xlon"]);
  });

  it("never gates sells", () => {
    const plan = planAdmissions(
      [{ ...ukStock, side: "sell" }, etf],
      { ...base, maxBuysPerDay: 0, stampExemptPreference: "strong" },
    );
    const sell = plan.decisions.find((d) => d.candidate.side === "sell");
    expect(sell?.kind).toBe("admit");
  });
});
