// End-to-end test: when the home dashboard receives the classic
// cross-portfolio-merged input shape (a caller mistakenly copied the merged
// multi-portfolio `series` axis into `perPortfolioSeries[id]`, back-filling
// starting_cash on days the portfolio did not yet exist), the rendered
// sparkline for the offending portfolio must show the "Not enough data for
// trend" empty state with NO plotted SVG path — never the misleading
// flat-then-drop curve.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Sparkline } from "../sparkline";
import { computeSparkByPortfolio } from "@/lib/spark-by-portfolio";
import { crossPortfolioMerged, PORTFOLIO_IDS } from "@/lib/__tests__/fixtures/portfolios";

const WIDTH = 120;
const HEIGHT = 36;

describe("home sparkline (e2e) — cross-portfolio-merged input", () => {
  it("renders empty state with no <path> for the merged portfolio and logs an error", () => {
    const logger = { error: vi.fn() };
    const sparkByPortfolio = computeSparkByPortfolio(crossPortfolioMerged, { logger });

    // The offending portfolio's series must be dropped entirely.
    const own = sparkByPortfolio[PORTFOLIO_IDS.liveNew];
    expect(own).toEqual([]);

    const html = renderToStaticMarkup(
      <Sparkline values={own.map((p) => p.value)} width={WIDTH} height={HEIGHT} />,
    );

    // Empty state — no polyline is drawn.
    expect(html).not.toContain("<path");
    expect(html).toContain('aria-label="Not enough data for trend"');
    // Neither the phantom starting_cash (330) nor the real last value
    // (300.46) may leak into the rendered SVG.
    expect(html).not.toMatch(/330(\.|,|<|")/);
    expect(html).not.toContain("300.46");

    // A single error is logged pinpointing the offending portfolio.
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [msg, meta] = logger.error.mock.calls[0];
    expect(msg).toContain(PORTFOLIO_IDS.liveNew);
    expect(meta).toMatchObject({
      portfolioId: PORTFOLIO_IDS.liveNew,
      reason: "shared_date_axis_with_leading_flat_run",
      collidesWith: PORTFOLIO_IDS.simMature,
    });
  });

  it("still renders the unaffected portfolio's sparkline normally", () => {
    const sparkByPortfolio = computeSparkByPortfolio(crossPortfolioMerged, {
      logger: { error: vi.fn() },
    });
    const own = sparkByPortfolio[PORTFOLIO_IDS.simMature];
    expect(own).toHaveLength(5);

    const html = renderToStaticMarkup(
      <Sparkline values={own.map((p) => p.value)} width={WIDTH} height={HEIGHT} />,
    );
    // Real polyline drawn for the untouched portfolio.
    expect(html).toContain("<path");
    expect(html).not.toContain('aria-label="Not enough data for trend"');
  });
});
