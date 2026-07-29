// Retail-mania / short-squeeze detector — post-GameStop 2021 guardrail.
//
// Detects late-stage parabolic single-name behaviour of the kind that produced
// the Jan-2021 GME/AMC/BBBY moves: reflexive retail crowding, gamma squeeze,
// and violent mean-reversion once the buy-side liquidity loop breaks.
//
// This module is intentionally simple and pure so it can run both in the
// trading engine (as a hard-skip filter on new BUYs) and in the heuristic
// fallback. It does NOT need social-media data to fire — price/volume/RSI
// signatures alone are sufficient for the mania regime; short-interest &
// social velocity are optional boosters when we have them.

export type ManiaInput = {
  symbol: string;
  /** 5-day cumulative return, e.g. 0.35 = +35%. */
  change5d?: number | null;
  /** 30-day cumulative return. */
  change30d?: number | null;
  /** RSI-14 (0–100). */
  rsi14?: number | null;
  /** Ratio of recent volume to 20-day median volume (1 = normal). */
  volumeRatio20d?: number | null;
  /** Reported short interest as a fraction of float, e.g. 0.25 = 25%. */
  shortInterestPctFloat?: number | null;
  /** Multiplier of weekly OTM call open interest vs 60d baseline. */
  weeklyCallOiRatio?: number | null;
  /** Multiplier of ticker mentions on retail social channels vs 30d baseline. */
  socialMentionRatio?: number | null;
};

export type ManiaTier = "none" | "watch" | "mania";

export type ManiaComponent =
  | "parabola5d"
  | "parabola30d"
  | "rsi"
  | "volume"
  | "shortSqueeze"
  | "gamma"
  | "social";

/** One score contribution — displayable as "5d parabola +2.0". */
export type ManiaScoreItem = {
  component: ManiaComponent;
  /** Short human-readable label ("5d parabola", "RSI extreme"). */
  label: string;
  /** Weight this component added to the total score. */
  weight: number;
  /** Rendered detail ("+62% ≥ +50%", "RSI 88"). */
  detail: string;
};

export type ManiaSignal = {
  symbol: string;
  tier: ManiaTier;
  score: number;
  reasons: string[];
  /** Per-component score contributions, in fire order. */
  scoreBreakdown: ManiaScoreItem[];
  /** If true, callers MUST reject new BUYs on this symbol. */
  blockNewBuys: boolean;
  /** If true, callers should trim an existing long into strength. */
  trimExistingLong: boolean;
};


/**
 * Evaluate a single symbol for retail-mania / short-squeeze conditions.
 *
 * Thresholds are calibrated to the observed GME-2021 parabola so we would
 * have hard-skipped BUYs from ~Jan 22 onward — while still allowing normal
 * momentum entries (e.g. 5d +5%, RSI 60) to pass.
 */
export function detectRetailMania(input: ManiaInput): ManiaSignal {
  const reasons: string[] = [];
  const scoreBreakdown: ManiaScoreItem[] = [];
  let score = 0;

  const add = (item: ManiaScoreItem) => {
    scoreBreakdown.push(item);
    reasons.push(`${item.label}: ${item.detail}`);
    score += item.weight;
  };

  const c5 = input.change5d ?? null;
  const c30 = input.change30d ?? null;
  const rsi = input.rsi14 ?? null;
  const vol = input.volumeRatio20d ?? null;
  const si = input.shortInterestPctFloat ?? null;
  const gamma = input.weeklyCallOiRatio ?? null;
  const social = input.socialMentionRatio ?? null;

  if (typeof c5 === "number" && c5 >= 0.5) {
    add({ component: "parabola5d", label: "5d parabola", weight: 2, detail: `+${(c5 * 100).toFixed(0)}% ≥ +50%` });
  }
  if (typeof c30 === "number" && c30 >= 1.0) {
    add({ component: "parabola30d", label: "30d parabola", weight: 2, detail: `+${(c30 * 100).toFixed(0)}% ≥ +100%` });
  }
  if (typeof rsi === "number" && rsi >= 85) {
    add({ component: "rsi", label: "RSI extreme", weight: 1.5, detail: `RSI ${rsi.toFixed(0)} ≥ 85` });
  }
  if (typeof vol === "number" && vol >= 5) {
    add({ component: "volume", label: "Volume surge", weight: 1, detail: `${vol.toFixed(1)}× 20d median` });
  }
  // Short-squeeze booster — crowded short + fast ramp is the GME setup.
  if (typeof si === "number" && si >= 0.2 && typeof c5 === "number" && c5 >= 0.3) {
    add({
      component: "shortSqueeze",
      label: "Short squeeze",
      weight: 2,
      detail: `SI ${(si * 100).toFixed(0)}% float + 5d +${(c5 * 100).toFixed(0)}%`,
    });
  }
  // Gamma-squeeze latent — dealer short-gamma amplifies the up-move.
  if (typeof gamma === "number" && gamma >= 5) {
    add({ component: "gamma", label: "Gamma squeeze", weight: 1, detail: `weekly OTM call OI ${gamma.toFixed(1)}× baseline` });
  }
  // Social velocity confirms crowding (caution, not alpha).
  if (typeof social === "number" && social >= 5) {
    add({ component: "social", label: "Retail crowding", weight: 0.5, detail: `mentions ${social.toFixed(1)}× baseline` });
  }

  let tier: ManiaTier = "none";
  if (score >= 2) tier = "watch";
  if (score >= 3.5) tier = "mania";

  const blockNewBuys = tier === "mania";
  const trimExistingLong =
    tier === "mania" ||
    (typeof rsi === "number" && rsi >= 85 && typeof c5 === "number" && c5 >= 0.5);

  return { symbol: input.symbol, tier, score, reasons, scoreBreakdown, blockNewBuys, trimExistingLong };
}

/**
 * Compact one-line explanation suitable for logging into `counterfactuals.block_reason`
 * and rendering in the decision-summary card. Always starts with the tier so
 * downstream categorization is trivial.
 */
export function formatManiaExplanation(sig: ManiaSignal, action: "block" | "trim" = "block"): string {
  const verb = action === "trim" ? "trim" : "block new buys";
  const parts = sig.scoreBreakdown.map((s) => `${s.label} ${s.detail} (+${s.weight})`);
  return `retail-mania guardrail (${sig.tier}, score ${sig.score.toFixed(1)}): ${verb} — ${parts.join("; ")}`;
}


/** Batch helper — returns only symbols that should hard-skip on BUY. */
export function symbolsToBlockForBuy(inputs: ManiaInput[]): Set<string> {
  const out = new Set<string>();
  for (const i of inputs) {
    if (detectRetailMania(i).blockNewBuys) out.add(i.symbol);
  }
  return out;
}
