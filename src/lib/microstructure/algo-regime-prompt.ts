// Formats an AlgoRegimeSnapshot into a prompt block for the LLM decision
// layer, and a short human summary for the heuristic fallback.

import type { AlgoRegimeSnapshot } from "./algo-regime";

export function formatAlgoRegimePromptBlock(s: AlgoRegimeSnapshot | null | undefined): string {
  if (!s) return "";
  const flags = [
    s.volBurst && "volatility_burst",
    s.liquidityVacuum && "liquidity_vacuum",
    s.whipsaw && "whipsaw",
    s.correlationSpike && "correlated_de-risking",
    s.gapFade && "gap_and_fade",
  ].filter(Boolean).join(", ") || "none";

  const guidance =
    s.tier === "extreme"
      ? "Extreme algo-regime: BLOCK new market buys this tick. If entries are unavoidable, use marketable-limit with ≤10bps slippage cap, halve normal size, and prefer VWAP over the last hour. Cut correlated exposure. Boost tail hedge."
      : s.tier === "elevated"
      ? "Elevated algo-regime: shrink new-buy size ×0.7, cap participation at ~5% of median volume, avoid market orders during vol bursts, and step aside for 1-2 sessions in whipsaw regimes."
      : "Normal algo-regime: default sizing and execution.";

  return `ALGO-REGIME GUARD (current): tier=${s.tier} score=${s.score}/5 signals=[${flags}]
Recommended guardrails → maxParticipation=${(s.multipliers.maxParticipation * 100).toFixed(1)}%, sizeScale=×${s.multipliers.sizeScale.toFixed(2)}, tailHedgeBoost=+${(s.multipliers.tailHedgeBoostPctNav * 100).toFixed(2)}%NAV, blockNewBuys=${s.multipliers.blockNewBuys}.
${guidance}`;
}

export function summarizeAlgoRegime(s: AlgoRegimeSnapshot | null | undefined): string {
  if (!s) return "algo-regime: unknown";
  return `algo-regime tier=${s.tier} (${s.score}/5 signals; ${s.reason})`;
}
