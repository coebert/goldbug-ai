import { describe, expect, it } from "vitest";
import { computeSparkByPortfolio } from "../spark-by-portfolio";

const REAL = "11111111-1111-4111-8111-111111111111";
const SIM = "22222222-2222-4222-8222-222222222222";

describe("computeSparkByPortfolio", () => {
  it("returns each portfolio's own series verbatim", () => {
    const out = computeSparkByPortfolio({
      portfolios: [{ id: REAL, mode: "live_prod" }, { id: SIM, mode: "paper" }],
      perPortfolioSeries: {
        [REAL]: [{ date: "2026-07-24", value: 300.46 }],
        [SIM]: [
          { date: "2026-06-01", value: 1000 },
          { date: "2026-07-24", value: 1001 },
        ],
      },
      series: [],
    });
    expect(out[REAL]).toEqual([{ date: "2026-07-24", value: 300.46 }]);
    expect(out[SIM]).toHaveLength(2);
  });

  it("does not back-fill from other portfolios' dates (single-snapshot real portfolio stays 1 point)", () => {
    // The merged axis contains the sim portfolio's older dates, but the real
    // portfolio only has today. The sparkline must NOT reconstruct earlier
    // real-portfolio points at starting_cash.
    const out = computeSparkByPortfolio({
      portfolios: [{ id: REAL, mode: "live_prod" }, { id: SIM, mode: "paper" }],
      perPortfolioSeries: {
        [REAL]: [{ date: "2026-07-24", value: 300.46 }],
        [SIM]: [
          { date: "2026-06-01", value: 1000 },
          { date: "2026-07-01", value: 1050 },
          { date: "2026-07-24", value: 1001 },
        ],
      },
      series: [
        { date: "2026-06-01", [REAL]: 330, [SIM]: 1000 },
        { date: "2026-07-01", [REAL]: 330, [SIM]: 1050 },
        { date: "2026-07-24", [REAL]: 300.46, [SIM]: 1001 },
      ],
    });
    expect(out[REAL]).toEqual([{ date: "2026-07-24", value: 300.46 }]);
    expect(out[REAL].every((p) => p.value !== 330)).toBe(true);
  });

  it("ignores the merged `series` field entirely — deleting it does not change output", () => {
    const base = {
      portfolios: [{ id: REAL, mode: "live_prod" }],
      perPortfolioSeries: { [REAL]: [{ date: "2026-07-24", value: 300.46 }] },
    };
    const withMerged = computeSparkByPortfolio({
      ...base,
      series: [{ date: "2026-01-01", [REAL]: 330 }, { date: "2026-07-24", [REAL]: 300.46 }],
    });
    const withoutMerged = computeSparkByPortfolio(base);
    expect(withMerged).toEqual(withoutMerged);
  });

  it("returns an empty array for portfolios with no own snapshots", () => {
    const out = computeSparkByPortfolio({
      portfolios: [{ id: REAL, mode: "live_prod" }],
      perPortfolioSeries: {},
      series: [{ date: "2026-07-24", [REAL]: 330 }], // present in merged but ignored
    });
    expect(out[REAL]).toEqual([]);
  });

  it("handles missing/undefined data safely", () => {
    expect(computeSparkByPortfolio(undefined)).toEqual({});
    expect(computeSparkByPortfolio({})).toEqual({});
    expect(computeSparkByPortfolio({ portfolios: [] })).toEqual({});
  });
});
