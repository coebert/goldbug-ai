// Dynamic SMA position sizing.
//
// The crossover rules used to size with step functions: any golden regime
// multiplied the ticket by a fixed `goldenSizeMult`, any fast bull cross by
// `fastBullSizeMult`, any bear cross halved it. A 0.51% SMA50/200 spread that
// barely cleared the threshold therefore got exactly the same conviction as a
// 9% spread, and a cross from ten sessions ago sized the same as one from
// yesterday.
//
// This module turns those steps into a continuous response:
//
//   • regime conviction ramps from the configured separation threshold up to
//     a saturation spread, so a marginal golden cross adds little size and a
//     deep one adds the full boost;
//   • the same ramp works in reverse for a death regime that only sizes down
//     (aggressive profiles) instead of vetoing;
//   • fast-cross conviction combines separation with freshness — the boost
//     decays as the cross ages towards `maxCrossAgeBars`;
//   • the combined multiplier is clamped to per-risk bounds so no
//     configuration can size a trade beyond what the risk level permits.
//
// The endpoints are unchanged: at full conviction the multipliers equal the
// existing `goldenSizeMult` / `fastBullSizeMult` / `deathSizeMult` constants,
// so a saturated signal sizes exactly as it did before. Everything between
// the threshold and saturation is what becomes proportional.

import type { SmaCrossRuleConfig, SmaCrossState } from "./sma-cross-rules";

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/**
 * Conviction in [0,1] for a separation that must clear `threshold` to count
 * at all and saturates at `saturation`. A degenerate band (saturation at or
 * below threshold) collapses to a step so callers can never divide by zero.
 */
export function separationConviction(
  separationPct: number | null | undefined,
  threshold: number,
  saturation: number,
): number {
  const sep = Math.abs(Number(separationPct) || 0);
  const lo = Math.max(0, threshold);
  const hi = Math.max(lo, saturation);
  if (sep <= lo) return 0;
  if (hi <= lo) return 1;
  return clamp01((sep - lo) / (hi - lo));
}

/**
 * Freshness in [0,1]: 1 on the bar the cross confirmed, decaying linearly to
 * `1 - freshnessWeight` at `maxCrossAgeBars` and 0 beyond it. Unknown age is
 * treated as stale-but-valid regime state rather than a fresh trigger.
 */
export function crossFreshness(
  ageBars: number | null | undefined,
  maxCrossAgeBars: number,
  freshnessWeight: number,
): number {
  const w = clamp01(freshnessWeight);
  if (ageBars == null || !Number.isFinite(ageBars)) return 1 - w;
  const maxAge = Math.max(1, maxCrossAgeBars);
  if (ageBars >= maxAge) return 1 - w;
  return clamp01(1 - w * (Math.max(0, ageBars) / maxAge));
}

export type SmaSizeComponents = {
  /** Regime (SMA50/200) conviction 0-1. */
  regimeConviction: number;
  /** Fast (SMA20/50) conviction 0-1, already decayed for cross age. */
  fastConviction: number;
  /** Multiplier contributed by the regime leg. */
  regimeMult: number;
  /** Multiplier contributed by the fast-cross leg. */
  fastMult: number;
  /** Base multiplier before the legs (1, or the unknown-regime haircut). */
  baseMult: number;
};

export type SmaSizeResult = {
  /** Combined multiplier, clamped to the risk profile's bounds. */
  mult: number;
  /** Product before clamping, for telemetry. */
  rawMult: number;
  /** True when a bound bit. */
  clamped: boolean;
  components: SmaSizeComponents;
  notes: string[];
};

/**
 * Scale a buy's intended notional by trend conviction.
 *
 * Only sizing lives here — the death-cross veto stays in `smaCrossBuyRule`,
 * which calls this once it has decided the trade is allowed at all.
 */
