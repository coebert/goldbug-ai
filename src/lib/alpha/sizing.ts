// Phase 2 + 5 — two-sided sizing bonuses and risk-parity target notional.
//
// These helpers are pure and side-effect free so they can be unit-tested
// in isolation. They only *scale* the sizing pipeline in the trading
// engine; downstream caps (per-symbol, asset-class, gross exposure,
// commodity groups) still bind after these run.
import { clamp1 } from "./types";
import { unifiedVolSize } from "../sizing/unified-vol-size";

export type AlphaBonusInput = {
  side: "buy" | "sell";
  /** Composite alpha score in [-1, 1] from scoreCandidate. */
  alphaComposite: number | null | undefined;
  /** AI conviction in [0, 1]. */
  conviction: number | null | undefined;
  /** Max multiplier applied to spend (defaults to 1.5). */
  cap?: number;
  /** Feature gate; when false the bonus is a no-op (returns 1). */
  enabled?: boolean;
};

/**
 * Two-sided sizing bonus. Returns a multiplier in [1, cap] when the
 * alpha prior and AI conviction agree with the trade side. Any dis-
 * agreement, low conviction (<0.6), or weak alpha (|score| < 0.25)
 * returns 1 — the bonus never shrinks a trade, only lifts it.
 *
 * The bonus grows with the product of (conviction - 0.6) and
 * (|alpha| - 0.25), each rescaled to [0, 1], so it's meaningful only
 * when *both* signals are strong.
 */
export function alphaConvictionBonus(input: AlphaBonusInput): {
  mult: number;
  note: string | null;
} {
  const cap = Math.max(1, input.cap ?? 1.5);
  if (input.enabled === false) return { mult: 1, note: null };
  const alpha = clamp1(Number(input.alphaComposite ?? 0));
  const conv = Math.max(0, Math.min(1, Number(input.conviction ?? 0)));
  if (!Number.isFinite(alpha) || !Number.isFinite(conv)) return { mult: 1, note: null };

  const sideSign = input.side === "buy" ? 1 : -1;
  if (Math.sign(alpha) !== sideSign) return { mult: 1, note: null };

  const alphaMag = Math.abs(alpha);
  if (alphaMag < 0.25 || conv < 0.6) return { mult: 1, note: null };

  const convStrength = (conv - 0.6) / 0.4; // 0..1
  const alphaStrength = (alphaMag - 0.25) / 0.75; // 0..1
  const strength = Math.max(0, Math.min(1, convStrength * alphaStrength));
  const mult = 1 + (cap - 1) * strength;
  if (mult <= 1.01) return { mult: 1, note: null };
  return {
    mult,
    note: `alpha×conv +${((mult - 1) * 100).toFixed(0)}% (α=${alpha.toFixed(2)}, c=${conv.toFixed(2)})`,
  };
}

export type RiskParityInput = {
  /** |alpha composite| in [0, 1] — magnitude, not signed. */
  alphaMag: number;
  /** 20-day annualised (or per-day) volatility. */
  vol: number | null;
  /** Total portfolio value in base currency. */
  totalValue: number;
  /** Per-position vol target (e.g. 0.015 = 1.5%). */
  targetVolPct: number;
  /** Max fraction of NAV any single position can consume (default 20%). */
  navCap?: number;
};

/**
 * Risk-parity target notional. Positions with stronger alpha earn a
 * larger share of the vol budget so capital flows to the highest-
 * conviction systematic setups without breaching the per-position vol
 * target. Returns 0 when vol data is missing so the caller falls back
 * to the legacy vol-sizing path.
 */
export function riskParityTargetSpend(input: RiskParityInput): number {
  const vol = Number(input.vol ?? 0);
  if (!vol || vol <= 0) return 0;
  // Phase 3 item 14 — single vol-sizing implementation.
  return unifiedVolSize({
    totalValue: input.totalValue,
    vol,
    targetVolPct: input.targetVolPct,
    navCap: input.navCap ?? 0.2,
    riskParity: true,
    alphaMag: input.alphaMag,
  }).targetValue;
}
