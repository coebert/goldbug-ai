import { describe, expect, it } from "vitest";
import { runPolicyNudgeReplay, type Candlelike } from "@/lib/backtest/policy-nudge-replay";
import { POLICY_SCALE_MAX, POLICY_SCALE_MIN } from "@/lib/policy-regime-scaling";
import type { PolicyRow } from "@/lib/policy-makers";

function series(start: string, n: number, step: (i: number) => number): Candlelike[] {
  const out: Candlelike[] = [];
  const t0 = Date.parse(`${start}T00:00:00Z`);
  let price = 100;
  for (let i = 0; i < n; i++) {
    const d = new Date(t0 + i * 86_400_000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    price *= 1 + step(i);
    out.push({ date: d.toISOString().slice(0, 10), close: Number(price.toFixed(4)) });
  }
  return out;
}

const PRICES = new Map<string, Candlelike[]>([
  ["SPY", series("2024-01-01", 420, (i) => 0.0011 + 0.013 * Math.sin(i / 8))],
  ["QQQ", series("2024-01-01", 420, (i) => 0.0008 + 0.016 * Math.sin(i / 6 + 1))],
  ["TLT", series("2024-01-01", 420, (i) => -0.0003 + 0.007 * Math.sin(i / 12 + 2))],
]);

const NEWS: PolicyRow[] = [
  {
    headline: "Jerome Powell says the Fed will keep rates higher for longer to fight inflation",
    summary: null,
    source: "Reuters",
    url: null,
    date: "2024-05-14",
    sentiment: -0.35,
  },
  {
    headline: "Powell signals a rate cut is coming as disinflation continues",
    summary: null,
    source: "Bloomberg",
    url: null,
    date: "2024-09-18",
    sentiment: 0.4,
  },
  {
    headline: "Andrew Bailey warns policy must stay restrictive for now",
    summary: null,
    source: "FT",
    url: null,
    date: "2025-01-21",
    sentiment: -0.2,
  },
];

const run = (over: Partial<Parameters<typeof runPolicyNudgeReplay>[0]> = {}) =>
  runPolicyNudgeReplay({ prices: PRICES, news: NEWS, iterations: 200, ...over });

describe("policy-nudge replay: regime-aware arm", () => {
  it("returns a third arm aligned with the other two", () => {
    const r = run();
    expect(r.regime.curve.length).toBe(r.baseline.curve.length);
    expect(r.regime.label).not.toBe(r.nudged.label);
    expect(r.regime.finalEquity).toBeGreaterThan(0);
    expect(r.regime.maxDrawdownPct).toBeLessThanOrEqual(0);
    expect(r.regime.cvar95Pct).toBeGreaterThanOrEqual(r.regime.var95Pct);
  });

  it("reports regime deltas consistent with the arm metrics", () => {
    const r = run();
    expect(r.regimeVsFixed.delta.returnPct).toBeCloseTo(
      r.regime.totalReturnPct - r.nudged.totalReturnPct,
      3,
    );
    expect(r.regimeVsBaseline.delta.returnPct).toBeCloseTo(
      r.regime.totalReturnPct - r.baseline.totalReturnPct,
      3,
    );
    // Drawdown deltas are "positive = shallower".
    expect(r.regimeVsFixed.delta.maxDrawdownPct).toBeCloseTo(
      r.regime.maxDrawdownPct - r.nudged.maxDrawdownPct,
      3,
    );
  });

  it("keeps confidence bands ordered and probabilities in range", () => {
    const r = run();
    for (const c of [r.regimeVsFixed.confidence, r.regimeVsBaseline.confidence]) {
      expect(c.returnDeltaLo).toBeLessThanOrEqual(c.returnDeltaHi);
      expect(c.drawdownDeltaLo).toBeLessThanOrEqual(c.drawdownDeltaHi);
      expect(c.probPositive).toBeGreaterThanOrEqual(0);
      expect(c.probPositive).toBeLessThanOrEqual(1);
      expect(c.probDrawdownBetter).toBeGreaterThanOrEqual(0);
      expect(c.probDrawdownBetter).toBeLessThanOrEqual(1);
    }
  });

  it("keeps every applied scale inside the documented bounds", () => {
    const a = run().regimeAttribution;
    expect(a.scaledDays).toBeGreaterThan(0);
    expect(a.minScale).toBeGreaterThanOrEqual(POLICY_SCALE_MIN);
    expect(a.maxScale).toBeLessThanOrEqual(POLICY_SCALE_MAX);
    expect(a.avgScale).toBeGreaterThanOrEqual(a.minScale);
    expect(a.avgScale).toBeLessThanOrEqual(a.maxScale);
    const postures = Object.values(a.postureDays).reduce((s, n) => s + n, 0);
    const vols = Object.values(a.volDays).reduce((s, n) => s + n, 0);
    expect(postures).toBeGreaterThan(0);
    expect(vols).toBe(postures);
  });

  it("collapses the regime arm onto the baseline when the nudge is switched off", () => {
    const r = run({ params: { nudgeScale: 0 } });
    expect(r.regime.finalEquity).toBeCloseTo(r.baseline.finalEquity, 6);
    expect(r.regimeVsFixed.delta.returnPct).toBeCloseTo(0, 6);
    expect(r.regimeVerdict).toBe("inactive");
  });

  it("is deterministic across repeated runs", () => {
    const a = run();
    const b = run();
    expect(b.regime.finalEquity).toBe(a.regime.finalEquity);
    expect(b.regimeVsFixed.confidence).toEqual(a.regimeVsFixed.confidence);
    expect(b.regimeVerdict).toBe(a.regimeVerdict);
    expect(b.summary).toBe(a.summary);
  });

  it("mentions the regime comparison in the summary", () => {
    expect(run().summary.toLowerCase()).toContain("regime");
  });
});
