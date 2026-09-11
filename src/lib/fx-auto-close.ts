/**
 * Which open currency legs should be closed without being asked.
 *
 * A funding leg is only meant to pay for foreign-currency holdings. Once those
 * holdings are gone the leg is a bare bet on the exchange rate that nobody
 * chose to make — and while it sits there at a loss it is quietly draining the
 * account. This rule closes exactly that kind of leg, and only that kind:
 * a leg still funding real holdings is left alone even when it is under water,
 * because closing it would force the position to be re-funded tomorrow.
 *
 * Pure: no IO, no broker, no database.
 */
import type { HygieneVerdict } from "./fx-leg-hygiene";

export type AutoCloseLeg = {
  symbol: string;
  /** Housekeeping verdict for the leg. */
  verdict: HygieneVerdict;
  /** Share of the leg still funding holdings (1 = fully used). */
  coverRatio: number;
  /** Leg size in the account's currency. */
  notionalBase: number;
  /**
   * Profit or loss right now in the account's currency, after the charge it
   * would cost to close. Negative is a loss.
   */
  pnlBaseNet: number;
  /** True when the rate used to value the leg is stale. */
  stale?: boolean;
};

export type AutoCloseSettings = {
  enabled: boolean;
  /** Close once the loss reaches this share of the leg, e.g. 1 = 1%. */
  lossPct: number;
  /** Ignore legs smaller than this in the account's currency. */
  minNotionalBase: number;
};

export type AutoCloseDecision = {
  symbol: string;
  close: boolean;
  lossPctOfLeg: number;
  /** Plain-language explanation, safe to show or notify with. */
  reason: string;
};

export const AUTO_CLOSE_DEFAULTS: AutoCloseSettings = {
  enabled: true,
  lossPct: 1,
  minNotionalBase: 250,
};

export function decideAutoCloses(
  legs: readonly AutoCloseLeg[],
  settings: Partial<AutoCloseSettings> = {},
): AutoCloseDecision[] {
  const s = { ...AUTO_CLOSE_DEFAULTS, ...settings };
  const threshold = Math.max(0, Number(s.lossPct) || 0);
  const minNotional = Math.max(0, Number(s.minNotionalBase) || 0);

  return legs.map((leg) => {
    const size = Math.abs(Number(leg.notionalBase) || 0);
    const pnl = Number(leg.pnlBaseNet);
    const lossPctOfLeg = size > 0 && Number.isFinite(pnl) ? (-pnl / size) * 100 : 0;
    const base = { symbol: leg.symbol, lossPctOfLeg };

    if (!s.enabled) return { ...base, close: false, reason: "Automatic closing is switched off." };
    if (leg.stale) {
      return { ...base, close: false, reason: "No fresh exchange rate — left open." };
    }
    if (!Number.isFinite(pnl) || size <= 0) {
      return { ...base, close: false, reason: "Position could not be valued." };
    }
    if (leg.verdict === "matched") {
      return {
        ...base,
        close: false,
        reason: "Still paying for foreign holdings, so it stays open.",
      };
    }
    if (size < minNotional) {
      return { ...base, close: false, reason: "Too small to be worth the dealing charge." };
    }
    if (lossPctOfLeg < threshold) {
      return {
        ...base,
        close: false,
        reason:
          lossPctOfLeg <= 0
            ? "Spare currency, but not losing money."
            : `Losing ${lossPctOfLeg.toFixed(2)}%, under the ${threshold}% trigger.`,
      };
    }

    const share = Math.round(Math.max(0, Math.min(1, leg.coverRatio)) * 100);
    return {
      ...base,
      close: true,
      reason: `Spare currency (${share}% still in use) losing ${lossPctOfLeg.toFixed(2)}%, past the ${threshold}% trigger.`,
    };
  });
}
