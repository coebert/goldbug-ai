// Phase 4 — Regime → strategy-weight matrix.
//
// Weights sum to 1 per regime and represent how much of the composite
// score each model contributes. When no regime is detected we fall back
// to a balanced blend that leans on trend + quality.
//
// The regime name is normalised (lowercased, spaces collapsed) before
// lookup so upstream detectors can use either snake_case or human labels.
import type { AlphaModelKind } from "./types";

export type RegimeName =
  | "risk_on"
  | "risk_off"
  | "high_vol"
  | "low_vol"
  | "trending"
  | "range_bound"
  | "unknown";

export type StrategyWeights = Record<AlphaModelKind, number>;

const MATRIX: Record<RegimeName, StrategyWeights> = {
  // Broad up-trend, low fear — lean into trend + quality, dip-buying
  // still helps but carry is dead weight.
  risk_on:     { trend: 0.42, mean_reversion: 0.16, quality: 0.22, carry: 0.05, breakout: 0.15 },
  // Defensive — quality + carry dominate, cut trend exposure, keep a
  // small mean-reversion tilt for capitulation dip-buys.
  risk_off:    { trend: 0.10, mean_reversion: 0.18, quality: 0.38, carry: 0.28, breakout: 0.06 },
  // Vol spikes — trend gets whipsawed, MR gets hurt by knives, quality
  // + carry survive best.
  high_vol:    { trend: 0.14, mean_reversion: 0.14, quality: 0.37, carry: 0.28, breakout: 0.07 },
  // Calm tape — trend and MR both work, carry rewarded.
  low_vol:     { trend: 0.30, mean_reversion: 0.22, quality: 0.22, carry: 0.13, breakout: 0.13 },
  // Directional — trend dominates.
  trending:    { trend: 0.48, mean_reversion: 0.08, quality: 0.20, carry: 0.04, breakout: 0.20 },
  // Range-bound — MR dominates.
  range_bound: { trend: 0.08, mean_reversion: 0.48, quality: 0.22, carry: 0.09, breakout: 0.13 },
  // Fallback — balanced.
  unknown:     { trend: 0.30, mean_reversion: 0.18, quality: 0.26, carry: 0.13, breakout: 0.13 },
};

const ALIASES: Record<string, RegimeName> = {
  bull: "risk_on", risk_on: "risk_on", "risk on": "risk_on",
  bear: "risk_off", risk_off: "risk_off", "risk off": "risk_off",
  high_vol: "high_vol", volatile: "high_vol", "high vol": "high_vol",
  low_vol: "low_vol", calm: "low_vol", "low vol": "low_vol",
  trending: "trending", trend: "trending",
  range_bound: "range_bound", range: "range_bound", choppy: "range_bound",
  // Persisted regime-detector labels → tail-hedge / weights matrix
  bull_quiet: "low_vol",
  bull_volatile: "risk_on",
  correction: "high_vol",
  crisis: "risk_off",
  recovery: "risk_on",
};

export function resolveRegime(raw: string | null | undefined): RegimeName {
  if (!raw) return "unknown";
  const key = String(raw).toLowerCase().replace(/\s+/g, " ").trim();
  return ALIASES[key] ?? (key in MATRIX ? (key as RegimeName) : "unknown");
}

export function weightsForRegime(raw: string | null | undefined): StrategyWeights {
  return MATRIX[resolveRegime(raw)];
}

// Phase 1 — regime-based strategy on/off switching.
//
// Rather than always running every model at some weight, some strategies
// have well-documented failure modes in specific regimes. When disabled a
// strategy contributes 0 to the composite (its weight is redistributed to
// the still-enabled strategies), rather than merely being downweighted.
//
// Rules (from historical playbook + hedge-fund school priors):
//   - Trend-following whipsaws in high_vol and range_bound.
//   - Mean-reversion catches falling knives in risk_off / high_vol.
//   - Carry underperforms in risk_on trend markets and blows up in risk_off
//     when spreads widen — safest in low_vol.
//   - Quality is the one factor we never fully disable; it is our
//     defensive default across every regime.
const ENABLEMENT: Record<RegimeName, Record<AlphaModelKind, boolean>> = {
  risk_on:     { trend: true,  mean_reversion: true,  quality: true, carry: false, breakout: true  },
  risk_off:    { trend: false, mean_reversion: false, quality: true, carry: false, breakout: false },
  high_vol:    { trend: false, mean_reversion: false, quality: true, carry: true,  breakout: false },
  low_vol:     { trend: true,  mean_reversion: true,  quality: true, carry: true,  breakout: true  },
  trending:    { trend: true,  mean_reversion: false, quality: true, carry: false, breakout: true  },
  range_bound: { trend: false, mean_reversion: true,  quality: true, carry: true,  breakout: true  },
  unknown:     { trend: true,  mean_reversion: true,  quality: true, carry: true,  breakout: true  },
};

export function enabledStrategiesForRegime(
  raw: string | null | undefined,
): Record<AlphaModelKind, boolean> {
  return ENABLEMENT[resolveRegime(raw)];
}

// Return regime weights with disabled strategies zeroed out and the
// remaining weight renormalised across the enabled set. If every
// strategy is disabled (should not happen — quality is always on) we
// return the raw weights untouched to avoid a division by zero.
export function effectiveWeightsForRegime(
  raw: string | null | undefined,
): StrategyWeights {
  const base = weightsForRegime(raw);
  const enabled = enabledStrategiesForRegime(raw);
  const gated: StrategyWeights = { trend: 0, mean_reversion: 0, quality: 0, carry: 0, breakout: 0 };
  let live = 0;
  (Object.keys(base) as AlphaModelKind[]).forEach((k) => {
    if (enabled[k]) {
      gated[k] = base[k];
      live += base[k];
    }
  });
  if (live <= 0) return base;
  (Object.keys(gated) as AlphaModelKind[]).forEach((k) => {
    gated[k] = gated[k] / live;
  });
  return gated;
}

