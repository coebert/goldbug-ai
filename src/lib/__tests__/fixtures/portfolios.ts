// Reusable portfolio fixtures for sparkline / equity-series tests.
//
// Each scenario exposes the exact shape consumed by `computeSparkByPortfolio`
// (see src/lib/spark-by-portfolio.ts): a list of portfolios, their own
// per-portfolio snapshot series, and the merged multi-portfolio `series`
// axis that must NEVER be used to back-fill missing dates on any individual
// portfolio's sparkline.
//
// The merged axes below intentionally include phantom back-filled points
// (e.g. starting_cash repeated on days a portfolio didn't yet exist) so
// tests can assert the selector ignores them.

import type { EquityData, SparkPoint } from "@/lib/spark-by-portfolio";

// Stable UUIDs so snapshot output is deterministic across runs.
export const PORTFOLIO_IDS = {
  liveNew: "11111111-1111-4111-8111-111111111111",
  simMature: "22222222-2222-4222-8222-222222222222",
  simEmpty: "33333333-3333-4333-8333-333333333333",
  simVolatile: "44444444-4444-4444-8444-444444444444",
} as const;

function seriesFrom(values: Array<[string, number]>): SparkPoint[] {
  return values.map(([date, value]) => ({ date, value }));
}

// ── Individual portfolio series ────────────────────────────────────────────
const liveNewOwn = seriesFrom([["2026-07-24", 300.46]]);

const simMatureOwn = seriesFrom([
  ["2026-07-20", 1000],
  ["2026-07-21", 1010],
  ["2026-07-22", 990],
  ["2026-07-23", 1025],
  ["2026-07-24", 1040],
]);

const simVolatileOwn = seriesFrom([
  ["2026-07-22", 500],
  ["2026-07-23", 620],
  ["2026-07-24", 415],
]);

// ── Scenarios ──────────────────────────────────────────────────────────────

/**
 * Mixed dashboard: one brand-new live portfolio (single snapshot), one mature
 * simulated portfolio spanning five days, and one simulated portfolio with
 * no snapshots at all. The merged axis back-fills the live portfolio with
 * starting_cash (330) across the sim's earlier dates — the classic bug shape.
 */
export const mixedDashboard: EquityData = {
  portfolios: [
    { id: PORTFOLIO_IDS.liveNew, mode: "live_prod" },
    { id: PORTFOLIO_IDS.simMature, mode: "paper" },
    { id: PORTFOLIO_IDS.simEmpty, mode: "paper" },
  ],
  perPortfolioSeries: {
    [PORTFOLIO_IDS.liveNew]: liveNewOwn,
    [PORTFOLIO_IDS.simMature]: simMatureOwn,
    // simEmpty omitted on purpose — reflects a freshly created portfolio.
  },
  series: [
    { date: "2026-07-20", [PORTFOLIO_IDS.liveNew]: 330, [PORTFOLIO_IDS.simMature]: 1000, [PORTFOLIO_IDS.simEmpty]: 500 },
    { date: "2026-07-21", [PORTFOLIO_IDS.liveNew]: 330, [PORTFOLIO_IDS.simMature]: 1010, [PORTFOLIO_IDS.simEmpty]: 500 },
    { date: "2026-07-22", [PORTFOLIO_IDS.liveNew]: 330, [PORTFOLIO_IDS.simMature]: 990, [PORTFOLIO_IDS.simEmpty]: 500 },
    { date: "2026-07-23", [PORTFOLIO_IDS.liveNew]: 330, [PORTFOLIO_IDS.simMature]: 1025, [PORTFOLIO_IDS.simEmpty]: 500 },
    { date: "2026-07-24", [PORTFOLIO_IDS.liveNew]: 300.46, [PORTFOLIO_IDS.simMature]: 1040, [PORTFOLIO_IDS.simEmpty]: 500 },
  ],
};

/**
 * Two portfolios whose lifespans overlap only partially — sim-volatile
 * exists for three days; sim-mature for five. The merged axis unifies
 * both onto the five-day axis and pads sim-volatile with phantom values.
 */
export const partialOverlap: EquityData = {
  portfolios: [
    { id: PORTFOLIO_IDS.simMature, mode: "paper" },
    { id: PORTFOLIO_IDS.simVolatile, mode: "paper" },
  ],
  perPortfolioSeries: {
    [PORTFOLIO_IDS.simMature]: simMatureOwn,
    [PORTFOLIO_IDS.simVolatile]: simVolatileOwn,
  },
  series: [
    { date: "2026-07-20", [PORTFOLIO_IDS.simMature]: 1000, [PORTFOLIO_IDS.simVolatile]: 500 },
    { date: "2026-07-21", [PORTFOLIO_IDS.simMature]: 1010, [PORTFOLIO_IDS.simVolatile]: 500 },
    { date: "2026-07-22", [PORTFOLIO_IDS.simMature]: 990, [PORTFOLIO_IDS.simVolatile]: 500 },
    { date: "2026-07-23", [PORTFOLIO_IDS.simMature]: 1025, [PORTFOLIO_IDS.simVolatile]: 620 },
    { date: "2026-07-24", [PORTFOLIO_IDS.simMature]: 1040, [PORTFOLIO_IDS.simVolatile]: 415 },
  ],
};

/** Empty state — no portfolios, no series. */
export const emptyDashboard: EquityData = {
  portfolios: [],
  perPortfolioSeries: {},
  series: [],
};

/** Every portfolio has a single snapshot on the same day. */
export const allSingleSnapshot: EquityData = {
  portfolios: [
    { id: PORTFOLIO_IDS.liveNew, mode: "live_prod" },
    { id: PORTFOLIO_IDS.simMature, mode: "paper" },
  ],
  perPortfolioSeries: {
    [PORTFOLIO_IDS.liveNew]: [{ date: "2026-07-24", value: 300.46 }],
    [PORTFOLIO_IDS.simMature]: [{ date: "2026-07-24", value: 1000 }],
  },
  series: [
    { date: "2026-07-24", [PORTFOLIO_IDS.liveNew]: 300.46, [PORTFOLIO_IDS.simMature]: 1000 },
  ],
};

export const fixtures = {
  mixedDashboard,
  partialOverlap,
  emptyDashboard,
  allSingleSnapshot,
} as const;

export type FixtureName = keyof typeof fixtures;
