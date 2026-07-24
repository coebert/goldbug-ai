// Runtime validation: `computeSparkByPortfolio` must detect the
// cross-portfolio-merged input shape, log an error, and drop the offending
// series so the UI falls back to the empty-chart state.
import { describe, expect, it, vi } from "vitest";
import { computeSparkByPortfolio, detectCrossPortfolioMerging } from "../spark-by-portfolio";
import {
  PORTFOLIO_IDS,
  crossPortfolioMerged,
  mixedDashboard,
  partialOverlap,
} from "./fixtures/portfolios";

function makeLogger() {
  return { error: vi.fn() };
}

describe("cross-portfolio merging — runtime validation", () => {
  it("flags the offending portfolio when its dates match another AND it has a leading flat run", () => {
    const issues = detectCrossPortfolioMerging(crossPortfolioMerged);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      portfolioId: PORTFOLIO_IDS.liveNew,
      collidesWith: PORTFOLIO_IDS.simMature,
      reason: "shared_date_axis_with_leading_flat_run",
      leadingFlatRun: 4,
      totalPoints: 5,
    });
  });

  it("returns an empty series for the flagged portfolio and logs an error", () => {
    const logger = makeLogger();
    const out = computeSparkByPortfolio(crossPortfolioMerged, { logger });

    // Empty-chart state, not the phantom curve.
    expect(out[PORTFOLIO_IDS.liveNew]).toEqual([]);
    // Unaffected portfolios still get their own series.
    expect(out[PORTFOLIO_IDS.simMature]).toHaveLength(5);

    // Exactly one error, referencing the offending portfolio id.
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [msg, meta] = logger.error.mock.calls[0];
    expect(String(msg)).toContain(PORTFOLIO_IDS.liveNew);
    expect(String(msg)).toContain("cross-portfolio date merging detected");
    expect(meta).toMatchObject({ portfolioId: PORTFOLIO_IDS.liveNew });
  });

  it("does NOT flag well-formed fixtures", () => {
    expect(detectCrossPortfolioMerging(mixedDashboard)).toEqual([]);
    expect(detectCrossPortfolioMerging(partialOverlap)).toEqual([]);
    const logger = makeLogger();
    computeSparkByPortfolio(mixedDashboard, { logger });
    computeSparkByPortfolio(partialOverlap, { logger });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does NOT flag a lone portfolio with a flat-then-change curve (real cash sitting idle)", () => {
    // No corroborating shared-axis collider → benign, no false positive.
    const issues = detectCrossPortfolioMerging({
      portfolios: [{ id: PORTFOLIO_IDS.liveNew, mode: "live_prod" }],
      perPortfolioSeries: {
        [PORTFOLIO_IDS.liveNew]: [
          { date: "2026-07-20", value: 330 },
          { date: "2026-07-21", value: 330 },
          { date: "2026-07-22", value: 330 },
          { date: "2026-07-23", value: 330 },
          { date: "2026-07-24", value: 300.46 },
        ],
      },
    });
    expect(issues).toEqual([]);
  });

  it("does NOT flag portfolios that share dates but have no leading flat run", () => {
    // Two portfolios happening to snapshot on the same 3 days with varying
    // values on both — legitimate concurrent activity.
    const issues = detectCrossPortfolioMerging({
      portfolios: [
        { id: PORTFOLIO_IDS.liveNew, mode: "live_prod" },
        { id: PORTFOLIO_IDS.simMature, mode: "paper" },
      ],
      perPortfolioSeries: {
        [PORTFOLIO_IDS.liveNew]: [
          { date: "2026-07-22", value: 300 },
          { date: "2026-07-23", value: 305 },
          { date: "2026-07-24", value: 310 },
        ],
        [PORTFOLIO_IDS.simMature]: [
          { date: "2026-07-22", value: 1000 },
          { date: "2026-07-23", value: 1010 },
          { date: "2026-07-24", value: 990 },
        ],
      },
    });
    expect(issues).toEqual([]);
  });

  it("does NOT flag an entirely flat portfolio (all values identical)", () => {
    // Fully flat curves are benign; only leading-flat-then-change with a
    // shared axis is the back-fill signature.
    const issues = detectCrossPortfolioMerging({
      portfolios: [
        { id: PORTFOLIO_IDS.liveNew, mode: "live_prod" },
        { id: PORTFOLIO_IDS.simMature, mode: "paper" },
      ],
      perPortfolioSeries: {
        [PORTFOLIO_IDS.liveNew]: [
          { date: "2026-07-22", value: 330 },
          { date: "2026-07-23", value: 330 },
          { date: "2026-07-24", value: 330 },
        ],
        [PORTFOLIO_IDS.simMature]: [
          { date: "2026-07-22", value: 1000 },
          { date: "2026-07-23", value: 1010 },
          { date: "2026-07-24", value: 990 },
        ],
      },
    });
    expect(issues).toEqual([]);
  });
});
