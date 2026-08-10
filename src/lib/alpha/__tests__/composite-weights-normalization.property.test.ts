/**
 * Property-based invariants for composite alpha weights.
 *
 * These tests exhaustively fuzz `weightsForRegime` / `effectiveWeightsForRegime`
 * across every known regime (plus alias strings and arbitrary garbage input)
 * and pin the normalisation contract the rest of the alpha pipeline relies on:
 *
 *   1. Raw weights per regime always sum to 1 and are non-negative.
 *   2. Effective (gated + renormalised) weights always sum to 1 and are
 *      non-negative, regardless of which strategies the regime gates off.
 *   3. Gated strategies are exactly 0 in the effective vector.
 *   4. Enabled strategies preserve their *relative* proportions after
 *      renormalisation (ratio invariance).
 *   5. Arbitrary junk strings resolve to a valid regime (fallback = unknown)
 *      and still satisfy every invariant above.
 *   6. `resolveRegime` is idempotent — resolving twice equals resolving once.
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  resolveRegime,
  weightsForRegime,
  enabledStrategiesForRegime,
  effectiveWeightsForRegime,
  type RegimeName,
  type StrategyWeights,
} from "../regime-matrix";
import type { AlphaModelKind } from "../types";

const REGIMES: RegimeName[] = [
  "risk_on", "risk_off", "high_vol", "low_vol",
  "trending", "range_bound", "unknown",
];

const KINDS: AlphaModelKind[] = ["trend", "mean_reversion", "quality", "carry", "breakout"];

// Known aliases the matrix accepts, plus a handful of casing / whitespace
// mutations we want to survive normalisation.
const ALIAS_STRINGS = [
  "Risk On", "risk on", "RISK_ON", "bull",
  "Risk Off", "bear",
  "high vol", "volatile",
  "low vol", "calm",
  "trend", "Trending",
  "range", "choppy",
  "bull_quiet", "bull_volatile", "correction", "crisis", "recovery",
];

const EPS = 1e-9;

// Pinned so fast-check replays the exact same sample sequence on every run —
// a property that only fails for one-in-a-thousand inputs must fail on CI too,
// not intermittently. Bump deliberately (and re-run) when broadening coverage.
const FC_SEED = 20260731;
const FC_RUN = { seed: FC_SEED, endOnFailure: true } as const;

const sum = (w: StrategyWeights): number =>
  KINDS.reduce((acc, k) => acc + w[k], 0);

const isFiniteWeights = (w: StrategyWeights): boolean =>
  KINDS.every((k) => Number.isFinite(w[k]));

describe("regime matrix: raw weight invariants (all regimes)", () => {
  it("every named regime has weights that sum to 1 and are in [0, 1]", () => {
    for (const r of REGIMES) {
      const w = weightsForRegime(r);
      expect(isFiniteWeights(w)).toBe(true);
      for (const k of KINDS) {
        expect(w[k]).toBeGreaterThanOrEqual(0);
        expect(w[k]).toBeLessThanOrEqual(1);
      }
      expect(sum(w)).toBeCloseTo(1, 9);
    }
  });
});

describe("regime matrix: effective weight invariants (all regimes)", () => {
  it("effective weights sum to 1, are non-negative, and zero out gated kinds", () => {
    for (const r of REGIMES) {
      const eff = effectiveWeightsForRegime(r);
      const gates = enabledStrategiesForRegime(r);

      expect(isFiniteWeights(eff)).toBe(true);
      for (const k of KINDS) {
        expect(eff[k]).toBeGreaterThanOrEqual(0);
        expect(eff[k]).toBeLessThanOrEqual(1);
        if (!gates[k]) {
          expect(eff[k]).toBe(0);
        }
      }
      expect(sum(eff)).toBeCloseTo(1, 9);
    }
  });

  it("preserves relative proportions of enabled strategies (ratio invariance)", () => {
    for (const r of REGIMES) {
      const raw = weightsForRegime(r);
      const eff = effectiveWeightsForRegime(r);
      const gates = enabledStrategiesForRegime(r);
      const enabled = KINDS.filter((k) => gates[k] && raw[k] > 0);

      // Every pair of enabled non-zero strategies keeps the same ratio
      // before/after renormalisation.
      for (let i = 0; i < enabled.length; i += 1) {
        for (let j = i + 1; j < enabled.length; j += 1) {
          const a = enabled[i];
          const b = enabled[j];
          const rawRatio = raw[a] / raw[b];
          const effRatio = eff[a] / eff[b];
          expect(effRatio).toBeCloseTo(rawRatio, 9);
        }
      }
    }
  });
});

describe("regime matrix: alias resolution invariants", () => {
  it("every documented alias resolves to a known regime with valid weights", () => {
    for (const alias of ALIAS_STRINGS) {
      const resolved = resolveRegime(alias);
      expect(REGIMES).toContain(resolved);

      const raw = weightsForRegime(alias);
      const eff = effectiveWeightsForRegime(alias);
      expect(sum(raw)).toBeCloseTo(1, 9);
      expect(sum(eff)).toBeCloseTo(1, 9);
    }
  });

  it("resolveRegime is idempotent", () => {
    for (const alias of [...ALIAS_STRINGS, ...REGIMES, "", "   ", "gibberish"]) {
      const once = resolveRegime(alias);
      const twice = resolveRegime(once);
      expect(twice).toBe(once);
    }
  });
});

describe("regime matrix: property-based fuzz (arbitrary input strings)", () => {
  it("any string input yields a valid regime + normalised weight vectors", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 40 }),
          fc.constantFrom(...REGIMES),
          fc.constantFrom(...ALIAS_STRINGS),
          fc.constant(null as unknown as string),
          fc.constant(undefined as unknown as string),
        ),
        (raw) => {
          const resolved = resolveRegime(raw);
          expect(REGIMES).toContain(resolved);

          const w = weightsForRegime(raw);
          const eff = effectiveWeightsForRegime(raw);

          // Raw invariants.
          expect(isFiniteWeights(w)).toBe(true);
          for (const k of KINDS) {
            expect(w[k]).toBeGreaterThanOrEqual(0);
            expect(w[k]).toBeLessThanOrEqual(1);
          }
          expect(sum(w)).toBeCloseTo(1, 9);

          // Effective invariants.
          expect(isFiniteWeights(eff)).toBe(true);
          const gates = enabledStrategiesForRegime(raw);
          for (const k of KINDS) {
            expect(eff[k]).toBeGreaterThanOrEqual(0);
            expect(eff[k]).toBeLessThanOrEqual(1 + EPS);
            if (!gates[k]) expect(eff[k]).toBe(0);
          }
          expect(sum(eff)).toBeCloseTo(1, 9);
        },
      ),
      { numRuns: 300, ...FC_RUN },
    );
  });

  it("case + whitespace mutations of a canonical regime resolve identically", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...REGIMES),
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 0, max: 4 }),
        (regime, leftPad, rightPad) => {
          // Skip "unknown" — it isn't reachable by alias table on purpose;
          // the raw string still round-trips because it exists in MATRIX.
          const mutated =
            " ".repeat(leftPad) +
            regime
              .split("")
              .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
              .join("") +
            " ".repeat(rightPad);
          expect(resolveRegime(mutated)).toBe(regime);
          expect(sum(weightsForRegime(mutated))).toBeCloseTo(1, 9);
          expect(sum(effectiveWeightsForRegime(mutated))).toBeCloseTo(1, 9);
        },
      ),
      { numRuns: 200, ...FC_RUN },
    );
  });
});
