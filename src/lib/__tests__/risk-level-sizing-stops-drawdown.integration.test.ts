// Integration tests: risk level → position sizing, stop conditions,
// and drawdown limits.
//
// Composes the risk knobs across the pieces that actually drive live
// trading decisions:
//   • riskProfile(level)           → position sizing + cash floor + new-pos/day
//   • effectiveCashFloorPct(cfg,l) → override plumbing for cash floor
//   • tightenForRegime(cfg,l,r)    → regime-linked stop-loss + per-symbol tightening
//   • grossExposureLimit(...)      → regime-linked drawdown-defense exposure cap
//   • DEFAULT_RISK_CONFIG          → static per-run drawdown-halt limit
//
// The tests treat these together — a single "risk level" change must
// propagate coherently to sizing, stops, and drawdown-limits, not just
// to one of them. Every assertion is deterministic and DB-free.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RISK_CONFIG,
  effectiveCashFloorPct,
  riskProfile,
  type RiskConfig,
} from "../universe.server";
import { tightenForRegime } from "../circuit-breaker.server";
import { grossExposureLimit } from "../portfolio-drawdown.server";
import type { PersistedRegime, RegimeLabel } from "../regime-detector.server";
import type { Database } from "@/integrations/supabase/types";

type Level = Database["public"]["Enums"]["risk_level"];
const LEVELS: Level[] = ["conservative", "balanced", "aggressive"];

const mkRegime = (regime: RegimeLabel): PersistedRegime => ({
  regime,
  previous_regime: null,
  transitioned: false,
  confidence: 0.8,
  signals: {
    spy_price: 100, spy_sma50: 100, spy_sma200: 100,
    spy_drawdown_pct: 0, spy_return_30d: 0, spy_vol_20d: 0.01,
    vix_level: 15, gld_return_30d: 0, tlt_return_30d: 0,
  },
  notes: "test",
  as_of: "2025-01-01",
});

const baseCfg = (over: Partial<RiskConfig> = {}): RiskConfig => ({
  ...DEFAULT_RISK_CONFIG,
  ...over,
});

