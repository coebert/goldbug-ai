// Risk-dial position sizing for backtest replays.
//
// The replay used to hold naive equal weights, which meant a "high risk" and a
// "low risk" comparison were indistinguishable. The live engine sizes every buy
// through the 1..5 dial: a preset supplies the per-symbol cap and the
// volatility target, and `resolveAggressiveness` supplies the size multiplier,
// the buy/sell fill fractions and the drift band. This module reuses exactly
// those primitives so a backtest arm deploys capital the way the AI would.
//
// Pure: no network, no database.

import { riskPresetConfig, riskPresetName } from "@/lib/risk-presets";
import {
  resolveAggressiveness,
  clampDialLevel,
  type Aggressiveness,
} from "@/lib/risk-aggressiveness";

export type RiskSizing = {
  level: number;
  name: string;
  aggressiveness: Aggressiveness;
  /** Hard cap on any single symbol's weight (fraction of equity). */
  perSymbolCap: number;
  /** Scale each leg toward a target daily volatility when the dial asks for it. */
  volatilitySizing: boolean;
  volTargetPct: number;
  /** Gross exposure ceiling — sizing can never lever the book above this. */
  maxGross: number;
};

/** Resolve the sizing knobs the live engine would use at this dial position. */
export function riskSizingFor(level: number): RiskSizing {
  const lvl = clampDialLevel(level);
  const cfg = riskPresetConfig(lvl);
  const a = resolveAggressiveness(cfg, lvl);
  return {
    level: lvl,
    name: riskPresetName(lvl),
    aggressiveness: a,
    perSymbolCap: cfg.per_symbol_limit_pct ?? 0.25,
    volatilitySizing: cfg.volatility_sizing,
    volTargetPct: cfg.vol_target_pct,
    // sizeMult is bounded to 2 upstream; a long-only cash book stays <= 1x.
    maxGross: Math.min(1, 0.6 * a.sizeMult + 0.4),
  };
}

/** Trailing realised daily volatility (stdev of simple returns) over `n` bars. */
export function realisedVol(closes: readonly number[], end: number, n = 20): number | null {
  if (end < n) return null;
  const rets: number[] = [];
  for (let i = end - n + 1; i <= end; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (!a || !b || a <= 0) continue;
    rets.push(b / a - 1);
  }
  if (rets.length < 5) return null;
  const m = rets.reduce((x, y) => x + y, 0) / rets.length;
  const v = rets.reduce((x, y) => x + (y - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v);
}

export type SizingCandidate = { symbol: string; score: number; vol: number | null };

/**
 * Turn the selected candidates into target weights the way the live sizer does:
 * equal risk budget, volatility-scaled when the dial enables it, capped per
 * symbol, multiplied by the dial's size multiplier and clipped to `maxGross`.
 * Whatever is left over stays in cash (it simply earns nothing in the replay).
 */
export function targetWeights(
  candidates: readonly SizingCandidate[],
  s: RiskSizing,
): Map<string, number> {
  const out = new Map<string, number>();
  if (candidates.length === 0) return out;

  const base = 1 / candidates.length;
  const raw = candidates.map((c) => {
    let w = base;
    if (s.volatilitySizing) {
      const vol = c.vol && c.vol > 0 ? c.vol : s.volTargetPct;
      // Target-vol scaling, clamped so a very quiet name cannot dominate.
      w *= Math.max(0.25, Math.min(2, s.volTargetPct / vol));
    }
    return { symbol: c.symbol, w: w * s.aggressiveness.sizeMult };
  });

  let gross = raw.reduce((a, b) => a + b.w, 0);
  // Cap per symbol first, then rescale if the book still breaches max gross.
  const capped = raw.map((r) => ({ symbol: r.symbol, w: Math.min(s.perSymbolCap, r.w) }));
  gross = capped.reduce((a, b) => a + b.w, 0);
  const scale = gross > s.maxGross && gross > 0 ? s.maxGross / gross : 1;
  for (const c of capped) {
    const w = c.w * scale;
    if (w > 1e-6) out.set(c.symbol, Number(w.toFixed(6)));
  }
  return out;
}

/**
 * Move from current weights toward target at the dial's pace: buys fill at
 * `buy`, trims at `sell`, and gaps inside the drift band are ignored so a
 * patient profile does not churn on noise.
 */
export function stepWeights(
  current: ReadonlyMap<string, number>,
  target: ReadonlyMap<string, number>,
  s: RiskSizing,
): Map<string, number> {
  const a = s.aggressiveness;
  const next = new Map<string, number>();
  const keys = new Set([...current.keys(), ...target.keys()]);
  for (const k of keys) {
    const cur = current.get(k) ?? 0;
    const tgt = target.get(k) ?? 0;
    const gap = tgt - cur;
    if (Math.abs(gap) <= a.driftBand) {
      if (cur > 1e-6) next.set(k, cur);
      continue;
    }
    const moved = gap > 0 ? cur + gap * a.buy : cur + gap * Math.min(1, a.sell);
    const w = Math.max(0, Math.min(s.perSymbolCap, moved));
    if (w > 1e-6) next.set(k, Number(w.toFixed(6)));
  }
  return next;
}

export type TailRisk = {
  /** Historical 1-day 95% VaR as a positive % loss of equity. */
  var95Pct: number;
  /** Expected shortfall beyond the 95% VaR, positive % loss. */
  cvar95Pct: number;
  /** Annualised volatility of daily returns, %. */
  volAnnPct: number;
};

/** Historical (non-parametric) 1-day tail risk from a daily return series. */
export function tailRisk(rets: readonly number[]): TailRisk {
  if (rets.length < 10) return { var95Pct: 0, cvar95Pct: 0, volAnnPct: 0 };
  const sorted = [...rets].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(0.05 * sorted.length)));
  const v = sorted[idx] as number;
  const tail = sorted.slice(0, Math.max(1, idx + 1));
  const es = tail.reduce((a, b) => a + b, 0) / tail.length;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
  return {
    var95Pct: Number((Math.max(0, -v) * 100).toFixed(3)),
    cvar95Pct: Number((Math.max(0, -es) * 100).toFixed(3)),
    volAnnPct: Number((Math.sqrt(variance) * Math.sqrt(252) * 100).toFixed(2)),
  };
}
