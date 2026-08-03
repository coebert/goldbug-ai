import { describe, it, expect } from "vitest";
import { buildHedgeFallbackRow } from "../hedge-fallback-audit.server";

const base = {
  userId: "u1",
  portfolioId: "p1",
  currency: "gbp",
  applied: true,
  appliedNotional: 512.5,
  runDate: "2026-08-03",
};

describe("hedge fallback audit row", () => {
  it("records blocked primary, chosen alternative and reason", () => {
    const row = buildHedgeFallbackRow({
      ...base,
      audit: {
        side: "buy",
        primarySymbol: "SGLN.L",
        chosenSymbol: "SGLD.L",
        reasonCode: "broker_block",
        reasonDetail: "[hedge fallback: SGLN.L unusable (broker block) → SGLD.L]",
        candidates: [{ symbol: "SGLN.L", reason: "broker block (suitability/permissions)" }],
        targetNotional: 600,
      },
    });
    expect(row.primary_symbol).toBe("SGLN.L");
    expect(row.chosen_symbol).toBe("SGLD.L");
    expect(row.reason_code).toBe("broker_block");
    expect(row.reason_detail).toContain("SGLD.L");
    expect(row.candidates).toHaveLength(1);
    expect(row.currency).toBe("GBP");
    expect(row.applied).toBe(true);
    expect(row.applied_notional).toBe(512.5);
    expect(row.target_notional).toBe(600);
    expect(row.run_date).toBe("2026-08-03");
  });

  it("records a no-substitute event with a null chosen symbol", () => {
    const row = buildHedgeFallbackRow({
      ...base,
      applied: false,
      appliedNotional: Number.NaN,
      audit: {
        side: "buy",
        primarySymbol: "SGLN.L",
        chosenSymbol: null,
        reasonCode: "no_eligible_candidate",
        reasonDetail: "no eligible gold hedge instrument",
        candidates: [
          { symbol: "SGLN.L", reason: "broker block (suitability/permissions)" },
          { symbol: "SGLD.L", reason: "no live price" },
        ],
        targetNotional: 400,
      },
    });
    expect(row.chosen_symbol).toBeNull();
    expect(row.applied).toBe(false);
    expect(row.applied_notional).toBe(0);
    expect(row.candidates).toHaveLength(2);
  });

  it("defaults the run date when not supplied", () => {
    const row = buildHedgeFallbackRow({
      ...base,
      runDate: null,
      audit: {
        side: "sell",
        primarySymbol: "GLD",
        chosenSymbol: "IAU",
        reasonCode: "nothing_held",
        reasonDetail: "GLD unusable (nothing held to unwind)",
        candidates: [{ symbol: "GLD", reason: "nothing held to unwind" }],
        targetNotional: 100,
      },
    });
    expect(row.run_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.side).toBe("sell");
  });
});
