// Pure derivation of a plain-language "Explain this trade" summary from an
// audit entry. No IO, no AI — deterministic so the panel renders instantly and
// is snapshot-testable.
//
// It answers three questions the UI keeps being asked:
//   1. What drove this? (trend/technical signals vs event/news signals)
//   2. How confident was the AI, and why?
//   3. If a value is withheld ("—"), why? (unresolved GBX/GBP price units)

import type { AuditEntry } from "./audit-log";

export type SignalFamily = "trend" | "event" | "other";

export type ExplainedSignal = {
  key: string;
  label: string;
  weight: number;
  family: SignalFamily;
};

export type ConfidenceLabel = "low" | "moderate" | "high";

export type TradeExplanation = {
  headline: string;
  /** Which side of the book drove the decision. */
  driver: "trend-led" | "event-led" | "balanced" | "unattributed";
  trendSignals: ExplainedSignal[];
  eventSignals: ExplainedSignal[];
  otherSignals: ExplainedSignal[];
  /** 0..1 share of total signal weight coming from trend signals. */
  trendShare: number;
  eventShare: number;
  confidence: {
    score: number | null; // 0..1 conviction as recorded
    label: ConfidenceLabel | null;
    drivers: string[];
  };
  /** Set when the traded/holding value cannot be shown safely. */
  withheldValue: { withheld: boolean; reason: string | null };
  bullets: string[];
};

const TREND_HINTS = [
  "trend",
  "momentum",
  "moving_average",
  "ma_",
  "sma",
  "ema",
  "rsi",
  "macd",
  "breakout",
  "mean_reversion",
  "technical",
  "volatility",
  "atr",
  "drift",
  "regime",
];

const EVENT_HINTS = [
  "news",
  "sentiment",
  "event",
  "earnings",
  "headline",
  "exec",
  "post",
  "social",
  "macro",
  "mania",
  "catalyst",
  "guidance",
  "dividend",
];

export function classifySignal(key: string): SignalFamily {
  const k = key.toLowerCase();
  if (EVENT_HINTS.some((h) => k.includes(h))) return "event";
  if (TREND_HINTS.some((h) => k.includes(h))) return "trend";
  return "other";
}

