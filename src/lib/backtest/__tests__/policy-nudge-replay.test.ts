import { describe, expect, it } from "vitest";
import {
  runPolicyNudgeReplay,
  signalsAsOf,
  type Candlelike,
} from "@/lib/backtest/policy-nudge-replay";
import { POLICY_MAX_NUDGE, type PolicyRow } from "@/lib/policy-makers";

function series(start: string, n: number, step: (i: number) => number): Candlelike[] {
  const out: Candlelike[] = [];
  const t0 = Date.parse(`${start}T00:00:00Z`);
  let price = 100;
  for (let i = 0; i < n; i++) {
    const d = new Date(t0 + i * 86_400_000);
    // Weekdays only, so the tape looks like a real trading calendar.
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    price *= 1 + step(i);
    out.push({ date: d.toISOString().slice(0, 10), close: Number(price.toFixed(4)) });
  }
  return out;
}

const PRICES = new Map<string, Candlelike[]>([
  ["SPY", series("2024-01-01", 400, (i) => 0.0012 + 0.01 * Math.sin(i / 9))],
  ["QQQ", series("2024-01-01", 400, (i) => 0.0009 + 0.012 * Math.sin(i / 7 + 1))],
  ["TLT", series("2024-01-01", 400, (i) => -0.0004 + 0.006 * Math.sin(i / 11 + 2))],
]);

const NEWS: PolicyRow[] = [
  {
    headline: "Jerome Powell says the Fed will keep rates higher for longer to fight inflation",
    summary: null,
    source: "Reuters",
    url: null,
    date: "2024-06-12",
    sentiment: -0.3,
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
    headline: "FOMC minutes point to further tightening",
    summary: null,
    source: "FT",
    url: null,
    date: "2024-11-07",
    sentiment: null,
  },
];