export function smaDynamicSizeMultiplier(
  state: SmaCrossState,
  cfg: SmaCrossRuleConfig,
): SmaSizeResult {
  const notes: string[] = [];
  const fmt = (v: number) => `${(v * 100).toFixed(2)}%`;

  const baseMult = state.regimeUnknown ? Math.max(0, cfg.unknownRegimeSizeMult) : 1;
  if (state.regimeUnknown) {
    notes.push(`no SMA200 (${state.bars} bars) — base ×${baseMult.toFixed(2)}`);
  }

  // ---- Regime leg (SMA50 vs SMA200) ----------------------------------
  let regimeConviction = 0;
  let regimeMult = 1;
  if (!state.regimeUnknown && state.regime) {
    regimeConviction = separationConviction(
      state.regimeSeparationPct,
      cfg.regimeSeparationPct,
      cfg.regimeSaturationPct,
    );
    // A fresh regime cross carries more information than a long-standing
    // one, but the regime itself never fully decays — it is a state, not a
    // trigger — so freshness only modulates the top half of the ramp.
    const fresh =
      state.regimeCross != null
        ? crossFreshness(state.regimeCrossAgeBars, cfg.maxCrossAgeBars, cfg.freshnessWeight)
        : 1;
    const conviction = clamp01(regimeConviction * (0.5 + 0.5 * fresh));
    regimeConviction = conviction;

    if (state.regime === "golden") {
      regimeMult = 1 + (Math.max(1, cfg.goldenSizeMult) - 1) * conviction;
      notes.push(
        `${state.regimeCross === "golden" ? "fresh golden cross" : "golden regime"} ${fmt(
          state.regimeSeparationPct ?? 0,
        )} → ×${regimeMult.toFixed(2)} (conviction ${(conviction * 100).toFixed(0)}%)`,
      );
    } else {
      // Death regime that is allowed to trade: cut proportionally towards
      // `deathSizeMult` as the spread deepens.
      const floorMult = Math.max(0, Math.min(1, cfg.deathSizeMult));
      regimeMult = 1 - (1 - floorMult) * conviction;
      notes.push(
        `death regime ${fmt(state.regimeSeparationPct ?? 0)} → ×${regimeMult.toFixed(2)} (conviction ${(
          conviction * 100
        ).toFixed(0)}%)`,
      );
    }
  }

  // ---- Fast leg (SMA20 vs SMA50) -------------------------------------
  let fastConviction = 0;
  let fastMult = 1;
  if (state.fastCross === "bull") {
    const priceOk =
      !cfg.requirePriceConfirmation || (state.sma20 != null && state.price > state.sma20);
    if (priceOk) {
      fastConviction = clamp01(
        separationConviction(
          state.fastSeparationPct,
          cfg.fastSeparationPct,
          cfg.fastSaturationPct,
        ) * crossFreshness(state.fastCrossAgeBars, cfg.maxCrossAgeBars, cfg.freshnessWeight),
      );
      fastMult = 1 + (Math.max(1, cfg.fastBullSizeMult) - 1) * fastConviction;
      notes.push(
        `SMA20↑SMA50 ${state.fastCrossAgeBars ?? "?"}d ago ${fmt(
          state.fastSeparationPct ?? 0,
        )} → ×${fastMult.toFixed(2)} (conviction ${(fastConviction * 100).toFixed(0)}%)`,
      );
    } else {
      notes.push("SMA20↑SMA50 unconfirmed (px<SMA20) — no boost");
    }
  } else if (state.fastCross === "bear") {
    // Fast trend rolled over: cut towards `fastBearBuyMult` in proportion to
    // how decisively it rolled over.
    fastConviction = clamp01(
      separationConviction(
        state.fastSeparationPct,
        cfg.fastSeparationPct,
        cfg.fastSaturationPct,
      ) * crossFreshness(state.fastCrossAgeBars, cfg.maxCrossAgeBars, cfg.freshnessWeight),
    );
    const floorMult = Math.max(0, Math.min(1, cfg.fastBearBuyMult));
    fastMult = 1 - (1 - floorMult) * fastConviction;
    notes.push(
      `SMA20↓SMA50 ${fmt(state.fastSeparationPct ?? 0)} → ×${fastMult.toFixed(2)} (conviction ${(
        fastConviction * 100
      ).toFixed(0)}%)`,
    );
  }

  const rawMult = Math.max(0, baseMult * regimeMult * fastMult);
  const lo = Math.max(0, cfg.minSizeMult);
  const hi = Math.max(lo, cfg.maxSizeMult);
  const mult = Math.min(hi, Math.max(lo, rawMult));
  const clamped = Math.abs(mult - rawMult) > 1e-9;
  if (clamped) {
    notes.push(
      `clamped ×${rawMult.toFixed(2)} → ×${mult.toFixed(2)} (risk bounds ${lo.toFixed(2)}-${hi.toFixed(2)})`,
    );
  }

  return {
    mult,
    rawMult,
    clamped,
    components: { regimeConviction, fastConviction, regimeMult, fastMult, baseMult },
    notes,
  };
}
