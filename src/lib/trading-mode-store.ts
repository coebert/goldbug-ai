/**
 * Local cache of the selected trading mode, keyed per portfolio.
 *
 * The mode itself lives on the server in `risk_config.trading_style` — that is
 * still the only thing the engine reads. This cache exists purely so the UI
 * does not flicker: on a refresh the portfolio query has not resolved yet, so
 * without it every badge would render "Position Only" for a moment and then
 * snap to "Swing Active". We remember what the user last chose and show that
 * until the server answers, at which point the server always wins.
 */

export type TradingStyle = "swing" | "position";

const KEY_PREFIX = "aegis.trading-mode.";

const storageKey = (portfolioId: string) => `${KEY_PREFIX}${portfolioId}`;

const asStyle = (v: unknown): TradingStyle | null =>
  v === "swing" || v === "position" ? v : null;

/** Read `trading_style` off a raw risk_config, or null when unset. */
export function styleFromRiskConfig(riskConfig: unknown): TradingStyle | null {
  const cfg = (riskConfig ?? {}) as Record<string, unknown>;
  return asStyle(cfg["trading_style"]);
}

function safeStorage(): Storage | null {
  // SSR, private-mode Safari and storage-blocked browsers all throw here.
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Last mode this browser saw for the portfolio, or null when unknown. */
export function readCachedTradingMode(portfolioId: string): TradingStyle | null {
  if (!portfolioId) return null;
  const store = safeStorage();
  if (!store) return null;
  try {
    return asStyle(store.getItem(storageKey(portfolioId)));
  } catch {
    return null;
  }
}

/** Remember the mode for this portfolio. Never throws. */
export function writeCachedTradingMode(portfolioId: string, style: TradingStyle): void {
  if (!portfolioId) return;
  const store = safeStorage();
  if (!store) return;
  try {
    store.setItem(storageKey(portfolioId), style);
    // Same-tab listeners: the native `storage` event only fires cross-tab.
    window.dispatchEvent(new CustomEvent(TRADING_MODE_EVENT, { detail: { portfolioId, style } }));
  } catch {
    /* quota or blocked storage — the server value still drives behaviour */
  }
}

/** Forget the cached mode (e.g. when a portfolio is deleted). */
export function clearCachedTradingMode(portfolioId: string): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.removeItem(storageKey(portfolioId));
  } catch {
    /* ignore */
  }
}

/** Same-tab notification channel, since `storage` events are cross-tab only. */
export const TRADING_MODE_EVENT = "aegis:trading-mode";

export type TradingModeEventDetail = { portfolioId: string; style: TradingStyle };

/**
 * Precedence rule shared by every surface: the server config wins whenever it
 * is loaded, the cached choice covers the loading gap, and position trading is
 * the safe default when neither is known.
 */
export function resolveTradingMode(
  serverStyle: TradingStyle | null,
  cached: TradingStyle | null,
): TradingStyle {
  return serverStyle ?? cached ?? "position";
}

/**
 * Drift check: does this browser's cached mode disagree with what the engine
 * will actually run for the loaded risk_config?
 *
 * The engine's truth is `parseTradingStyle(risk_config.trading_style)`. A stale
 * cache (another tab, another device, an aborted flip, a save that failed after
 * the optimistic write) can leave the UI claiming the opposite horizon, which
 * is the confusing case this detects so the UI can warn and re-sync.
 *
 * Returns `drifted: false` whenever the server config has not loaded yet
 * (`riskConfig` with no style) — an unknown server value is a gap, not a drift.
 */
export function detectTradingModeDrift(
  riskConfig: unknown,
  cached: TradingStyle | null,
): { drifted: boolean; engineStyle: TradingStyle | null; cachedStyle: TradingStyle | null } {
  const cfg = (riskConfig ?? {}) as Record<string, unknown>;
  // A junk value ("Swing", 1, "") is not "unknown" — the engine coerces it to
  // position, so the UI must too, otherwise the cache silently wins.
  const engineStyle: TradingStyle | null =
    "trading_style" in cfg ? (cfg["trading_style"] === "swing" ? "swing" : "position") : null;
  if (!engineStyle || !cached) return { drifted: false, engineStyle, cachedStyle: cached };
  return { drifted: engineStyle !== cached, engineStyle, cachedStyle: cached };
}

/**
 * Drift log — shared across every surface in the tab.
 *
 * Several components resolve the mode independently (badge, toggle, risk
 * panel). Whichever one loads the server config first performs the re-sync, so
 * without a shared record the others would see an already-clean cache and the
 * warning would appear or vanish depending on mount order.
 */
const driftLog = new Map<string, { from: TradingStyle; to: TradingStyle }>();

export function recordTradingModeDrift(
  portfolioId: string,
  drift: { from: TradingStyle; to: TradingStyle },
): void {
  if (!portfolioId) return;
  driftLog.set(portfolioId, drift);
}

export function readTradingModeDrift(
  portfolioId: string | undefined,
): { from: TradingStyle; to: TradingStyle } | null {
  if (!portfolioId) return null;
  return driftLog.get(portfolioId) ?? null;
}

export function clearTradingModeDrift(portfolioId: string | undefined): void {
  if (portfolioId) driftLog.delete(portfolioId);
}
