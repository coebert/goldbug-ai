import { describe, it, expect } from "vitest";
import {
  detectAlgoRegime,
  detectVolBurst,
  detectLiquidityVacuum,
  detectWhipsaw,
  detectCorrelationSpike,
  detectGapFade,
  DEFAULT_ALGO_REGIME_CONFIG,
} from "@/lib/microstructure/algo-regime";

const cfg = DEFAULT_ALGO_REGIME_CONFIG;

function calmCloses(n = 60, start = 100): number[] {
  // gentle upward drift with tiny jitter — low vol, few sign flips
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + 0.0005 + (i % 7 === 0 ? -0.0002 : 0.0001)));
  return out;
}

describe("algo-regime detectors", () => {
  it("volBurst fires when short-window vol >> long-window vol", () => {
    const closes = calmCloses(40);
    // inject a large burst in the last 5 bars
    for (let i = 0; i < 5; i++) closes.push(closes.at(-1)! * (i % 2 ? 1.08 : 0.92));
    expect(detectVolBurst(closes, cfg)).toBe(true);
  });

  it("volBurst is quiet in a calm tape", () => {
    expect(detectVolBurst(calmCloses(60), cfg)).toBe(false);
  });

  it("liquidityVacuum flags collapsed volume", () => {
    const vols = Array.from({ length: 25 }, () => 1_000_000);
    vols.push(50_000);
    expect(detectLiquidityVacuum(vols, cfg)).toBe(true);
  });

  it("whipsaw counts sign flips in short returns", () => {
    const closes = [100];
    for (let i = 0; i < 40; i++) closes.push(closes.at(-1)! * (i % 2 ? 1.01 : 0.99));
    expect(detectWhipsaw(closes, cfg)).toBe(true);
  });

  it("correlationSpike triggers when top holdings move together", () => {
    const base = Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.02 : -0.02));
    const xs = { A: base, B: base.map((x) => x * 0.98), C: base.map((x) => x * 1.02) };
    expect(detectCorrelationSpike(xs, cfg)).toBe(true);
  });

  it("gapFade needs both a big gap and a big retrace", () => {
    const closes = calmCloses(60);
    // typical stdev ~0.001 → threshold ~0.15%
    expect(detectGapFade(2.0, -1.5, closes, cfg)).toBe(true);
    expect(detectGapFade(2.0, -0.1, closes, cfg)).toBe(false);
    expect(detectGapFade(undefined, undefined, closes, cfg)).toBe(false);
  });
});

describe("detectAlgoRegime tiering", () => {
  it("returns tier=normal with no signals", () => {
    const snap = detectAlgoRegime({ primary: { closes: calmCloses(60) } });
    expect(snap.tier).toBe("normal");
    expect(snap.score).toBe(0);
    expect(snap.multipliers.blockNewBuys).toBe(false);
    expect(snap.multipliers.sizeScale).toBe(1);
  });

  it("escalates to extreme when 3+ signals fire and blocks new buys", () => {
    const closes = calmCloses(40);
    // burst
    for (let i = 0; i < 5; i++) closes.push(closes.at(-1)! * (i % 2 ? 1.08 : 0.92));
    // volumes with a vacuum on the last bar
    const vols = Array.from({ length: 44 }, () => 1_000_000);
    vols.push(50_000);
    const xs = {
      A: Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.02 : -0.02)),
      B: Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.019 : -0.021)),
    };
    const snap = detectAlgoRegime({
      primary: { closes, volumes: vols },
      crossSection: xs,
      overnightGapPct: 2.0,
      openingFadePct: -1.5,
    });
    expect(snap.score).toBeGreaterThanOrEqual(3);
    expect(snap.tier).toBe("extreme");
    expect(snap.multipliers.blockNewBuys).toBe(true);
    expect(snap.multipliers.maxParticipation).toBeLessThanOrEqual(0.02);
    expect(snap.multipliers.sizeScale).toBeLessThan(1);
    expect(snap.multipliers.tailHedgeBoostPctNav).toBeGreaterThan(0);
  });
});
