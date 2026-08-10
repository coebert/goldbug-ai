import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import { mixTimeline, periodKey } from "@/lib/breakout-mix-timeline";

let seq = 0;
const trade = (over: Partial<SignalTrade> = {}): SignalTrade => {
  seq += 1;
  return {
    symbol: "AAA",
    date: "2025-01-05",
    cohort: "confirmed",
    direction: "up",
    side: "long",
    regime: "bull",
    realisedVol20d: 0.01,
    atrPct: 0.02,
    quality: 0.7,
    penetrationAtr: 0.5,
    volumeRatio: 1.4,
    falseBreakoutRate: 0.2,
    ageBars: 1,
    pendingLatencyBars: 1,
    entry: 100,
    exit: 102,
    exitReason: "target",
    barsHeld: 4,
    returnPct: 2,
    maxAdversePct: -1,
    maxFavourablePct: 3,
    ...over,
  };
};

/** Three months of signals on two names, with the sign flipping in March. */
function sample(): SignalTrade[] {
  const out: SignalTrade[] = [];
  const months = ["01", "02", "03"];
  for (const m of months) {
    const flip = m === "03" ? -1 : 1;
    for (let i = 0; i < 6; i++) {
      out.push(trade({ symbol: "AAA", date: `2025-${m}-1${i}`, returnPct: 3 * flip }));
      out.push(trade({ symbol: "BBB", date: `2025-${m}-1${i}`, returnPct: -3 * flip }));
      out.push(
        trade({ symbol: "AAA", date: `2025-${m}-2${i}`, cohort: "failed", returnPct: -1 }),
      );
      out.push(
        trade({ symbol: "BBB", date: `2025-${m}-2${i}`, cohort: "failed", returnPct: 1 }),
      );
    }
  }
  return out;
}

const setting = { risk: "balanced", gapWeight: 2 } as const;

describe("periodKey", () => {
  it("buckets by month and quarter", () => {
    expect(periodKey("2025-04-17", "month")).toBe("2025-04");
    expect(periodKey("2025-04-17", "quarter")).toBe("2025-Q2");
    expect(periodKey("2025-12-31", "quarter")).toBe("2025-Q4");
    expect(periodKey("2025-01-01", "quarter")).toBe("2025-Q1");
  });
});

describe("mixTimeline", () => {
  it("emits one chronological point per bucket with stance shares that sum to 100", () => {
    const tl = mixTimeline(sample(), setting, { minConfirmed: 1 });
    expect(tl.points.map((p) => p.period)).toEqual(["2025-01", "2025-02", "2025-03"]);
    for (const p of tl.points) {
      expect(p.ranked).toBeGreaterThan(0);
      expect(p.buy + p.hold + p.sell).toBe(p.ranked);
      expect(p.buyPct + p.holdPct + p.sellPct).toBeCloseTo(100, 6);
    }
  });

  it("accumulates trades in expanding mode and caps them when rolling", () => {
    const expanding = mixTimeline(sample(), setting, { minConfirmed: 1 });
    const rolling = mixTimeline(sample(), setting, {
      minConfirmed: 1,
      window: "rolling",
      rollingBuckets: 1,
    });
    expect(expanding.points.map((p) => p.windowTrades)).toEqual([24, 48, 72]);
    expect(rolling.points.map((p) => p.windowTrades)).toEqual([24, 24, 24]);
    expect(rolling.points.every((p) => p.windowTrades === p.bucketTrades)).toBe(true);
  });

  it("reports the first-to-last stance shift in percentage points", () => {
    const tl = mixTimeline(sample(), setting, { minConfirmed: 1, window: "rolling", rollingBuckets: 1 });
    const first = tl.points[0]!;
    const last = tl.points[tl.points.length - 1]!;
    expect(tl.shift.buy).toBeCloseTo(last.buyPct - first.buyPct, 6);
    expect(tl.shift.hold).toBeCloseTo(last.holdPct - first.holdPct, 6);
    expect(tl.shift.sell).toBeCloseTo(last.sellPct - first.sellPct, 6);
    expect(tl.summary).toContain("stand aside");
  });

  it("quarter bucketing collapses the sample into one point", () => {
    const tl = mixTimeline(sample(), setting, { minConfirmed: 1, bucket: "quarter" });
    expect(tl.points).toHaveLength(1);
    expect(tl.points[0]!.period).toBe("2025-Q1");
    expect(tl.points[0]!.windowTrades).toBe(72);
  });

  it("is a no-op on an empty sample", () => {
    const tl = mixTimeline([], setting);
    expect(tl.points).toEqual([]);
    expect(tl.summary).toMatch(/Not enough signals/);
  });

  it("is order-independent — unsorted trades give the same series", () => {
    const trades = sample();
    const shuffled = [...trades].reverse();
    expect(mixTimeline(shuffled, setting, { minConfirmed: 1 }).points.map((p) => p.buyPct)).toEqual(
      mixTimeline(trades, setting, { minConfirmed: 1 }).points.map((p) => p.buyPct),
    );
  });
});
