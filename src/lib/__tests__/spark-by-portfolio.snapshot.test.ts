// Snapshot tests locking in the shape of `computeSparkByPortfolio` output
// across representative multi-portfolio scenarios. If the selector ever
// starts back-filling dates from another portfolio's series or from the
// merged `series` axis, the snapshot diff will fail loudly.
//
// Fixtures live in ./fixtures/portfolios so they can be reused by future
// UI / regression tests without redefining the shape.
import { describe, expect, it } from "vitest";
import { computeSparkByPortfolio } from "../spark-by-portfolio";
import {
  PORTFOLIO_IDS,
  fixtures,
  mixedDashboard,
  partialOverlap,
} from "./fixtures/portfolios";

describe("computeSparkByPortfolio — snapshot coverage", () => {
  for (const [name, data] of Object.entries(fixtures)) {
    it(`matches snapshot for '${name}'`, () => {
      expect(computeSparkByPortfolio(data)).toMatchSnapshot();
    });
  }

  it("mixed dashboard: no portfolio inherits another portfolio's dates", () => {
    const out = computeSparkByPortfolio(mixedDashboard);

    const liveDates = out[PORTFOLIO_IDS.liveNew].map((p) => p.date);
    const simDates = out[PORTFOLIO_IDS.simMature].map((p) => p.date);

    // Live has ONLY its single native date — not the sim's earlier dates.
    expect(liveDates).toEqual(["2026-07-24"]);
    // Sim dates are its own five snapshots — the live portfolio's presence
    // in the merged axis does not add or remove any.
    expect(simDates).toEqual([
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
      "2026-07-24",
    ]);

    // The phantom back-fill value (330) from the merged axis must not
    // appear in the live portfolio's own sparkline series.
    expect(out[PORTFOLIO_IDS.liveNew].some((p) => p.value === 330)).toBe(false);

    // A portfolio present in the merged axis but missing from
    // perPortfolioSeries yields an empty array — never a synthesised series.
    expect(out[PORTFOLIO_IDS.simEmpty]).toEqual([]);
  });

  it("partial overlap: shorter portfolio is not padded to the longer one's axis", () => {
    const out = computeSparkByPortfolio(partialOverlap);
    expect(out[PORTFOLIO_IDS.simVolatile].map((p) => p.date)).toEqual([
      "2026-07-22",
      "2026-07-23",
      "2026-07-24",
    ]);
    // Padding would inject value=500 on 2026-07-20 & 21 — verify absent.
    const first = out[PORTFOLIO_IDS.simVolatile][0];
    expect(first.date).toBe("2026-07-22");
  });
});
