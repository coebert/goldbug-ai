import { describe, it, expect } from "vitest";
import {
  qualifiesForCapOverride,
  stretchedCapPct,
  OVERRIDE_MAX_SINGLE_NAME_PCT,
} from "../high-conviction-override";
import { planSectorAdmissions, DEFAULT_SECTOR_BUDGET } from "../sector-concentration";

describe("high-conviction cap override", () => {
  it("needs both high conviction and edge well above friction", () => {
    expect(
      qualifiesForCapOverride({ edgeScore: 0.9, expectedMovePct: 0.06, notionalBase: 1000, estCostBase: 5 }),
    ).toBe(true);
    // strong conviction but the friction eats the edge
    expect(
      qualifiesForCapOverride({ edgeScore: 0.9, expectedMovePct: 0.01, notionalBase: 1000, estCostBase: 5 }),
    ).toBe(false);
    // good edge but ordinary conviction
    expect(
      qualifiesForCapOverride({ edgeScore: 0.6, expectedMovePct: 0.08, notionalBase: 1000, estCostBase: 5 }),
    ).toBe(false);
  });

  it("stretches a cap but never past the ceiling", () => {
    expect(stretchedCapPct(0.15, OVERRIDE_MAX_SINGLE_NAME_PCT)).toBeCloseTo(0.225, 6);
    expect(stretchedCapPct(0.2, OVERRIDE_MAX_SINGLE_NAME_PCT)).toBeCloseTo(0.25, 6);
  });

  it("admits a very strong idea that the sector budget would otherwise block", () => {
    const cfg = { navBase: 10_000, ...DEFAULT_SECTOR_BUDGET };
    const base = { symbol: "AAA", sector: "technology", notionalBase: 1_000 };
    const exposure = { technology: 2_000 };

    const blocked = planSectorAdmissions([base], exposure, cfg);
    expect(blocked.decisions[0]!.kind).toBe("skip");

    const strong = planSectorAdmissions(
      [{ ...base, edgeScore: 0.92, expectedMovePct: 0.07, estCostBase: 6 }],
      exposure,
      cfg,
    );
    expect(strong.decisions[0]!.kind).toBe("admit");
  });

  it("still blocks a strong idea beyond the stretched ceiling", () => {
    const cfg = { navBase: 10_000, ...DEFAULT_SECTOR_BUDGET };
    const plan = planSectorAdmissions(
      [
        {
          symbol: "AAA",
          sector: "technology",
          notionalBase: 3_000,
          edgeScore: 0.95,
          expectedMovePct: 0.09,
          estCostBase: 10,
        },
      ],
      { technology: 2_000 },
      cfg,
    );
    expect(plan.decisions[0]!.kind).toBe("skip");
  });
});
