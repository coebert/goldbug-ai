// Deterministic estimate of how long the AI expects to hold a freshly bought
// position. No IO, no AI call — derived from the signal mix that drove the
// order plus the portfolio's trading style, so the UI can show it instantly
// next to the plain-English explanation (and the AI prompt can echo it).
//
// The estimate is an *intent* window, not a promise: exits still fire early on
// stops, guardrails or a signal flip.

import type { TradingStyle } from "./trading-style";

export type HoldWeights = Partial<{
  sma_trend: number;
  rsi: number;
  price_change: number;
  news_sentiment: number;
  volatility: number;
}>;

export type HoldingPeriodEstimate = {
  /** Short human label, e.g. "about 1–2 weeks". */
  label: string;
  minDays: number;
  maxDays: number;
  /** Plain-language reason the window is that long. */
  basis: string;
  /** What would make the AI exit sooner. */
  earlyExit: string;
  /** Sells don't have a holding window. */
  applicable: boolean;
};

function labelFor(minDays: number, maxDays: number): string {
  const fmt = (d: number) => {
    if (d < 14) return `${d} day${d === 1 ? "" : "s"}`;
    if (d < 60) return `${Math.round(d / 7)} weeks`;
    return `${Math.round(d / 30)} months`;
  };
  if (minDays >= 14 && maxDays >= 14 && maxDays < 60)
    return `about ${Math.round(minDays / 7)}–${Math.round(maxDays / 7)} weeks`;
  if (minDays >= 60) return `about ${Math.round(minDays / 30)}–${Math.round(maxDays / 30)} months`;
  if (maxDays < 14) return `about ${minDays}–${maxDays} days`;
  return `about ${fmt(minDays)} to ${fmt(maxDays)}`;
}

function dominant(weights: HoldWeights | null | undefined): { key: string; share: number } | null {
  if (!weights) return null;
  const entries = Object.entries(weights).filter(
    ([, v]) => typeof v === "number" && Number.isFinite(v) && (v as number) > 0,
  ) as Array<[string, number]>;
  if (!entries.length) return null;
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total <= 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return { key: entries[0][0], share: entries[0][1] / total };
}

export function estimateHoldingPeriod(input: {
  side: "buy" | "sell";
  weights?: HoldWeights | null;
  reason?: string | null;
  tradingStyle?: TradingStyle | null;
  /** Minimum days a swing position must be held before a discretionary sell. */
  minHoldDays?: number | null;
}): HoldingPeriodEstimate {
  if (input.side === "sell") {
    return {
      label: "n/a — closing a position",
      minDays: 0,
      maxDays: 0,
      basis: "This is a sell, so it releases the holding rather than starting a new one.",
      earlyExit: "",
      applicable: false,
    };
  }

  const text = (input.reason ?? "").toLowerCase();
  const top = dominant(input.weights);

  let minDays = 20;
  let maxDays = 60;
  let basis =
    "Driven by a mix of signals with no single dominant driver, so the AI plans a normal medium-term hold.";

  if (top) {
    switch (top.key) {
      case "sma_trend":
        minDays = 30;
        maxDays = 90;
        basis =
          "Bought mainly because the medium-term trend is up. Trends take weeks to play out, so the AI intends to stay in while that trend holds.";
        break;
      case "rsi":
        minDays = 5;
        maxDays = 15;
        basis =
          "Bought mainly on a short-term momentum snap-back (oversold), which typically resolves within a couple of weeks.";
        break;
      case "price_change":
        minDays = 10;
        maxDays = 30;
        basis =
          "Bought mainly on recent price action, which the AI treats as a short-to-medium swing rather than a long-term position.";
        break;
      case "news_sentiment":
        minDays = 5;
        maxDays = 20;
        basis =
          "Bought mainly on a news catalyst. The AI expects the market to digest the story within a few weeks.";
        break;
      case "volatility":
        minDays = 5;
        maxDays = 15;
        basis =
          "Sizing and timing were dominated by how choppy the price is, so the AI keeps the intended hold short.";
        break;
    }
  }

  if (/mania|squeeze|spike|hype/.test(text)) {
    minDays = Math.min(minDays, 3);
    maxDays = Math.min(maxDays, 10);
    basis += " Crowd-driven moves are treated as short-lived, shortening the window.";
  }
  if (/hedge|gold|defensive/.test(text)) {
    minDays = Math.max(minDays, 30);
    maxDays = Math.max(maxDays, 120);
    basis += " Defensive/hedge positions are held while the risk they insure against persists.";
  }

  if (input.tradingStyle === "swing") {
    minDays = Math.max(1, Math.min(minDays, 5));
    maxDays = Math.max(minDays + 1, Math.min(maxDays, 20));
    basis += " This portfolio runs a swing style, which caps holds to days-to-weeks.";
  }

  const floor = Math.max(0, Math.round(Number(input.minHoldDays ?? 0)));
  if (floor > 0 && minDays < floor) minDays = floor;
  if (maxDays < minDays) maxDays = minDays;

  return {
    label: labelFor(minDays, maxDays),
    minDays,
    maxDays,
    basis,
    earlyExit:
      "It can be sold sooner if a stop-loss triggers, the signal that justified the buy flips, or a safety rule (cash floor, risk halt) forces a trim.",
    applicable: true,
  };
}
