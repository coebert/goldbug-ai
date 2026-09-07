import { describe, expect, it } from "vitest";
import { buildHoldingEquityChangeRows } from "@/lib/holding-equity-change";
import type { HoldingSeries } from "@/lib/holdings-history.functions";

const holding = (overrides: Partial<HoldingSeries>): HoldingSeries => ({
  symbol: "AAA",
  opened_at: "2026-01-01T09:00:00Z",
  avg_cost: 100,
  quantity: 2,
  closes: [100, 110, 90],
  dailyAt: ["2026-01-01T09:00:00Z", "2026-01-02", "2026-01-03"],
  hourly: [],
  hourlyAt: [],
  currentPrice: 90,
  pctChangeSincePurchase: -0.1,
  valueChangeSincePurchase: -20,
  points: 3,
  hourlyStale: false,
  ...overrides,
});

describe("buildHoldingEquityChangeRows", () => {
  it("rebases each holding to its own purchase cost", () => {
    const result = buildHoldingEquityChangeRows([
      holding({}),
      holding({
        symbol: "BBB",
        avg_cost: 50,
        closes: [50, 40],
        dailyAt: ["2026-01-02T10:00:00Z", "2026-01-03"],
      }),
    ]);

    expect(result.symbols).toEqual(["AAA", "BBB"]);
    expect(result.rows).toEqual([
      { at: "2026-01-01T09:00:00Z", AAA: 0 },
      { at: "2026-01-02", AAA: 10.000000000000009 },
      { at: "2026-01-02T10:00:00Z", BBB: 0 },
      { at: "2026-01-03", AAA: -9.999999999999998, BBB: -19.999999999999996 },
    ]);
  });

  it("omits holdings without a valid aligned purchase baseline", () => {
    const result = buildHoldingEquityChangeRows([
      holding({ symbol: "ZERO", avg_cost: 0 }),
      holding({ symbol: "BROKEN", dailyAt: [] }),
    ]);
    expect(result).toEqual({ rows: [], symbols: [] });
  });
});