function humanise(key: string): string {
  const s = key.replace(/[_\-.]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function confidenceLabel(score: number): ConfidenceLabel {
  if (score >= 0.66) return "high";
  if (score >= 0.33) return "moderate";
  return "low";
}

/** Detects an unresolved GBX/GBP unit condition from the recorded text/price. */
export function detectUnitsUnresolved(entry: {
  price?: number | null;
  reason?: string | null;
  rejectedReason?: string | null;
}): { withheld: boolean; reason: string | null } {
  const text = `${entry.reason ?? ""} ${entry.rejectedReason ?? ""}`.toLowerCase();
  const mentionsUnits =
    text.includes("unresolved_quote_units") ||
    text.includes("unresolved units") ||
    text.includes("units unresolved") ||
    text.includes("units unknown") ||
    (text.includes("unresolved") && (text.includes("unit") || text.includes("currency"))) ||
    (text.includes("gbx") && text.includes("gbp") && text.includes("cannot"));
  if (mentionsUnits) {
    return {
      withheld: true,
      reason:
        "Price units could not be resolved (pence vs pounds), so the value is withheld rather than shown 100× wrong. It contributes 0 to portfolio totals until the instrument currency is confirmed.",
    };
  }
  return { withheld: false, reason: null };
}

export function buildTradeExplanation(
  entry: Pick<
    AuditEntry,
    | "symbol"
    | "side"
    | "status"
    | "quantity"
    | "value"
    | "price"
    | "reason"
    | "rejectedReason"
    | "conviction"
    | "signalWeights"
    | "newsFactors"
  >,
  opts?: { unitsUnresolved?: boolean; unitsReason?: string },
): TradeExplanation {
  const weights = entry.signalWeights ?? {};
  const signals: ExplainedSignal[] = Object.entries(weights)
    .filter(([, v]) => Number.isFinite(v))
    .map(([key, v]) => ({
      key,
      label: humanise(key),
      weight: Number(v),
      family: classifySignal(key),
    }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

  const trendSignals = signals.filter((s) => s.family === "trend");
  const eventSignals = signals.filter((s) => s.family === "event");
  const otherSignals = signals.filter((s) => s.family === "other");

  const abs = (arr: ExplainedSignal[]) => arr.reduce((t, s) => t + Math.abs(s.weight), 0);
  const trendW = abs(trendSignals);
  const eventW = abs(eventSignals) + entry.newsFactors.length * 0.0; // news counted below
  const total = trendW + eventW + abs(otherSignals);
  const trendShare = total > 0 ? trendW / total : 0;
  const eventShare = total > 0 ? eventW / total : 0;

  const aligned = entry.newsFactors.filter((n) => n.alignment === "aligned").length;
  const opposing = entry.newsFactors.filter((n) => n.alignment === "opposing").length;

  let driver: TradeExplanation["driver"];
  if (total <= 0 && entry.newsFactors.length === 0) driver = "unattributed";
  else if (total <= 0) driver = "event-led";
  else if (trendShare >= eventShare + 0.2) driver = "trend-led";
  else if (eventShare >= trendShare + 0.2) driver = "event-led";
  else driver = "balanced";

  const score = entry.conviction != null && Number.isFinite(entry.conviction)
    ? Math.max(0, Math.min(1, entry.conviction))
    : null;
  const label = score != null ? confidenceLabel(score) : null;

  const drivers: string[] = [];
  if (trendSignals.length) {
    drivers.push(
      `${trendSignals.length} trend signal${trendSignals.length > 1 ? "s" : ""} (top: ${trendSignals[0].label})`,
    );
  }
  if (eventSignals.length) {
    drivers.push(
      `${eventSignals.length} event signal${eventSignals.length > 1 ? "s" : ""} (top: ${eventSignals[0].label})`,
    );
  }
  if (aligned) drivers.push(`${aligned} headline${aligned > 1 ? "s" : ""} supporting the ${entry.side}`);
  if (opposing) drivers.push(`${opposing} headline${opposing > 1 ? "s" : ""} pushing the other way`);
  if (!drivers.length) drivers.push("No weighted signals were recorded for this order");

  const withheldFromText = detectUnitsUnresolved(entry);
  const withheldValue = opts?.unitsUnresolved
    ? {
        withheld: true,
        reason:
          opts.unitsReason ??
          withheldFromText.reason ??
          "Price units could not be resolved (pence vs pounds), so the value is withheld until the instrument currency is confirmed.",
      }
    : withheldFromText;

  const sideWord = entry.side === "buy" ? "buy" : "sell";
  const driverWord =
    driver === "trend-led"
      ? "price trend"
      : driver === "event-led"
        ? "news and events"
        : driver === "balanced"
          ? "a mix of price trend and news"
          : "no recorded signal weights";

  const headline =
    entry.status === "rejected"
      ? `The AI wanted to ${sideWord} ${entry.symbol} on ${driverWord}, but the order was blocked before it reached the broker.`
      : `The AI chose to ${sideWord} ${entry.symbol}, driven mainly by ${driverWord}.`;

  const bullets: string[] = [];
  bullets.push(
    driver === "unattributed"
      ? "No signal breakdown was recorded, so this decision cannot be attributed to trend or events."
      : `Attribution: ${Math.round(trendShare * 100)}% trend vs ${Math.round(eventShare * 100)}% events${otherSignals.length ? ` (${Math.round((1 - trendShare - eventShare) * 100)}% other)` : ""}.`,
  );
  if (label) {
    bullets.push(
      `Confidence ${label} (${score!.toFixed(2)} conviction) — ${drivers.slice(0, 2).join("; ")}.`,
    );
  } else {
    bullets.push("Confidence was not recorded for this order.");
  }
  if (entry.rejectedReason) bullets.push(`Blocked because: ${entry.rejectedReason}.`);
  if (withheldValue.withheld && withheldValue.reason) bullets.push(withheldValue.reason);

  return {
    headline,
    driver,
    trendSignals,
    eventSignals,
    otherSignals,
    trendShare,
    eventShare,
    confidence: { score, label, drivers },
    withheldValue,
    bullets,
  };
}
