import { describe, expect, it } from "vitest";
import {
  buildImpactPreview,
  bestValueOption,
  estimateOptionImpact,
} from "@/lib/corporate-action-impact";
import { classifyOptionKind, parseRatio } from "@/lib/corporate-actions";
import type { CorporateActionOption } from "@/lib/corporate-actions";

function opt(p: Partial<CorporateActionOption>): CorporateActionOption {
  return {
    id: null,
    label: "Option",
    isDefault: false,
    detail: null,
    kind: "unknown",
    rate: null,
    currency: null,
    ratio: null,
    ...p,
  };
}

describe("option classification", () => {
  it("separates cash from scrip", () => {
    expect(classifyOptionKind("Cash dividend")).toBe("cash");
    expect(classifyOptionKind("Dividend reinvestment in new ordinary shares")).toBe(
      "securities",
    );
    expect(classifyOptionKind("Something else")).toBe("unknown");
  });

  it("parses ratios in several notations", () => {
    expect(parseRatio("1:20")).toBeCloseTo(0.05);
    expect(parseRatio("1 for 20")).toBeCloseTo(0.05);
    expect(parseRatio("0.05")).toBeCloseTo(0.05);
    expect(parseRatio("nonsense")).toBeNull();
  });
});

describe("cash-vs-scrip impact", () => {
  const position = { quantity: 22, price: 50, currency: "GBP" };

  it("estimates a cash election from the per-share rate", () => {
    const impact = estimateOptionImpact(
      opt({ kind: "cash", label: "Cash", rate: 0.4 }),
      position,
      0.4 * 22,
    );
    expect(impact.cashDelta).toBeCloseTo(8.8);
    expect(impact.sharesDelta).toBe(0);
    expect(impact.sharesAfter).toBe(22);
  });

  it("converts a scrip election into whole shares with cash in lieu", () => {
    // 8.80 entitlement / 50 per share = 0.176 shares → 0 whole, 8.80 residual
    const impact = estimateOptionImpact(
      opt({ kind: "securities", label: "Reinvest" }),
      position,
      8.8,
    );
    expect(impact.sharesDelta).toBe(0);
    expect(impact.fractionalCash).toBeCloseTo(8.8);
  });

  it("uses a published ratio when available", () => {
    const impact = estimateOptionImpact(
      opt({ kind: "securities", label: "Scrip", ratio: 0.05 }),
      position,
      null,
    );
    expect(impact.sharesDelta).toBe(1); // floor(22 * 0.05)
    expect(impact.sharesAfter).toBe(23);
    expect(impact.fractionalCash).toBeCloseTo(5); // 0.1 share × 50
  });

  it("reports no position rather than inventing numbers", () => {
    const preview = buildImpactPreview([opt({ kind: "cash", rate: 1 })], null);
    expect(preview.impacts).toHaveLength(0);
    expect(preview.unavailableReason).toMatch(/no open position/i);
  });

  it("prices a scrip option from a sibling cash option's rate", () => {
    const preview = buildImpactPreview(
      [
        opt({ id: "1", kind: "cash", label: "Cash dividend", rate: 10 }),
        opt({ id: "2", kind: "securities", label: "Reinvest in shares" }),
      ],
      position,
    );
    expect(preview.unavailableReason).toBeNull();
    const scrip = preview.impacts[1]!;
    expect(scrip.sharesDelta).toBe(4); // 220 / 50
    expect(scrip.totalValue).toBeCloseTo(220);
  });

  it("calls no winner when the two options are within half a percent", () => {
    const preview = buildImpactPreview(
      [
        opt({ id: "1", kind: "cash", label: "Cash", rate: 10 }),
        opt({ id: "2", kind: "securities", label: "Shares" }),
      ],
      { quantity: 10, price: 20, currency: "GBP" },
    );
    expect(bestValueOption(preview)).toBeNull();
  });
});
