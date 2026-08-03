/**
 * Typed query-key factories and polling tiers.
 *
 * Phase 3 of the codebase review: before this module, 162 inline
 * `queryKey: [...]` literals were scattered across routes and cards. Keys
 * drifted (`["portfolios"]` vs `["portfolios", "palette"]` hit the same
 * endpoint with two caches), invalidations missed siblings, and 35
 * independent `refetchInterval`s polled the same data on different clocks.
 *
 * Rules:
 *  - Never write a raw literal for a family declared here; call the factory.
 *  - Keys are hierarchical: `qk.portfolio.detail(id)` is a child of
 *    `qk.portfolio.all()`, so invalidating the parent clears every child.
 *  - Pick a polling tier from `POLL` rather than inventing an interval.
 */

/** Readonly tuple so keys cannot be mutated in place by callers. */
export type QueryKey = readonly unknown[];

export const qk = {
  /** Portfolio list (one shared cache entry for every list consumer). */
  portfolios: {
    all: () => ["portfolios"] as const,
    list: () => ["portfolios"] as const,
    equity: () => ["all-portfolios-equity"] as const,
  },
  /** A single portfolio and everything hanging off it. */
  portfolio: {
    all: () => ["portfolio"] as const,
    detail: (id: string) => ["portfolio", id] as const,
  },
  holdings: {
    all: () => ["holdings"] as const,
    forPortfolio: (id: string) => ["holdings", id] as const,
  },
  trades: {
    all: () => ["trades"] as const,
    forPortfolio: (id: string) => ["trades", id] as const,
  },
  live: {
    status: (portfolioId: string) => ["live-status", portfolioId] as const,
    audit: (portfolioId: string) => ["live-audit", portfolioId] as const,
    tradeAlert: (portfolioId: string) => ["live-trade-alert", portfolioId] as const,
  },
} as const;

/**
 * Polling tiers. Three clocks instead of thirty-five.
 *
 *  - `LIVE`      broker/order state a user watches change (15s)
 *  - `SEMI_LIVE` prices, equity, status panels (60s)
 *  - `SLOW`      reports and aggregates recomputed by cron (5 min)
 *  - `STATIC`    never polls; refreshes on window focus / explicit invalidate
 */
export const POLL = {
  LIVE: 15_000,
  SEMI_LIVE: 60_000,
  SLOW: 5 * 60_000,
  STATIC: false as const,
} as const;

export type PollTier = (typeof POLL)[keyof typeof POLL];

/**
 * Shared read defaults for mobile: focus/visibility events fire constantly on
 * phones, so serve from cache and let the tier interval drive refreshes.
 */
export const READ_DEFAULTS = {
  staleTime: 30_000,
  gcTime: 5 * 60_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;
