import { describe, expect, it } from "vitest";
import {
  riskSizingFor,
  realisedVol,
  targetWeights,
  stepWeights,
  tailRisk,
} from "../replay-risk-sizing";
import { runNudgeReplay, type Candlelike } from "../insider-nudge-replay";

const cands = (syms: string[]) => syms.map((s) => ({ symbol: s, score: 0.8, vol: 0.01 }));

describe("riskSizingFor", () => {
  it("mirrors the live dial presets", () => {
    expect(riskSizingFor(1).name).toBe("Low risk");
    expect(riskSizingFor(5).name).toBe("High risk");
    expect(riskSizingFor(1).perSymbolCap).toBeLessThan(riskSizingFor(5).perSymbolCap);
    expect(riskSizingFor(1).aggressiveness.sizeMult).toBeLessThan(
      riskSizingFor(5).aggressiveness.sizeMult,
    );
  });

  it("clamps out-of-range dial values to balanced bounds", () => {
    expect(riskSizingFor(0).level).toBe(1);
    expect(riskSizingFor(99).level).toBe(5);
  });
});

describe("targetWeights", () => {
  it("never breaches the per-symbol cap or the gross ceiling", () => {
    for (const lvl of [1, 2, 3, 4, 5]) {
      const s = riskSizingFor(lvl);
      const w = targetWeights(cands(["A", "B"]), s);
      let gross = 0;
      for (const v of w.values()) {
        expect(v).toBeLessThanOrEqual(s.perSymbolCap + 1e-9);
        gross += v;
      }
      expect(gross).toBeLessThanOrEqual(s.maxGross + 1e-9);
    }
  });

  it("gives a quiet name more weight than a volatile one under vol targeting", () => {
    const s = riskSizingFor(3);
    expect(s.volatilitySizing).toBe(true);
    const w = targetWeights(
      [
        { symbol: "CALM", score: 0.8, vol: 0.005 },
        { symbol: "WILD", score: 0.8, vol: 0.05 },
      ],
      s,
    );
    expect(w.get("CALM") as number).toBeGreaterThan(w.get("WILD") as number);
  });

  it("returns nothing when there are no candidates", () => {
    expect(targetWeights([], riskSizingFor(3)).size).toBe(0);
  });
});

describe("stepWeights", () => {
  it("fills buys partially at the dial's buy aggressiveness", () => {
    const s = riskSizingFor(1);
    const next = stepWeights(new Map(), new Map([["A", 0.05]]), s);
    expect(next.get("A") as number).toBeCloseTo(0.05 * s.aggressiveness.buy, 6);
  });

  it("ignores gaps inside the drift band", () => {
    const s = riskSizingFor(3);
    const cur = new Map([["A", 0.1]]);
    const next = stepWeights(cur, new Map([["A", 0.1 + s.aggressiveness.driftBand / 2]]), s);
    expect(next.get("A")).toBe(0.1);
  });

  it("never produces a negative weight when exiting", () => {
    const s = riskSizingFor(5);
    const next = stepWeights(new Map([["A", 0.1]]), new Map(), s);
    expect((next.get("A") ?? 0) >= 0).toBe(true);
  });
});

describe("tailRisk", () => {
  it("reports a positive loss figure and CVaR at least as bad as VaR", () => {
    const rets = Array.from({ length: 260 }, (_, i) => Math.sin(i) * 0.01 - 0.0005);
    const t = tailRisk(rets);
    expect(t.var95Pct).toBeGreaterThan(0);
    expect(t.cvar95Pct).toBeGreaterThanOrEqual(t.var95Pct - 1e-9);
    expect(t.volAnnPct).toBeGreaterThan(0);
  });

  it("is zeroed for a too-short series", () => {
    expect(tailRisk([0.01, -0.01]).var95Pct).toBe(0);
  });
});

describe("realisedVol", () => {
  it("is null before the window is filled and positive after", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 * (1 + 0.01 * Math.sin(i)));
    expect(realisedVol(closes, 5, 20)).toBeNull();
    expect(realisedVol(closes, 30, 20) as number).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------- engine integration

function tape(seed: number): Candlelike[] {
  const out: Candlelike[] = [];
  let px = 100;
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < 300; i++) {
    px *= 1 + Math.sin((i + seed) / 9) * 0.012 + 0.0004;
    out.push({ date: new Date(start + i * 86_400_000).toISOString().slice(0, 10), close: Number(px.toFixed(4)) });
  }
  return out;
}

describe("runNudgeReplay risk-level integration", () => {
  const prices = new Map([
    ["AAA", tape(0)],
    ["BBB", tape(3)],
    ["CCC", tape(7)],
  ]);

  it("reports the resolved dial and VaR metrics for both arms", () => {
    const r = runNudgeReplay({ prices, events: [], params: { riskLevel: 4 } });
    expect(r.sizing.level).toBe(4);
    expect(r.sizing.name).toBe("Growth");
    expect(r.baseline.var95Pct).toBeGreaterThanOrEqual(0);
    expect(r.nudged.cvar95Pct).toBeGreaterThanOrEqual(0);
    expect(r.delta).toHaveProperty("var95Pct");
  });

  it("deploys less capital and risks less at a lower dial", () => {
    const low = runNudgeReplay({ prices, events: [], params: { riskLevel: 1 } });
    const high = runNudgeReplay({ prices, events: [], params: { riskLevel: 5 } });
    expect(low.baseline.avgGross).toBeLessThan(high.baseline.avgGross);
    expect(low.baseline.var95Pct).toBeLessThanOrEqual(high.baseline.var95Pct);
    expect(Math.abs(low.baseline.maxDrawdownPct)).toBeLessThanOrEqual(
      Math.abs(high.baseline.maxDrawdownPct) + 1e-9,
    );
  });

  it("still reproduces the baseline exactly when the nudge is switched off", () => {
    const r = runNudgeReplay({ prices, events: [], params: { riskLevel: 2, nudgeScale: 0 } });
    expect(r.nudged.finalEquity).toBe(r.baseline.finalEquity);
    expect(r.delta.var95Pct).toBe(0);
  });
});
