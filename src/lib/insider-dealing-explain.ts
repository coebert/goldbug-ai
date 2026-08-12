// Plain-English audit trail for one insider-dealing alert.
//
// The card shows a one-line verdict; this module rebuilds the whole chain
// behind it — which filing was read, which fields were parsed out of it, how
// the disposal was typed, which held ticker it matched, and the exact number
// that reached the AI's news score for that symbol. Pure, so the panel and its
// tests share one interpretation.

import {
  INSIDER_NUDGE_CEILING,
  INSIDER_NUDGE_FLOOR,
  insiderScoreBreakdown,
  type InsiderDealingEvent,
  type InsiderScoreBreakdown,
} from "@/lib/insider-dealings";

export type FilingField = { label: string; value: string; hint?: string };

export type DisposalType = {
  /** `Open-market sale`, `Tax / vesting disposal`, … */
  label: string;
  flavour: InsiderDealingEvent["flavour"];
  direction: InsiderDealingEvent["direction"];
  /** Why the parser typed it this way. */
  reason: string;
  /** Mechanical filings carry almost no information. */
  mechanical: boolean;
};

export type NudgeExplanation = {
  breakdown: InsiderScoreBreakdown;
  /** This single filing's contribution. */
  eventNudge: number;
  /** Sum across every recent filing for the ticker, before the cap. */
  symbolRaw: number;
  /** What the engine actually applies after the ±cap. */
  symbolApplied: number;
  /** How many filings fed the symbol total. */
  symbolEvents: number;
  capped: boolean;
  floor: number;
  ceiling: number;
};

export type InsiderExplanation = {
  event: InsiderDealingEvent;
  /** Raw filing fields as parsed, in display order. */
  filing: FilingField[];
  disposal: DisposalType;
  match: { symbol: string; company: string; source: string; primary: boolean };
  nudge: NudgeExplanation;
  /** One-sentence summary of the effect on the decision. */
  effect: string;
};

const GBP = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });

function money(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return GBP.format(value);
}

/** Implied per-share price, when the filing gave both value and volume. */
export function impliedPrice(e: InsiderDealingEvent): number | null {
  if (e.value == null || !e.shares || e.shares <= 0) return null;
  const p = e.value / e.shares;
  return Number.isFinite(p) ? Number(p.toFixed(4)) : null;
}

export function disposalType(e: InsiderDealingEvent): DisposalType {
  const verb = e.direction === "sell" ? "Disposal" : e.direction === "buy" ? "Acquisition" : "Dealing";
  if (e.direction === "unknown") {
    return {
      label: "Unclassified dealing",
      flavour: e.flavour,
      direction: e.direction,
      reason: "The filing wording did not clearly state a sale or a purchase, so no directional signal is taken.",
      mechanical: true,
    };
  }
  if (e.flavour === "tax") {
    return {
      label: `${verb} — tax / withholding`,
      flavour: e.flavour,
      direction: e.direction,
      reason:
        "Wording points to shares sold to settle tax on vesting. Mechanical: the executive is not expressing a view, so severity is weighted down to 0.15x.",
      mechanical: true,
    };
  }
  if (e.flavour === "award") {
    return {
      label: `${verb} — plan / award`,
      flavour: e.flavour,
      direction: e.direction,
      reason:
        "Wording points to a share plan event (SIP, sharesave, vesting, option exercise). Scheduled rather than discretionary, so severity is weighted to 0.35x.",
      mechanical: true,
    };
  }
  if (e.flavour === "discretionary") {
    return {
      label: `${verb} — open market`,
      flavour: e.flavour,
      direction: e.direction,
      reason:
        e.direction === "sell"
          ? "Discretionary open-market sale: the strongest form of this signal, so it carries full flavour weight (1.0x)."
          : "Discretionary open-market purchase: full flavour weight (1.0x), but buys are capped lower than sells.",
      mechanical: false,
    };
  }
  return {
    label: `${verb} — unspecified`,
    flavour: e.flavour,
    direction: e.direction,
    reason: "Direction is clear but the reason is not stated, so a neutral 0.5x flavour weight is used.",
    mechanical: false,
  };
}

/** Every field the parser lifted out of the filing, ready to render. */
export function filingFields(e: InsiderDealingEvent): FilingField[] {
  const price = impliedPrice(e);
  const fields: FilingField[] = [
    { label: "Filed / dated", value: e.event_date ?? "unknown" },
    { label: "Issuer", value: e.company || e.symbol },
    { label: "Person", value: e.person ?? "not named in filing" },
    { label: "Position", value: e.role ?? "not stated" },
    {
      label: "Transaction",
      value: e.direction === "unknown" ? "unclear" : e.direction === "sell" ? "Sale" : "Purchase",
    },
    { label: "Volume", value: e.shares != null ? `${e.shares.toLocaleString("en-GB")} shares` : "not stated" },
    { label: "Price", value: price != null ? `£${price.toFixed(4)}` : "not stated", hint: "implied from value ÷ volume" },
    { label: "Consideration", value: money(e.value) ?? "not stated" },
    { label: "Nature", value: e.summary ?? "not stated" },
    { label: "Source", value: e.source ?? "unknown" },
  ];
  return fields;
}

/**
 * Rebuilds the nudge arithmetic. `symbolEvents` are all recent filings for the
 * same ticker — the engine sums their nudges and clamps the total, so one
 * filing's own number is not what finally reaches the decision.
 */
export function explainInsiderEvent(
  event: InsiderDealingEvent,
  symbolEvents: readonly InsiderDealingEvent[] = [event],
): InsiderExplanation {
  const peers = symbolEvents.length > 0 ? symbolEvents : [event];
  const breakdown = insiderScoreBreakdown({
    direction: event.direction,
    flavour: event.flavour,
    role: event.role,
    value: event.value,
  });

  const symbolRaw = Number(peers.reduce((acc, e) => acc + e.sentiment_nudge, 0).toFixed(4));
  const symbolApplied = Number(
    Math.max(INSIDER_NUDGE_FLOOR, Math.min(INSIDER_NUDGE_CEILING, symbolRaw)).toFixed(4),
  );

  const disposal = disposalType(event);
  const primary = (event.source ?? "").toUpperCase().includes("RNS");

  const dir = symbolApplied < 0 ? "lowers" : symbolApplied > 0 ? "raises" : "does not move";
  const effect =
    symbolApplied === 0
      ? `No adjustment: ${event.symbol}'s news score is left untouched by this filing.`
      : `${event.symbol}'s news score is shifted by ${symbolApplied >= 0 ? "+" : ""}${symbolApplied.toFixed(
          3,
        )} — this ${dir} the AI's conviction before position sizing and the net-edge gate run.`;

  return {
    event,
    filing: filingFields(event),
    disposal,
    match: {
      symbol: event.symbol,
      company: event.company,
      source: event.source ?? "unknown",
      primary,
    },
    nudge: {
      breakdown,
      eventNudge: event.sentiment_nudge,
      symbolRaw,
      symbolApplied,
      symbolEvents: peers.length,
      capped: symbolRaw !== symbolApplied,
      floor: INSIDER_NUDGE_FLOOR,
      ceiling: INSIDER_NUDGE_CEILING,
    },
    effect,
  };
}
