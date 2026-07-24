// Performance guardrail for the sparkline validation pipeline.
//
// The home dashboard renders one sparkline per portfolio on every equity
// refresh, so both `detectCrossPortfolioMerging` and `computeSparkByPortfolio`
// sit on the render path. This test builds a realistically large dataset
// (many portfolios × many daily snapshots, with a subset intentionally
// exhibiting the cross-portfolio-merged shape) and asserts the pipeline
// stays comfortably under a real-time budget.
//
// Budgets are deliberately generous vs. observed local runs (~single-digit
// ms for 500×365) so CI noise doesn't flake the test. If a regression
// pushes work into O(N²) territory or introduces per-point allocations,
// these thresholds will catch it.
import { describe, expect, it } from "vitest";
import {
  computeSparkByPortfolio,
  detectCrossPortfolioMerging,
  type EquityData,
  type SparkPoint,
} from "../spark-by-portfolio";

const PORTFOLIO_COUNT = 500;
const DAYS_PER_PORTFOLIO = 365;
// Fraction of portfolios that mimic the bug shape (leading flat run + a
// paired collider sharing the exact same date axis).
const MERGED_PAIRS = 25;

// Budgets in ms. 60fps ≈ 16.6ms per frame; we allow up to ~40ms for a
// full 500-portfolio validation+selection pass so the render thread has
// headroom for React reconciliation.
const DETECT_BUDGET_MS = 40;
const COMPUTE_BUDGET_MS = 60; // detect + shallow map copy
const WARMUP_ITERATIONS = 2;
const MEASURED_ITERATIONS = 5;

function buildLargeDataset(): EquityData {
  const portfolios: Array<{ id: string; mode: string }> = [];
  const perPortfolioSeries: Record<string, SparkPoint[]> = {};

  // Shared date axis for the paired (merged-bug) portfolios so the
  // detector's shared-axis check fires on them.
  const sharedAxis: string[] = [];
  for (let d = 0; d < DAYS_PER_PORTFOLIO; d++) {
    // Deterministic ISO dates starting 2020-01-01.
    const dt = new Date(Date.UTC(2020, 0, 1 + d));
    sharedAxis.push(dt.toISOString().slice(0, 10));
  }

  for (let i = 0; i < PORTFOLIO_COUNT; i++) {
    const id = `pf-${i.toString().padStart(4, "0")}`;
    portfolios.push({ id, mode: i % 3 === 0 ? "live_prod" : "paper" });

    if (i < MERGED_PAIRS * 2) {
      // First 2*MERGED_PAIRS portfolios are paired: even index = back-filled
      // (leading flat run), odd index = the collider on the same axis.
      const isBackfilled = i % 2 === 0;
      const start = 1000 + i * 3;
      perPortfolioSeries[id] = sharedAxis.map((date, d) => ({
        date,
        value: isBackfilled
          ? d < 30
            ? start // 30-day leading flat run
            : start + (d - 30) * 0.5
          : start + d * 0.7,
      }));
    } else {
      // Well-formed portfolio: unique date axis (offset by i) so it can't
      // collide, with a varying curve.
      perPortfolioSeries[id] = Array.from({ length: DAYS_PER_PORTFOLIO }, (_, d) => {
        const dt = new Date(Date.UTC(2020, 0, 1 + d + i));
        return {
          date: dt.toISOString().slice(0, 10),
          value: 1000 + Math.sin(d / 12 + i) * 25 + d * 0.1,
        };
      });
    }
  }

  return { portfolios, perPortfolioSeries, series: [] };
}

function measure(fn: () => void): number {
  for (let i = 0; i < WARMUP_ITERATIONS; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < MEASURED_ITERATIONS; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  // Median is more stable than mean on noisy CI runners.
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

describe("spark-by-portfolio — performance", () => {
  const data = buildLargeDataset();
  const noopLogger = { error: () => {} };

  it(`detectCrossPortfolioMerging stays under ${DETECT_BUDGET_MS}ms for ${PORTFOLIO_COUNT} portfolios × ${DAYS_PER_PORTFOLIO} days`, () => {
    // Sanity: the fixture actually exercises the detector.
    const issues = detectCrossPortfolioMerging(data);
    expect(issues.length).toBe(MERGED_PAIRS);

    const median = measure(() => {
      detectCrossPortfolioMerging(data);
    });
    // Log for local visibility; useful when tuning.
    // eslint-disable-next-line no-console
    console.log(`[perf] detectCrossPortfolioMerging median=${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(DETECT_BUDGET_MS);
  });

  it(`computeSparkByPortfolio stays under ${COMPUTE_BUDGET_MS}ms for ${PORTFOLIO_COUNT} portfolios × ${DAYS_PER_PORTFOLIO} days`, () => {
    // Sanity: flagged portfolios are dropped, others survive with full series.
    const out = computeSparkByPortfolio(data, { logger: noopLogger });
    const flagged = Object.values(out).filter((s) => s.length === 0).length;
    const untouched = Object.values(out).filter((s) => s.length === DAYS_PER_PORTFOLIO).length;
    expect(flagged).toBe(MERGED_PAIRS);
    // Every non-flagged portfolio (including odd colliders and the tail)
    // keeps its full series.
    expect(untouched).toBe(PORTFOLIO_COUNT - MERGED_PAIRS);

    const median = measure(() => {
      computeSparkByPortfolio(data, { logger: noopLogger });
    });
    // eslint-disable-next-line no-console
    console.log(`[perf] computeSparkByPortfolio median=${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(COMPUTE_BUDGET_MS);
  });

  it("scales sub-quadratically: 2× portfolios costs well under 4× time", () => {
    // Guards against an accidental O(N²) regression in the detector. We
    // compare a small dataset to a 2× larger one and assert the runtime
    // ratio stays under 3.5× (linear ≈ 2×, we allow slack for constant
    // overhead and CI noise).
    const small = buildScaledDataset(50, 120);
    const large = buildScaledDataset(100, 120);

    const tSmall = measure(() => detectCrossPortfolioMerging(small));
    const tLarge = measure(() => detectCrossPortfolioMerging(large));

    // Avoid dividing by ~0 on very fast machines.
    const denom = Math.max(tSmall, 0.05);
    const ratio = tLarge / denom;
    // eslint-disable-next-line no-console
    console.log(
      `[perf] scaling: small=${tSmall.toFixed(2)}ms large=${tLarge.toFixed(2)}ms ratio=${ratio.toFixed(2)}×`,
    );
    expect(ratio).toBeLessThan(3.5);
  });
});

function buildScaledDataset(portfolioCount: number, days: number): EquityData {
  const portfolios: Array<{ id: string }> = [];
  const perPortfolioSeries: Record<string, SparkPoint[]> = {};
  for (let i = 0; i < portfolioCount; i++) {
    const id = `s-${i}`;
    portfolios.push({ id });
    perPortfolioSeries[id] = Array.from({ length: days }, (_, d) => {
      const dt = new Date(Date.UTC(2022, 0, 1 + d + i));
      return { date: dt.toISOString().slice(0, 10), value: 500 + d + i * 0.1 };
    });
  }
  return { portfolios, perPortfolioSeries, series: [] };
}
