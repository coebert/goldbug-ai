/**
 * Catalogue of every named card / chart in the app.
 *
 * Findability problem this solves: the Cmd-K palette only knew about
 * *pages*, so "where is the drawdown chart?" had no answer — you had to
 * remember which of 32 routes hosted it. Every `CardShell` declares an
 * `anchor` and a `page`; this module is the static index the palette
 * searches, and the anchor is what the link scrolls to.
 *
 * Kept as a plain data module (no React) so it can be unit-tested and
 * imported by the palette without pulling in card implementations.
 */

export type CatalogEntry = {
  /** Stable DOM id used as the scroll anchor (`#equity`, `#drawdown`). */
  anchor: string;
  /** Human title, matched against the search query. */
  title: string;
  /** Route path that renders this card. `$id` is substituted at use time. */
  page: string;
  /** Area label shown as the group heading in the palette. */
  area: "Home" | "Markets" | "Research" | "Trades" | "Portfolio" | "System";
  /** Extra search words. */
  keywords?: string;
};

export const CARD_CATALOG: ReadonlyArray<CatalogEntry> = [
  // --- Home ---------------------------------------------------------
  { anchor: "today", title: "Today's change", page: "/", area: "Home", keywords: "equity hero pnl value" },
  { anchor: "next-action", title: "What to do next", page: "/", area: "Home", keywords: "action suggestion" },
  { anchor: "portfolios", title: "Your portfolios", page: "/", area: "Home", keywords: "accounts list" },

  // --- Markets ------------------------------------------------------
  { anchor: "market-pulse", title: "Market pulse", page: "/markets", area: "Markets", keywords: "risk on off breadth" },
  { anchor: "sma-trend", title: "Moving-average trend", page: "/markets", area: "Markets", keywords: "sma 20 50 200 trend" },
  { anchor: "trading-hours", title: "Trading hours", page: "/markets", area: "Markets", keywords: "venue open close clock" },
  { anchor: "spillover", title: "Spillover heatmap", page: "/spillover", area: "Markets", keywords: "correlation contagion" },
  { anchor: "compare", title: "Compare portfolios", page: "/compare", area: "Markets", keywords: "benchmark index" },

  // --- Research -----------------------------------------------------
  { anchor: "setup-scanner", title: "Setup scanner", page: "/research", area: "Research", keywords: "reclaim breakout scan" },
  { anchor: "setup-backtest", title: "Setup backtest", page: "/research", area: "Research", keywords: "backtest rules" },
  { anchor: "backtest-results", title: "Backtest results", page: "/research", area: "Research", keywords: "equity curve bootstrap metrics" },
  { anchor: "run-history", title: "Backtest run history", page: "/research", area: "Research", keywords: "risk level compare saved runs" },
  { anchor: "simulation-report", title: "Simulation report", page: "/simulation-report", area: "Research" },

  // --- Trades -------------------------------------------------------
  { anchor: "daily-report", title: "Daily AI report", page: "/daily-report", area: "Trades", keywords: "narrative decisions why" },
  { anchor: "orders", title: "Orders", page: "/trades", area: "Trades", keywords: "working submitted placed" },
  { anchor: "fills", title: "Broker fills", page: "/trades", area: "Trades", keywords: "executions fees bps" },
  { anchor: "reconciliation", title: "Reconciliation", page: "/trades", area: "Trades", keywords: "dropped legs mismatch" },

  // --- Portfolio ($id) ----------------------------------------------
  { anchor: "equity", title: "Equity curve", page: "/portfolio/$id", area: "Portfolio", keywords: "value chart over time" },
  { anchor: "drawdown", title: "Drawdown chart", page: "/portfolio/$id", area: "Portfolio", keywords: "peak to trough loss" },
  { anchor: "composition", title: "Composition", page: "/portfolio/$id", area: "Portfolio", keywords: "weights allocation pie" },
  { anchor: "holdings", title: "Holdings", page: "/portfolio/$id", area: "Portfolio", keywords: "positions avg cost unrealised" },
  { anchor: "actions", title: "Recent actions", page: "/portfolio/$id", area: "Portfolio", keywords: "trades tape" },
  { anchor: "fx-legs", title: "FX funding legs", page: "/portfolio/$id/fx-risk", area: "Portfolio", keywords: "currency gbpusd close now" },
  { anchor: "cash-at-risk", title: "Cash at risk", page: "/portfolio/$id/fx-risk", area: "Portfolio", keywords: "fx exposure budget" },
  { anchor: "risk-stress", title: "Stress test", page: "/portfolio/$id", area: "Portfolio", keywords: "worst case shock scenario" },
  { anchor: "risk-concentration", title: "Concentration", page: "/portfolio/$id", area: "Portfolio", keywords: "single name weight limit" },
  { anchor: "backtest-vs-real", title: "Backtest vs real P&L", page: "/portfolio/$id/analytics", area: "Portfolio", keywords: "gap fees shortfall" },
  { anchor: "attribution", title: "Attribution", page: "/portfolio/$id/attribution", area: "Portfolio", keywords: "contribution by symbol" },
  { anchor: "optimizer", title: "Optimizer", page: "/portfolio/$id/optimizer", area: "Portfolio", keywords: "weights suggestion" },
  { anchor: "strategy-builder", title: "Strategy builder", page: "/portfolio/$id/trade", area: "Portfolio", keywords: "rules stop take profit entry" },

  // --- System -------------------------------------------------------
  { anchor: "broker-health", title: "Broker health", page: "/saxo-status", area: "System", keywords: "saxo connection token cash sync" },
  { anchor: "blocked-instruments", title: "Blocked instruments", page: "/broker-blocks", area: "System", keywords: "suitability refused" },
  { anchor: "hedge-fallbacks", title: "Hedge fallbacks", page: "/hedge-fallbacks", area: "System", keywords: "gold tail substitute" },
  { anchor: "run-controls", title: "Run controls", page: "/admin", area: "System", keywords: "manual run scheduler cron" },
];

function norm(s: string): string {
  return s.toLowerCase().trim();
}

/** Fuzzy-ish substring search across title, keywords and area. */
export function searchCards(query: string): ReadonlyArray<CatalogEntry> {
  const q = norm(query);
  if (!q) return CARD_CATALOG;
  const words = q.split(/\s+/);
  return CARD_CATALOG.filter((c) => {
    const hay = norm(`${c.title} ${c.keywords ?? ""} ${c.area} ${c.anchor}`);
    return words.every((w) => hay.includes(w));
  });
}

/** Resolve a catalogue page to a concrete href, substituting `$id`. */
export function cardHref(entry: CatalogEntry, portfolioId?: string): string {
  const path = entry.page.includes("$id")
    ? portfolioId
      ? entry.page.replace("$id", portfolioId)
      : ""
    : entry.page;
  return path ? `${path}#${entry.anchor}` : "";
}
