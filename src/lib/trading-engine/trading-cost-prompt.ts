import {
  UK_STAMP_DUTY_BPS,
  PTM_LEVY_GBP,
  PTM_LEVY_THRESHOLD_GBP,
} from "../trade-viability-gate";
import { DEFAULT_EDGE_SAFETY_MULTIPLE } from "../net-edge-gate";

/**
 * Prompt block that makes the model cost-aware BEFORE it proposes anything.
 * The deterministic gates (viability, net-edge, cost governor) still enforce
 * all of this after the fact; telling the model up front stops it wasting the
 * day's buy slots on ideas that can never pay their friction back.
 */
export function buildTradingCostBlock(args: {
  currency: string;
  stampExemptPreference?: "off" | "balanced" | "strong" | null;
  safetyMultiple?: number;
  /**
   * This account's own round-trip dealing cost in bps, measured ticket by
   * ticket from real fills. When known it overrides the generic ranges below —
   * the model should reason against the number this book actually pays.
   */
  measuredRoundTripBps?: number | null;
}): string {
  const safety = args.safetyMultiple ?? DEFAULT_EDGE_SAFETY_MULTIPLE;
  const pref = args.stampExemptPreference ?? "balanced";
  const measured = Number(args.measuredRoundTripBps);
  const measuredLine = Number.isFinite(measured) && measured > 0
    ? `\n- MEASURED ON THIS ACCOUNT: the round trip actually costs ~${measured.toFixed(0)}bps of notional (priced ticket by ticket from real fills, commission + stamp + spread + slippage included). Use THIS number — not a generic assumption — when judging whether a trade can pay for itself: a ${measured.toFixed(0)}bps round trip needs an expected move of at least ${(measured * safety / 100).toFixed(1)}% before it clears the bar.`
    : "";
  return `TRADING COSTS — PRICE THESE IN BEFORE PROPOSING ANY TRADE:${measuredLine}
- Every buy pays real money before it can make any: broker commission (roughly 8-10bps of notional, but with a per-side MINIMUM of about £3 UK / $1 US / €3 EU, which dominates small tickets), half the bid/ask spread on entry AND again on exit, and on UK single shares a further ${UK_STAMP_DUTY_BPS}bps (0.5%) of UK stamp duty on the BUY.
- UK tickets above £${PTM_LEVY_THRESHOLD_GBP.toLocaleString()} also pay the £${PTM_LEVY_GBP} PTM levy.
- Round-trip friction is therefore commission ×2 + spread ×2 + stamp duty. A small UK single-stock ticket can easily cost 100-200bps round-trip: the price has to rise that much before the position is level.
- Do NOT propose a buy unless the move you expect is at least ${safety.toFixed(1)}× that round-trip friction. Trades that cannot clear this are rejected automatically and simply burn a buy slot.
- Small tickets are the main way this account loses money. Prefer FEWER, LARGER, higher-conviction positions over many small ones; the fixed commission floor makes tiny trades structurally loss-making.
- ETFs, ETCs and non-UK listings pay NO stamp duty and so break even ~${UK_STAMP_DUTY_BPS}bps sooner than a UK single share.${
    pref === "off"
      ? ""
      : ` The account is configured to ${pref === "strong" ? "strongly prefer" : "prefer"} stamp-exempt instruments when signals are comparable — when a UK share and an ETF express a similar view with similar strength, take the ETF.`
  }
- Churn is expensive: do not sell and re-buy the same exposure for a marginal reason, and do not add to a position in small increments. Size to the target in one ticket.
- When you state a rationale, say what move you expect (in %) so the size can be checked against the cost of getting in and out. All values in ${args.currency.toUpperCase()}.`;
}
