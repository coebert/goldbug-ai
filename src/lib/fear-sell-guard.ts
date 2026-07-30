// Panic-sell guard.
//
// The fear index is a BUY-side overlay only: it may block or shrink new buys,
// but it must never be the reason we liquidate existing holdings. Selling into
// a fear spike locks in drawdowns at the worst prices, so any discretionary AI
// sell whose justification leans on market fear/VIX/panic — with no independent
// exit rule behind it — is rejected here.
//
// Systematic exits (stop-loss, ATR/trailing stops, risk halts, tail-hedge
// rebalances, take-profit, position/correlation caps) run on their own code
// paths and are explicitly whitelisted, so genuine risk management still works.

const FEAR_PATTERNS = [
  /\bfear index\b/i,
  /\bfear gauge\b/i,
  /\bpanic\b/i,
  /\bmarket fear\b/i,
  /\bfear (?:is )?(?:elevated|spik\w*|extreme|high)\b/i,
  /\bextreme fear\b/i,
  /\brisk[- ]off sentiment\b/i,
  /\bvix\b/i,
  /\bvvix\b/i,
  /\bskew index\b/i,
  /\bvolatility spike\b/i,
  /\bcapital preservation\b/i,
  /\bde-?risk(?:ing)?\b/i,
];

/** Independent, rule-based exits that stay valid even during a fear spike. */
const LEGITIMATE_EXIT_PATTERNS = [
  /\bstop[- ]?loss\b/i,
  /\btrailing stop\b/i,
  /\batr stop\b/i,
  /\bhard stop\b/i,
  /\btake[- ]?profit\b/i,
  /\bprofit target\b/i,
  /\brisk halt\b/i,
  /\bkill switch\b/i,
  /\brebalanc\w*/i,
  /\bposition cap\b/i,
  /\bconcentration\b/i,
  /\bcorrelation cap\b/i,
  /\bexposure limit\b/i,
  /\btail hedge\b/i,
  /\bearnings blackout\b/i,
  /\bthesis (?:broken|invalidated)\b/i,
  /\bfundamental\w* deteriorat\w*/i,
  /\bdowngrade\b/i,
  /\bdelist\w*/i,
  /\bliquidity (?:dried|collapse\w*)\b/i,
  /\bcash floor\b/i,
  /\bfunding a (?:higher|better)[- ]conviction\b/i,
];

export type PanicSellVerdict = {
  /** True when the sell should be rejected as fear-driven. */
  block: boolean;
  /** Human-readable rejection text, empty when not blocked. */
  reason: string;
  /** The legitimate exit rule that overrode the guard, if any. */
  override: string | null;
};

const ALLOWED: PanicSellVerdict = { block: false, reason: "", override: null };

/**
 * Classifies a discretionary AI sell. Only the model's own narrative reason is
 * inspected — systematic exits never reach this guard.
 */
export function classifyPanicSell(params: {
  reason: string | null | undefined;
  /** Current composite fear score, 0-100. */
  fearScore: number;
  /** Score at/above which fear-justified sells are refused. */
  threshold?: number;
}): PanicSellVerdict {
  const threshold = params.threshold ?? 60;
  const reason = (params.reason ?? "").trim();
  if (!reason) return ALLOWED;

  const fearMatch = FEAR_PATTERNS.find((re) => re.test(reason));
  if (!fearMatch) return ALLOWED;

  const override = LEGITIMATE_EXIT_PATTERNS.find((re) => re.test(reason));
  if (override) {
    const m = reason.match(override);
    return { block: false, reason: "", override: m ? m[0] : "rule-based exit" };
  }

  // A fear-worded sell in a calm tape is likely incidental phrasing; only
  // refuse once the gauge itself is elevated, which is when panic-selling hurts.
  if (params.fearScore < threshold) return ALLOWED;

  return {
    block: true,
    reason:
      `panic-sell guard: sell justified by market fear (score ${params.fearScore.toFixed(0)}/100) ` +
      `with no independent exit rule — fear index is buy-side only`,
    override: null,
  };
}
