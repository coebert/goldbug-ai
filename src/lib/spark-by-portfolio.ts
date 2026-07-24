// Extracted so the home-page sparkline mapping can be unit-tested. The rule:
// each portfolio's sparkline uses ONLY that portfolio's own equity snapshots
// (from `perPortfolioSeries`), never the merged multi-portfolio `series`
// axis — which would back-fill starting_cash on other portfolios' snapshot
// dates and produce a fake flat-then-drop curve.
//
// This module also runtime-validates its input: if the caller accidentally
// passes cross-portfolio-merged data (two portfolios sharing the exact same
// snapshot dates with a leading flat run of identical values on one — the
// signature of back-filled starting_cash), the offending portfolio's series
// is dropped, an error is logged, and its sparkline shows the empty state
// instead of a misleading curve. Use `detectCrossPortfolioMerging` directly
// for callers that want to render an explicit "chart unavailable" hint.

export type SparkPoint = { date: string; value: number };

export type EquityData =
  | {
      portfolios?: Array<{ id: string; mode?: string }>;
      perPortfolioSeries?: Record<string, SparkPoint[]>;
      // Merged axis is intentionally NOT consumed here.
      series?: Array<Record<string, unknown>>;
    }
  | undefined;

export type MergingIssue = {
  portfolioId: string;
  reason: "shared_date_axis_with_leading_flat_run";
  collidesWith: string;
  leadingFlatRun: number;
  totalPoints: number;
};

/**
 * Detects the classic cross-portfolio-merged input shape: portfolio A's own
 * series has the same dates as portfolio B's own series AND starts with a
 * run of ≥2 identical values followed by a change. That is the exact shape
 * produced when the caller mistakenly copies the merged `series` axis into
 * `perPortfolioSeries[id]`, back-filling starting_cash on days the portfolio
 * did not yet exist.
 *
 * A single portfolio with a flat-then-change curve is not enough — real
 * portfolios can plausibly sit at cash for days. The corroborating signal
 * is the *shared date axis* with another portfolio.
 */
export function detectCrossPortfolioMerging(data: EquityData): MergingIssue[] {
  const portfolios = data?.portfolios ?? [];
  const own = data?.perPortfolioSeries ?? {};
  const issues: MergingIssue[] = [];

  const axes = portfolios.map((p) => {
    const s = own[p.id] ?? [];
    return { id: p.id, series: s, dateKey: s.map((pt) => pt.date).join("|") };
  });

  for (const a of axes) {
    if (a.series.length < 3) continue;
    // Leading flat run.
    let flat = 1;
    while (flat < a.series.length && a.series[flat].value === a.series[0].value) flat++;
    if (flat < 2) continue;
    if (flat === a.series.length) continue; // entirely flat — benign.

    // Corroborating shared date axis with another portfolio.
    const collider = axes.find(
      (b) => b.id !== a.id && b.series.length === a.series.length && b.dateKey === a.dateKey,
    );
    if (!collider) continue;

    issues.push({
      portfolioId: a.id,
      reason: "shared_date_axis_with_leading_flat_run",
      collidesWith: collider.id,
      leadingFlatRun: flat,
      totalPoints: a.series.length,
    });
  }

  return issues;
}

type Logger = Pick<Console, "error">;

export function computeSparkByPortfolio(
  data: EquityData,
  opts: { logger?: Logger } = {},
): Record<string, SparkPoint[]> {
  const map: Record<string, SparkPoint[]> = {};
  const portfolios = data?.portfolios ?? [];
  const own = data?.perPortfolioSeries ?? {};
  for (const p of portfolios) {
    map[p.id] = own[p.id] ?? [];
  }

  const issues = detectCrossPortfolioMerging(data);
  if (issues.length > 0) {
    const logger = opts.logger ?? console;
    for (const issue of issues) {
      logger.error(
        `[spark-by-portfolio] cross-portfolio date merging detected for portfolio ${issue.portfolioId}: ` +
          `${issue.leadingFlatRun}/${issue.totalPoints} leading points share the same value and its date axis ` +
          `matches portfolio ${issue.collidesWith} exactly. Dropping the series to avoid plotting a misleading curve.`,
        issue,
      );
      // Show empty chart state instead of the misleading curve.
      map[issue.portfolioId] = [];
    }
  }

  return map;
}