// ---------------------------------------------------------------------------
// 1) POSITION SIZING
// ---------------------------------------------------------------------------
describe("risk level → position sizing", () => {
  it("maxPositionPct is strictly ordered conservative < balanced < aggressive", () => {
    const c = riskProfile("conservative").maxPositionPct;
    const b = riskProfile("balanced").maxPositionPct;
    const a = riskProfile("aggressive").maxPositionPct;
    expect(c).toBeLessThan(b);
    expect(b).toBeLessThan(a);
    // Sanity: sizes fall in a sensible band (never 0, never >100%).
    for (const p of [c, b, a]) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("maxNewPositionsPerDay grows with risk appetite", () => {
    expect(riskProfile("conservative").maxNewPositionsPerDay)
      .toBeLessThan(riskProfile("balanced").maxNewPositionsPerDay);
    expect(riskProfile("balanced").maxNewPositionsPerDay)
      .toBeLessThan(riskProfile("aggressive").maxNewPositionsPerDay);
  });

  it("cash floor moves inversely to risk (conservative keeps most, aggressive least)", () => {
    const c = riskProfile("conservative").cashFloorPct;
    const b = riskProfile("balanced").cashFloorPct;
    const a = riskProfile("aggressive").cashFloorPct;
    expect(c).toBeGreaterThan(b);
    expect(b).toBeGreaterThanOrEqual(a);
    expect(a).toBeGreaterThanOrEqual(0);
  });

  it("effectiveCashFloorPct honours per-portfolio override across every risk level", () => {
    for (const level of LEVELS) {
      // Override wins regardless of level.
      const cfg = baseCfg({ cash_floor_pct: 0.05 });
      expect(effectiveCashFloorPct(cfg, level)).toBe(0.05);

      // With no override, falls through to the risk-level preset.
      const noOverride = baseCfg({ cash_floor_pct: null });
      expect(effectiveCashFloorPct(noOverride, level))
        .toBe(riskProfile(level).cashFloorPct);

      // Out-of-range overrides are clamped, not passed through.
      expect(effectiveCashFloorPct(baseCfg({ cash_floor_pct: -1 }), level)).toBe(0);
      expect(effectiveCashFloorPct(baseCfg({ cash_floor_pct: 5 }), level)).toBe(1);
    }
  });

  it("higher risk → larger max notional per new position for the same equity", () => {
    const equity = 100_000;
    const notional = (l: Level) => equity * riskProfile(l).maxPositionPct;
    expect(notional("conservative")).toBeLessThan(notional("balanced"));
    expect(notional("balanced")).toBeLessThan(notional("aggressive"));
  });
});

// ---------------------------------------------------------------------------
// 2) STOP CONDITIONS
// ---------------------------------------------------------------------------
describe("risk level → stop conditions (via regime tightening)", () => {
  const cfg = baseCfg({ stop_loss_pct: 0.10, per_symbol_limit_pct: null });

  it("neutral (bull_quiet) regime leaves the base stop-loss untouched for every level", () => {
    for (const level of LEVELS) {
      const t = tightenForRegime(cfg, level, mkRegime("bull_quiet"));
      expect(t.stop_loss_effective_pct).toBeCloseTo(cfg.stop_loss_pct, 10);
    }
  });

  it("stops progressively tighten in correction → bear → crisis, identically per level", () => {
    for (const level of LEVELS) {
      const s0 = tightenForRegime(cfg, level, mkRegime("bull_quiet")).stop_loss_effective_pct;
      const s1 = tightenForRegime(cfg, level, mkRegime("correction")).stop_loss_effective_pct;
      const s2 = tightenForRegime(cfg, level, mkRegime("bear")).stop_loss_effective_pct;
      const s3 = tightenForRegime(cfg, level, mkRegime("crisis")).stop_loss_effective_pct;
      // Tighter = smaller stop distance from entry.
      expect(s1).toBeLessThan(s0);
      expect(s2).toBeLessThan(s1);
      expect(s3).toBeLessThan(s2);
    }
  });

  it("per-symbol effective cap shrinks with regime severity and preserves risk-level ordering", () => {
    for (const regime of ["bull_quiet", "correction", "bear", "crisis"] as const) {
      const caps = LEVELS.map(
        (l) => tightenForRegime(cfg, l, mkRegime(regime)).per_symbol_effective_pct,
      );
      // ordering across levels should always hold: cons < bal < agg
      expect(caps[0]).toBeLessThan(caps[1]);
      expect(caps[1]).toBeLessThan(caps[2]);
    }

    // Under crisis, every level's cap is <= its neutral cap.
    for (const level of LEVELS) {
      const neutral = tightenForRegime(cfg, level, mkRegime("bull_quiet")).per_symbol_effective_pct;
      const crisis = tightenForRegime(cfg, level, mkRegime("crisis")).per_symbol_effective_pct;
      expect(crisis).toBeLessThan(neutral);
    }
  });

  it("effective stop is floored at 0.5% even when the base stop is already tiny", () => {
    // A comically tight base stop plus crisis tightening still must not go below
    // the 0.005 floor guaranteed by tightenForRegime().
    const tinyCfg = baseCfg({ stop_loss_pct: 0.001 });
    for (const level of LEVELS) {
      const s = tightenForRegime(tinyCfg, level, mkRegime("crisis")).stop_loss_effective_pct;
      expect(s).toBeGreaterThanOrEqual(0.005);
    }
  });

  it("per-symbol override on cfg is respected as the base before tightening", () => {
    const override = baseCfg({ per_symbol_limit_pct: 0.05 });
    for (const level of LEVELS) {
      const neutral = tightenForRegime(override, level, mkRegime("bull_quiet"));
      // With an explicit override, the neutral cap equals the override, not the risk preset.
      expect(neutral.per_symbol_effective_pct).toBeCloseTo(0.05, 10);
      // Tightening still scales from that override.
      const crisis = tightenForRegime(override, level, mkRegime("crisis"));
      expect(crisis.per_symbol_effective_pct).toBeLessThan(neutral.per_symbol_effective_pct);
    }
  });
});

// ---------------------------------------------------------------------------
// 3) DRAWDOWN LIMITS
// ---------------------------------------------------------------------------
describe("risk level → drawdown limits", () => {
  it("max_drawdown_halt_pct is user-configurable per risk level and survives regime tightening", () => {
    // Simulate the natural pairing a user might set: tighter halt for the
    // more risk-averse profile.
    const halts: Record<Level, number> = {
      conservative: 0.10,
      balanced: 0.20,
      aggressive: 0.30,
    };
    for (const level of LEVELS) {
      const cfg = baseCfg({ max_drawdown_halt_pct: halts[level] });
      // The drawdown-halt threshold must NOT be mutated by regime tightening —
      // only per-symbol + stop tighten. Otherwise a bear regime would silently
      // change the halt the user configured.
      for (const regime of ["bull_quiet", "correction", "bear", "crisis"] as const) {
        const t = tightenForRegime(cfg, level, mkRegime(regime));
        expect(t.cfg.max_drawdown_halt_pct).toBe(halts[level]);
      }
    }
  });

  it("gross-exposure defense caps invested share tightly in crisis/bear regardless of level", () => {
    const totalValue = 100_000;
    const holdingsValue = 80_000; // 80% invested going into stress

    const neutral = grossExposureLimit(totalValue, holdingsValue, mkRegime("bull_quiet"));
    const correction = grossExposureLimit(totalValue, holdingsValue, mkRegime("correction"));
    const bear = grossExposureLimit(totalValue, holdingsValue, mkRegime("bear"));
    const crisis = grossExposureLimit(totalValue, holdingsValue, mkRegime("crisis"));

    // Target exposure must be monotonic in regime severity.
    expect(correction.target_pct).toBeLessThan(neutral.target_pct);
    expect(bear.target_pct).toBeLessThan(correction.target_pct);
    expect(crisis.target_pct).toBeLessThan(bear.target_pct);

    // Already over-exposed in crisis/bear ⇒ zero room for new buys.
    expect(bear.room).toBe(0);
    expect(crisis.room).toBe(0);

    // Neutral leaves headroom.
    expect(neutral.room).toBeGreaterThan(0);
  });

  it("combined position sizing × stop loss yields a bounded per-trade loss that scales with risk level", () => {
    // Worst-case single-position loss = max_position_pct × effective_stop.
    // This must be strictly ordered by risk level under any single regime,
    // proving sizing + stops move together as the user changes their level.
    const cfg = baseCfg({ stop_loss_pct: 0.10, per_symbol_limit_pct: null });
    for (const regime of ["bull_quiet", "correction", "bear", "crisis"] as const) {
      const worstCase = (l: Level) => {
        const t = tightenForRegime(cfg, l, mkRegime(regime));
        return t.per_symbol_effective_pct * t.stop_loss_effective_pct;
      };
      const c = worstCase("conservative");
      const b = worstCase("balanced");
      const a = worstCase("aggressive");
      expect(c).toBeLessThan(b);
      expect(b).toBeLessThan(a);
      // And every worst-case loss must sit below the user's configured
      // drawdown-halt threshold — a single trade should never blow the
      // halt on its own.
      expect(a).toBeLessThan(cfg.max_drawdown_halt_pct);
    }
  });
});
