// Unit tests focused on the exact console.error signal emitted when
// `computeSparkByPortfolio` detects the cross-portfolio-merged input shape.
//
// The existing validation tests assert the offending series is dropped;
// this file locks down the *log payload* — message content and the
// structured meta object — so consumers watching logs (dashboards, alerts,
// tests) can rely on which portfolios collided, the shared date axis they
// share, and the leading-flat-run length that fingerprinted the bug.
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeSparkByPortfolio } from "../spark-by-portfolio";
import { PORTFOLIO_IDS, crossPortfolioMerged } from "./fixtures/portfolios";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cross-portfolio merging — console.error detection payload", () => {
  it("uses the real global console.error by default and emits the full detection details", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    computeSparkByPortfolio(crossPortfolioMerged);

    expect(spy).toHaveBeenCalledTimes(1);
    const [message, meta] = spy.mock.calls[0];

    // Message must name the tag, the offending portfolio, the collider,
    // and the flat-run signature (4 of 5 leading points).
    expect(message).toEqual(expect.stringContaining("[spark-by-portfolio]"));
    expect(message).toEqual(expect.stringContaining("cross-portfolio date merging detected"));
    expect(message).toEqual(expect.stringContaining(PORTFOLIO_IDS.liveNew));
    expect(message).toEqual(expect.stringContaining(PORTFOLIO_IDS.simMature));
    expect(message).toEqual(expect.stringContaining("4/5 leading points"));
    expect(message).toEqual(expect.stringContaining("Dropping the series"));

    // Structured meta must exactly match the detected issue.
    expect(meta).toEqual({
      portfolioId: PORTFOLIO_IDS.liveNew,
      reason: "shared_date_axis_with_leading_flat_run",
      collidesWith: PORTFOLIO_IDS.simMature,
      leadingFlatRun: 4,
      totalPoints: 5,
    });
  });

  it("logs one error per offending portfolio, each with its own collider and flat-run count", () => {
    // Two independently-merged portfolios sharing dates with two different
    // colliders. Each collision must produce its own log entry with the
    // right pairing — never a single aggregated message.
    const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    const datesAB = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"];
    const datesCD = ["2026-02-01", "2026-02-02", "2026-02-03"];

    const logger = { error: vi.fn() };
    computeSparkByPortfolio(
      {
        portfolios: [{ id: A }, { id: B }, { id: C }, { id: D }],
        perPortfolioSeries: {
          // A back-filled against B on the AB axis — 3 leading flat points.
          [A]: datesAB.map((d, i) => ({ date: d, value: i < 3 ? 500 : 480 })),
          [B]: datesAB.map((d, i) => ({ date: d, value: 1000 + i * 10 })),
          // C back-filled against D on the CD axis — 2 leading flat points.
          [C]: datesCD.map((d, i) => ({ date: d, value: i < 2 ? 200 : 175 })),
          [D]: datesCD.map((d, i) => ({ date: d, value: 700 - i * 5 })),
        },
      },
      { logger },
    );

    expect(logger.error).toHaveBeenCalledTimes(2);

    const metas = logger.error.mock.calls.map((c) => c[1]);
    expect(metas).toEqual(
      expect.arrayContaining([
        {
          portfolioId: A,
          reason: "shared_date_axis_with_leading_flat_run",
          collidesWith: B,
          leadingFlatRun: 3,
          totalPoints: 4,
        },
        {
          portfolioId: C,
          reason: "shared_date_axis_with_leading_flat_run",
          collidesWith: D,
          leadingFlatRun: 2,
          totalPoints: 3,
        },
      ]),
    );

    // And each message references its own pair, not the other's.
    const forA = logger.error.mock.calls.find((c) => c[1].portfolioId === A)![0] as string;
    const forC = logger.error.mock.calls.find((c) => c[1].portfolioId === C)![0] as string;
    expect(forA).toContain(A);
    expect(forA).toContain(B);
    expect(forA).toContain("3/4 leading points");
    expect(forA).not.toContain(C);
    expect(forA).not.toContain(D);
    expect(forC).toContain(C);
    expect(forC).toContain(D);
    expect(forC).toContain("2/3 leading points");
    expect(forC).not.toContain(A);
    expect(forC).not.toContain(B);
  });

  it("does NOT call console.error for well-formed input", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    computeSparkByPortfolio({
      portfolios: [{ id: PORTFOLIO_IDS.simMature }],
      perPortfolioSeries: {
        [PORTFOLIO_IDS.simMature]: [
          { date: "2026-07-20", value: 1000 },
          { date: "2026-07-21", value: 1010 },
          { date: "2026-07-22", value: 990 },
        ],
      },
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