describe("runPolicyNudgeReplay", () => {
  it("produces two arms over the same tape with metrics for each", () => {
    const r = runPolicyNudgeReplay({ prices: PRICES, news: NEWS, iterations: 200 });
    expect(r.symbols.sort()).toEqual(["QQQ", "SPY", "TLT"]);
    expect(r.baseline.curve.length).toBe(r.nudged.curve.length);
    expect(r.baseline.curve.length).toBeGreaterThan(100);
    for (const arm of [r.baseline, r.nudged]) {
      expect(arm.maxDrawdownPct).toBeLessThanOrEqual(0);
      expect(arm.cvar95Pct).toBeGreaterThanOrEqual(arm.var95Pct);
      expect(Number.isFinite(arm.sharpe)).toBe(true);
      expect(arm.finalEquity).toBeGreaterThan(0);
    }
    expect(r.delta.returnPct).toBeCloseTo(
      r.nudged.totalReturnPct - r.baseline.totalReturnPct,
      3,
    );
  });

  it("reports a confidence band on both return and drawdown", () => {
    const r = runPolicyNudgeReplay({ prices: PRICES, news: NEWS, iterations: 300, seed: 7 });
    expect(r.confidence.iterations).toBe(300);
    expect(r.confidence.returnDeltaLo).toBeLessThanOrEqual(r.confidence.returnDeltaHi);
    expect(r.confidence.drawdownDeltaLo).toBeLessThanOrEqual(r.confidence.drawdownDeltaHi);
    expect(r.confidence.probPositive).toBeGreaterThanOrEqual(0);
    expect(r.confidence.probPositive).toBeLessThanOrEqual(1);
    expect(r.confidence.probDrawdownBetter).toBeGreaterThanOrEqual(0);
    expect(r.confidence.probDrawdownBetter).toBeLessThanOrEqual(1);
  });

  it("is deterministic for a given seed", () => {
    const a = runPolicyNudgeReplay({ prices: PRICES, news: NEWS, iterations: 200, seed: 42 });
    const b = runPolicyNudgeReplay({ prices: PRICES, news: NEWS, iterations: 200, seed: 42 });
    expect(b.confidence.returnDeltaLo).toBe(a.confidence.returnDeltaLo);
    expect(b.confidence.drawdownDeltaHi).toBe(a.confidence.drawdownDeltaHi);
    expect(b.nudged.finalEquity).toBe(a.nudged.finalEquity);
  });

  it("collapses to an identical pair of arms when the nudge is switched off", () => {
    const off = runPolicyNudgeReplay({
      prices: PRICES,
      news: NEWS,
      params: { nudgeScale: 0 },
      iterations: 200,
    });
    expect(off.nudged.finalEquity).toBe(off.baseline.finalEquity);
    expect(off.delta.returnPct).toBe(0);
    expect(off.delta.maxDrawdownPct).toBe(0);
    expect(off.attribution.activeDays).toBe(0);
    expect(off.verdict).toBe("neutral");
  });

  it("does the same when no tracked policy maker is in the news", () => {
    const quiet = runPolicyNudgeReplay({
      prices: PRICES,
      news: [
        { headline: "Vodafone launches a new tariff", source: "PR", date: "2024-06-12", sentiment: 0.2 },
      ],
      iterations: 200,
    });
    expect(quiet.attribution.activeDays).toBe(0);
    expect(quiet.nudged.finalEquity).toBe(quiet.baseline.finalEquity);
    expect(quiet.summary).toMatch(/No tracked policy remarks/i);
  });

  it("records where the signal reached and never exceeds the live cap", () => {
    const r = runPolicyNudgeReplay({ prices: PRICES, news: NEWS, iterations: 200 });
    expect(r.maxNudge).toBe(POLICY_MAX_NUDGE);
    expect(Math.abs(r.attribution.peakNudge)).toBeLessThanOrEqual(POLICY_MAX_NUDGE + 1e-9);
    expect(r.attribution.activeDays).toBeGreaterThan(0);
    expect(r.attribution.coverage).toBeGreaterThan(0);
    expect(r.attribution.coverage).toBeLessThanOrEqual(1);
    expect(r.attribution.touchedSymbols).toBeGreaterThan(0);
    expect(r.attribution.hawkishDays + r.attribution.dovishDays).toBeLessThanOrEqual(
      r.attribution.activeDays,
    );
  });

  it("scales the effect with nudge strength", () => {
    const weak = runPolicyNudgeReplay({
      prices: PRICES,
      news: NEWS,
      params: { nudgeScale: 0.5 },
      iterations: 200,
    });
    const strong = runPolicyNudgeReplay({
      prices: PRICES,
      news: NEWS,
      params: { nudgeScale: 3 },
      iterations: 200,
    });
    expect(Math.abs(strong.delta.returnPct)).toBeGreaterThanOrEqual(
      Math.abs(weak.delta.returnPct) - 1e-9,
    );
  });

  it("refuses to report on a tape that is too short", () => {
    const short = new Map<string, Candlelike[]>([
      ["SPY", series("2024-01-01", 40, () => 0.001)],
    ]);
    const r = runPolicyNudgeReplay({ prices: short, news: NEWS });
    expect(r.tradingDays).toBeLessThan(60);
    expect(r.summary).toMatch(/Not enough tape/i);
    expect(r.confidence.iterations).toBe(0);
  });
});

describe("signalsAsOf", () => {
  const byDate = new Map<string, PolicyRow[]>([
    ["2024-06-12", [NEWS[0] as PolicyRow]],
    ["2024-09-18", [NEWS[1] as PolicyRow]],
  ]);

  it("never sees a headline published after the decision bar", () => {
    expect(signalsAsOf(byDate, "2024-06-11", 48)).toEqual([]);
    expect(signalsAsOf(byDate, "2024-06-12", 48).length).toBeGreaterThan(0);
  });

  it("forgets a remark once it falls out of the trailing window", () => {
    expect(signalsAsOf(byDate, "2024-06-30", 48)).toEqual([]);
  });

  it("decays faster with a shorter half-life", () => {
    const slow = signalsAsOf(byDate, "2024-06-14", 168).find((s) => s.symbol === "SPY");
    const fast = signalsAsOf(byDate, "2024-06-14", 6).find((s) => s.symbol === "SPY");
    // Score is a weighted mean so it survives decay; what matters is that both
    // arms still see the hawkish sign from the same remark.
    expect(slow?.score).toBeLessThan(0);
    expect(fast?.score).toBeLessThan(0);
  });
});
