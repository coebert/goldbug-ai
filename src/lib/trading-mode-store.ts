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
