import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import {
  buildBreakoutTimingReport,
  cohortTiming,
  recommendAgePolicy,
} from "@/lib/breakout-timing";

function trade(over: Partial<SignalTrade>): SignalTrade {
  return {
    symbol: "AAA",
    date: "2025-01-02",
    cohort: "confirmed",
    direction: "up",
    side: "long",
    regime: "bull",
    realisedVol20d: 0.01,
    atrPct: 0.02,
    quality: 0.8,
    penetrationAtr: 0.5,
    volumeRatio: 1.4,
    falseBreakoutRate: 0.2,
    ageBars: 2,
    pendingLatencyBars: 1,
    entry: 100,
    exit: 103,
    exitReason: "target",
    barsHeld: 7,
    returnPct: 1,
    maxAdversePct: -1,
    maxFavourablePct: 3,
    ...over,
  };
}

/** n fresh winners at age 1, n stale losers at age 5. */
function ageSpread(n: number): SignalTrade[] {
  return [
    ...Array.from({ length: n }, (_, i) =>
      trade({ ageBars: 1, pendingLatencyBars: 1, returnPct: 2, barsHeld: 8, date: `2025-01-${String(i + 1).padStart(2, "0")}` }),
    ),
    ...Array.from({ length: n }, (_, i) =>
      trade({ ageBars: 5, pendingLatencyBars: 4, returnPct: -3, barsHeld: 2, exitReason: "stop", date: `2025-02-${String(i + 1).padStart(2, "0")}` }),
    ),
  ];
}

describe("cohortTiming", () => {
  it("buckets by signal age, pending latency and realised hold time", () => {
    const t = cohortTiming("confirmed", ageSpread(20));
    expect(t.overall.trades).toBe(40);
    expect(t.byAge.map((r) => r.label)).toEqual(["0-1", "4-6"]);
    expect(t.byAge[0]!.expectancyPct).toBe(2);
    expect(t.byAge[1]!.expectancyPct).toBe(-3);
    expect(t.byAge[0]!.sharePct).toBe(50);
    expect(t.byPendingLatency.map((r) => r.label)).toEqual(["1", "3-4"]);
    expect(t.byHoldTime.map((r) => r.label)).toEqual(["1-2", "6-10"]);
    expect(t.avgAgeBars).toBe(3);
    expect(t.avgPendingLatencyBars).toBe(2.5);
  });

  it("measures a negative expectancy slope when older signals pay less", () => {
    expect(cohortTiming("confirmed", ageSpread(20)).ageDecayPctPerBar).toBeCloseTo(-1.25, 6);
  });

  it("ignores trades with no pending lead-in for the latency cut", () => {
    const t = cohortTiming("confirmed", [
      trade({ pendingLatencyBars: null }),
      trade({ pendingLatencyBars: 2 }),
    ]);
    expect(t.byPendingLatency).toHaveLength(1);
    expect(t.byPendingLatency[0]!.slice.trades).toBe(1);
    expect(t.avgPendingLatencyBars).toBe(2);
  });
});

describe("recommendAgePolicy", () => {
  const policy = recommendAgePolicy(cohortTiming("confirmed", ageSpread(20)), { minTrades: 15 });

  it("sizes the profitable fresh band and vetoes the loss-making old band", () => {
    const fresh = policy.rules.find((r) => r.minAgeBars === 0)!;
    const late = policy.rules.find((r) => r.minAgeBars === 4)!;
    expect(fresh.veto).toBe(false);
    expect(fresh.mult).toBeGreaterThan(1);
    expect(late.veto).toBe(true);
    expect(late.mult).toBe(0);
    expect(policy.staleAgeBars).toBe(4);
  });

  it("propagates the veto to every older band", () => {
    for (const r of policy.rules.filter((r) => r.minAgeBars >= 4)) {
      expect(r.veto).toBe(true);
      expect(r.mult).toBe(0);
    }
  });

  it("treats thin bands as unproven rather than bad", () => {
    const thin = policy.rules.find((r) => r.minAgeBars === 2)!;
    expect(thin.trades).toBe(0);
    // 2-3 sits before the first vetoed band, so it keeps the unproven cut.
    expect(thin.veto).toBe(false);
    expect(thin.mult).toBeCloseTo(0.7, 6);
  });

  it("reports the decay slope and the best realised hold band", () => {
    expect(policy.notes.some((n) => n.includes("per bar of signal age"))).toBe(true);
    expect(policy.notes.some((n) => n.includes("6-10"))).toBe(true);
  });
});

describe("buildBreakoutTimingReport", () => {
  it("covers every present cohort and recommends only chaseable ones", () => {
    const r = buildBreakoutTimingReport([
      ...ageSpread(20),
      trade({ cohort: "failed", ageBars: 0, returnPct: -1 }),
      trade({ cohort: "pending", ageBars: 1, pendingLatencyBars: null, returnPct: 0.5 }),
    ]);
    expect(r.cohorts.map((c) => c.cohort)).toEqual(["confirmed", "pending", "failed"]);
    expect(r.recommended.map((x) => x.cohort)).toEqual(["confirmed", "pending"]);
    expect(r.notes.some((n) => n.startsWith("confirmed:"))).toBe(true);
  });

  it("is empty-safe", () => {
    expect(buildBreakoutTimingReport([])).toEqual({ cohorts: [], recommended: [], notes: [] });
  });
});
