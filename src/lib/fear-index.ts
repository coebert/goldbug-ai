// Composite "fear index" (0..100) — a single market-fear gauge the AI and the
// deterministic sizing layer both consume.
//
// 0   = extreme greed / complacency
// 50  = neutral
// 100 = extreme fear / panic
//
// Components (each mapped to 0..100, then weighted):
//   * VIX level               — the classic fear gauge
//   * VIX term structure      — backwardation = near-term hedging demand
//   * Short-term stress       — VIX9D vs VIX
//   * VVIX (vol-of-vol)       — uncertainty about volatility itself
//   * SKEW                    — left-tail pricing
//   * Put/call proxy          — defensive positioning
//   * Index drawdown          — realised pain
//
// Pure module: no I/O, trivially testable.

export type FearIndexInputs = {
  vix?: number | null;
  vix9d?: number | null;
  vix3m?: number | null;
  vvix?: number | null;
  skew?: number | null;
  putCallProxy?: number | null;
  /** SPY drawdown from its recent peak, as a negative fraction (e.g. -0.12). */
  drawdownPct?: number | null;
};

export type FearLabel =
  | "extreme_greed"
  | "greed"
  | "neutral"
  | "fear"
  | "extreme_fear";

export type FearIndexResult = {
  /** 0..100, higher = more fear. */
  score: number;
  label: FearLabel;
  /** Deterministic multiplier applied to new BUY sizing (0.35 .. 1.1). */
  sizeMultiplier: number;
  /** True when fear is so extreme that fresh speculative buys should be blocked. */
  blockNewBuys: boolean;
  components: Array<{ name: string; value: number | null; score: number | null; weight: number }>;
  reason: string;
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Linear map of `v` from [a,b] onto [0,100], clamped. */
function ramp(v: number, a: number, b: number): number {
  if (b === a) return 50;
  return clamp(((v - a) / (b - a)) * 100, 0, 100);
}

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function labelFor(score: number): FearLabel {
  if (score >= 80) return "extreme_fear";
  if (score >= 60) return "fear";
  if (score > 40) return "neutral";
  if (score > 20) return "greed";
  return "extreme_greed";
}

export function humanFearLabel(label: FearLabel): string {
  switch (label) {
    case "extreme_fear": return "Extreme fear";
    case "fear": return "Fear";
    case "neutral": return "Neutral";
    case "greed": return "Greed";
    case "extreme_greed": return "Extreme greed / complacency";
  }
}

/**
 * Compute the composite fear index and the sizing response.
 *
 * Missing components are dropped and the remaining weights re-normalised, so a
 * partial data feed still yields a usable gauge. With no inputs at all the
 * result is a neutral 50 with a neutral multiplier.
 */
export function computeFearIndex(inputs: FearIndexInputs): FearIndexResult {
  const vix = num(inputs.vix);
  const vix9d = num(inputs.vix9d);
  const vix3m = num(inputs.vix3m);
  const vvix = num(inputs.vvix);
  const skew = num(inputs.skew);
  const pc = num(inputs.putCallProxy);
  const dd = num(inputs.drawdownPct);

  const termRatio = vix != null && vix > 0 && vix3m != null ? vix3m / vix : null;
  const shortRatio = vix != null && vix > 0 && vix9d != null ? vix9d / vix : null;

  const components: FearIndexResult["components"] = [
    // VIX 12 → calm, 40 → panic
    { name: "vix", value: vix, score: vix == null ? null : ramp(vix, 12, 40), weight: 0.3 },
    // Term structure: 1.15 contango (calm) → 0.92 backwardation (fear)
    { name: "term_structure", value: termRatio, score: termRatio == null ? null : ramp(termRatio, 1.15, 0.92), weight: 0.15 },
    // Short-term stress: VIX9D/VIX 0.9 (calm) → 1.25 (spike)
    { name: "short_term_stress", value: shortRatio, score: shortRatio == null ? null : ramp(shortRatio, 0.9, 1.25), weight: 0.1 },
    // VVIX 80 → 140
    { name: "vvix", value: vvix, score: vvix == null ? null : ramp(vvix, 80, 140), weight: 0.15 },
    // SKEW 115 → 150
    { name: "skew", value: skew, score: skew == null ? null : ramp(skew, 115, 150), weight: 0.1 },
    // Put/call proxy already 0..1
    { name: "put_call_proxy", value: pc, score: pc == null ? null : clamp(pc * 100, 0, 100), weight: 0.1 },
    // Drawdown 0 → -20%
    { name: "drawdown", value: dd, score: dd == null ? null : ramp(-dd, 0, 0.2), weight: 0.1 },
  ];

  const present = components.filter((c) => c.score != null);
  const totalWeight = present.reduce((s, c) => s + c.weight, 0);
  const score = totalWeight > 0
    ? present.reduce((s, c) => s + (c.score as number) * c.weight, 0) / totalWeight
    : 50;
  const rounded = Math.round(clamp(score, 0, 100) * 10) / 10;
  const label = labelFor(rounded);

  // Sizing response. Fear shrinks new buys hard; mild complacency allows a
  // small (10%) uplift, but extreme greed is itself a risk signal so the
  // uplift tapers back toward neutral below score 15.
  let sizeMultiplier: number;
  if (rounded >= 85) sizeMultiplier = 0.35;
  else if (rounded >= 70) sizeMultiplier = 0.5;
  else if (rounded >= 60) sizeMultiplier = 0.7;
  else if (rounded >= 45) sizeMultiplier = 1;
  else if (rounded >= 15) sizeMultiplier = 1.1;
  else sizeMultiplier = 0.9; // euphoric complacency — trim risk-taking

  const blockNewBuys = rounded >= 90;

  const detail = present
    .map((c) => `${c.name}=${(c.score as number).toFixed(0)}`)
    .join(", ");

  return {
    score: rounded,
    label,
    sizeMultiplier,
    blockNewBuys,
    components,
    reason: present.length
      ? `${humanFearLabel(label)} (${rounded.toFixed(0)}/100) — ${detail}`
      : "fear index unavailable — neutral assumption",
  };
}

/** Prompt block handed to the AI so its narrative decisions honour the gauge. */
export function formatFearIndexBlock(f: FearIndexResult): string {
  const guidance: string[] = [];
  if (f.label === "extreme_fear") {
    guidance.push(
      "EXTREME FEAR: capital preservation first. No speculative or momentum-chasing buys. Only high-quality, oversold names at reduced size; prefer holding cash and hedges.",
    );
  } else if (f.label === "fear") {
    guidance.push(
      "FEAR: size new buys down materially, widen entry patience, avoid crowded/high-beta names, and keep the cash floor comfortably intact.",
    );
  } else if (f.label === "neutral") {
    guidance.push("NEUTRAL fear regime: standard sizing and playbook apply.");
  } else if (f.label === "greed") {
    guidance.push("GREED: trend-following permitted, but tighten stops and avoid adding to already-extended winners.");
  } else {
    guidance.push(
      "EXTREME GREED / COMPLACENCY: hedges are cheap and the tape is priced for perfection. Favour trimming crowded winners, raising quality, and keeping tail hedges on.",
    );
  }
  if (f.blockNewBuys) guidance.push("Fear is at panic levels — new BUY orders will be blocked by guardrails this tick.");
  guidance.push(`New-buy size multiplier enforced by guardrails: ×${f.sizeMultiplier.toFixed(2)}.`);
  guidance.push(
    "BUY-SIDE ONLY: this gauge must never justify selling. Do NOT propose sells because fear/VIX/panic is elevated — " +
      "guardrails will reject any sell whose reason cites market fear without an independent exit rule " +
      "(stop-loss, trailing/ATR stop, take-profit, rebalance, position/correlation cap, broken thesis, risk halt). " +
      "Hold through fear spikes; use cash and hedges instead of liquidating.",
  );

  const rows = f.components
    .map((c) => `- ${c.name}: ${c.value == null ? "n/a" : c.value.toFixed(2)}${c.score == null ? "" : ` → fear ${c.score.toFixed(0)}/100`}`)
    .join("\n");

  return `FEAR INDEX (composite market-fear gauge, 0 = extreme greed, 100 = extreme fear):
- Score: ${f.score.toFixed(0)}/100 → ${humanFearLabel(f.label)}
${rows}
${guidance.map((g) => `• ${g}`).join("\n")}
Treat this gauge as a hard overlay on NEW BUYS ONLY: conviction must be discounted when fear is elevated, regardless of how strong the trend looks. It is never a sell signal.`;
}
