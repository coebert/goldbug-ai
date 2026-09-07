// Plain-English classification of a terminal order status.
//
// Not every non-fill is a fault. A limit buy that simply never reached its
// price, and was then pulled by the stale-order sweep, is the system working
// as designed — it should never read like a broker error in the UI.

export type OutcomeKind = "expected" | "error";

export interface OutcomeExplanation {
  kind: OutcomeKind;
  /** Short badge label. */
  label: string;
  /** One-sentence explanation in everyday language. */
  plain: string;
}

const EXPECTED_PATTERNS: Array<{ re: RegExp; label: string; plain: string }> = [
  {
    re: /orphan sweep|resting .* at broker|stale.*working/i,
    label: "Expired unfilled",
    plain:
      "Not an error. The price never came to the order's limit, so it was withdrawn after resting at the broker. Nothing was bought or sold and no money was spent.",
  },
  {
    re: /no broker id|abandoned|closed locally/i,
    label: "Closed unfilled",
    plain:
      "Not an error. The order never reached the market, so it was closed off. Nothing was traded.",
  },
  {
    re: /manual|user cancel|cancelled by you/i,
    label: "Cancelled by you",
    plain: "You cancelled this order, so nothing was traded.",
  },
];

/**
 * Classify a terminal order. `status` is the stored live_orders status and
 * `reason` the stored reject_reason (may be null).
 */
export function explainOrderOutcome(
  status: string,
  reason: string | null | undefined,
): OutcomeExplanation | null {
  const s = (status ?? "").toLowerCase();
  if (s !== "cancelled") return null;

  const r = (reason ?? "").trim();
  for (const p of EXPECTED_PATTERNS) {
    if (p.re.test(r)) return { kind: "expected", label: p.label, plain: p.plain };
  }
  return {
    kind: "expected",
    label: "Cancelled unfilled",
    plain:
      "Not an error. The order was withdrawn before it traded, so nothing was bought or sold.",
  };
}

/** True when this outcome should not be counted or coloured as a failure. */
export function isExpectedNonFill(
  status: string,
  reason: string | null | undefined,
): boolean {
  return explainOrderOutcome(status, reason)?.kind === "expected";
}
