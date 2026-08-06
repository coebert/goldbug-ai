import { useCallback, useEffect, useState } from "react";
import {
  readCachedTradingMode,
  resolveTradingMode,
  styleFromRiskConfig,
  writeCachedTradingMode,
  TRADING_MODE_EVENT,
  type TradingModeEventDetail,
  type TradingStyle,
} from "@/lib/trading-mode-store";

/**
 * Resolve the trading mode to display for a portfolio.
 *
 * Precedence: server config → cached choice → "position". The cache only fills
 * the gap before the portfolio query resolves, so a mode changed on another
 * device still wins as soon as the real data arrives. Whenever the server does
 * answer, the cache is refreshed so the next refresh starts from the truth.
 *
 * Reading storage happens in an effect, never during render, so SSR markup and
 * the first client render agree and hydration stays clean.
 */
export function useTradingMode(
  portfolioId: string | undefined,
  riskConfig: unknown,
): { style: TradingStyle; isSwing: boolean; setStyle: (s: TradingStyle) => void } {
  const serverStyle = styleFromRiskConfig(riskConfig);
  const [cached, setCached] = useState<TradingStyle | null>(null);

  // Hydrate from local storage once mounted.
  useEffect(() => {
    if (!portfolioId) return;
    setCached(readCachedTradingMode(portfolioId));
  }, [portfolioId]);

  // Server value is authoritative — mirror it into the cache when it arrives.
  useEffect(() => {
    if (!portfolioId || !serverStyle) return;
    setCached(serverStyle);
    if (readCachedTradingMode(portfolioId) !== serverStyle) {
      writeCachedTradingMode(portfolioId, serverStyle);
    }
  }, [portfolioId, serverStyle]);

  // Stay in step with other surfaces (same tab) and other tabs.
  useEffect(() => {
    if (!portfolioId) return;
    const onLocal = (e: Event) => {
      const detail = (e as CustomEvent<TradingModeEventDetail>).detail;
      if (detail?.portfolioId === portfolioId) setCached(detail.style);
    };
    const onStorage = () => setCached(readCachedTradingMode(portfolioId));
    window.addEventListener(TRADING_MODE_EVENT, onLocal);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(TRADING_MODE_EVENT, onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, [portfolioId]);

  const setStyle = useCallback(
    (s: TradingStyle) => {
      setCached(s);
      if (portfolioId) writeCachedTradingMode(portfolioId, s);
    },
    [portfolioId],
  );

  const style = resolveTradingMode(serverStyle, cached);
  return { style, isSwing: style === "swing", setStyle };
}
