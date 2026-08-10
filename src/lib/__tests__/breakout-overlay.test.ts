import { describe, expect, it } from "vitest";
import {
  buildBreakoutOverlay,
  overlayDomain,
  windowOverlay,
  DEFAULT_BREAKOUT_OVERLAY_CONFIG,
} from "@/lib/breakout-overlay";
import type { BacktestBar } from "@/lib/breakout-backtest";
import { DEFAULT_BREAKOUT_CONFIG } from "@/lib/alpha/breakout";

function day(i: number): string {
  const d = new Date(Date.UTC(2024, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}

/** Flat range then a decisive, high-volume break upward. */
function rangeThenBreakout(baseBars = 120, breakBars = 12): BacktestBar[] {
  const bars: BacktestBar[] = [];
  for (let i = 0; i < baseBars; i++) {
    const c = 100 + (i % 5) * 0.4;
    bars.push({ date: day(i), high: c + 0.5, low: c - 0.5, close: c, volume: 1_000_000 });
  }
  for (let i = 0; i < breakBars; i++) {
    const c = 104 + i * 1.5;
    bars.push({
      date: day(baseBars + i),
      high: c + 1,
      low: c - 0.6,
      close: c,
      volume: 3_000_000,
    });
  }
  return bars;
}

describe("buildBreakoutOverlay — channel band", () => {
  it("emits one point per clean bar, in date order", () => {
    const bars = rangeThenBreakout();
    const o = buildBreakoutOverlay("TEST", bars);
    expect(o.points).toHaveLength(bars.length);
    expect(o.points.map((p) => p.date)).toEqual(bars.map((b) => b.date));
  });

  it("drops non-finite and non-positive bars", () => {
    const bars = rangeThenBreakout();
    const dirty = [
      ...bars,
      { date: day(999), high: NaN, low: 1, close: 2, volume: 1 },
      { date: day(1000), high: 5, low: 4, close: 0, volume: 1 },
    ];
    const o = buildBreakoutOverlay("TEST", dirty);
    expect(o.points).toHaveLength(bars.length);
  });

  it("sorts unsorted input before drawing", () => {
    const bars = rangeThenBreakout(40, 0);
    const shuffled = [...bars].reverse();
    const o = buildBreakoutOverlay("TEST", shuffled);
    const dates = o.points.map((p) => p.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("leaves the channel null until a full lookback exists", () => {
    const o = buildBreakoutOverlay("TEST", rangeThenBreakout());
    const n = DEFAULT_BREAKOUT_CONFIG.channelBars;
    expect(o.points[n - 1]!.channelHigh).toBeNull();
    expect(o.points[n]!.channelHigh).not.toBeNull();
  });

  it("excludes the current bar from its own channel, so a break is drawable", () => {
    const bars = rangeThenBreakout();
    const o = buildBreakoutOverlay("TEST", bars);
    const breakIdx = 120;
    const p = o.points[breakIdx]!;
    // The channel is the pre-break range; the close sits above it.
    expect(p.channelHigh).not.toBeNull();
    expect(p.close).toBeGreaterThan(p.channelHigh!);
  });

  it("derives bandBase/bandSpan as a stacked-area decomposition of the range", () => {
    const o = buildBreakoutOverlay("TEST", rangeThenBreakout());
    for (const p of o.points) {
      if (p.channelHigh == null || p.channelLow == null) {
        expect(p.bandBase).toBeNull();
        expect(p.bandSpan).toBeNull();
        continue;
      }
      expect(p.bandBase).toBe(p.channelLow);
      expect(p.bandBase! + p.bandSpan!).toBeCloseTo(p.channelHigh, 8);
      expect(p.bandSpan!).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("buildBreakoutOverlay — signals", () => {
  it("marks the breakout with the level, direction and side", () => {
    const o = buildBreakoutOverlay("TEST", rangeThenBreakout());
    expect(o.signals.length).toBeGreaterThan(0);
    const up = o.signals.find((s) => s.direction === "up");
    expect(up).toBeDefined();
    expect(up!.level).toBeGreaterThan(0);
    expect(up!.entry).toBeGreaterThan(up!.level);
    expect(up!.side).toBe("long");
  });

  it("places the stop below and the target above a long entry", () => {
    const o = buildBreakoutOverlay("TEST", rangeThenBreakout());
    const s = o.signals.find((x) => x.side === "long")!;
    expect(s.stop).toBeLessThan(s.entry);
    expect(s.target).toBeGreaterThan(s.entry);
    expect(s.entry - s.stop!).toBeCloseTo(2 * s.atr, 6);
    expect(s.target! - s.entry).toBeCloseTo(3 * s.atr, 6);
  });

  it("honours stopAtr/targetAtr = 0 by omitting those rules", () => {
    const o = buildBreakoutOverlay("TEST", rangeThenBreakout(), { stopAtr: 0, targetAtr: 0 });
    for (const s of o.signals) {
      expect(s.stop).toBeNull();
      expect(s.target).toBeNull();
    }
  });

  it("sets the planned exit exactly horizonBars after the signal", () => {
    for (const horizonBars of [5, 10, 20]) {
      const o = buildBreakoutOverlay("TEST", rangeThenBreakout(200, 60), { horizonBars });
      for (const s of o.signals) {
        expect(s.plannedExitIndex - s.index).toBe(horizonBars);
        if (s.plannedExitDate) {
          expect(o.points[s.plannedExitIndex]!.date).toBe(s.plannedExitDate);
        }
      }
    }
  });

  it("returns a null planned-exit date when the horizon runs past the data", () => {
    const bars = rangeThenBreakout(120, 3);
    const o = buildBreakoutOverlay("TEST", bars, { horizonBars: 20 });
    const openEnded = o.signals.filter((s) => s.plannedExitIndex >= o.points.length);
    for (const s of openEnded) expect(s.plannedExitDate).toBeNull();
  });

  it("never resolves an exit later than the planned horizon", () => {
    const o = buildBreakoutOverlay("TEST", rangeThenBreakout(200, 60), { horizonBars: 10 });
    for (const s of o.signals) {
      expect(s.exitIndex).toBeLessThanOrEqual(s.plannedExitIndex);
      expect(s.barsHeld).toBeLessThanOrEqual(10);
    }
  });

  it("treats a failed breakout as a reversal trade", () => {
    // Break out, then slam back inside the range.
    const bars = rangeThenBreakout(120, 2);
    for (let i = 0; i < 6; i++) {
      bars.push({ date: day(122 + i), high: 101, low: 99, close: 99.5, volume: 2_000_000 });
    }
    const o = buildBreakoutOverlay("TEST", bars);
    const failed = o.signals.filter((s) => s.cohort === "failed");
    for (const s of failed) {
      expect(s.side).toBe(s.direction === "up" ? "short" : "long");
    }
  });

  it("does not emit the same cohort twice inside one episode", () => {
    const o = buildBreakoutOverlay("TEST", rangeThenBreakout(200, 40));
    const byDate = new Map<string, Set<string>>();
    for (const s of o.signals) {
      const set = byDate.get(s.date) ?? new Set<string>();
      expect(set.has(s.cohort)).toBe(false);
      set.add(s.cohort);
      byDate.set(s.date, set);
    }
    // Cohort repeats must respect the cooldown.
    const confirmed = o.signals.filter((s) => s.cohort === "confirmed").map((s) => s.index);
    for (let i = 1; i < confirmed.length; i++) {
      expect(confirmed[i]! - confirmed[i - 1]!).toBeGreaterThanOrEqual(
        DEFAULT_BREAKOUT_OVERLAY_CONFIG.cooldownBars,
      );
    }
  });

  it("keeps signal indexes addressable in the points array", () => {
    const o = buildBreakoutOverlay("TEST", rangeThenBreakout(200, 40));
    for (const s of o.signals) {
      expect(o.points[s.index]!.date).toBe(s.date);
      expect(o.points[s.index]!.close).toBeCloseTo(s.entry, 8);
    }
  });

  it("exposes the latest signal for pre-selection", () => {
    const o = buildBreakoutOverlay("TEST", rangeThenBreakout(200, 40));
    expect(o.latest).toEqual(o.signals.at(-1) ?? null);
  });

  it("returns no signals (but still a band) when history is too short", () => {
    const bars = rangeThenBreakout(70, 5);
    const o = buildBreakoutOverlay("TEST", bars);
    expect(o.signals).toHaveLength(0);
    expect(o.latest).toBeNull();
    expect(o.points.some((p) => p.channelHigh != null)).toBe(true);
  });
});

describe("windowOverlay", () => {
  it("is a no-op when the series is already short enough", () => {
    const o = buildBreakoutOverlay("TEST", rangeThenBreakout(200, 40));
    expect(windowOverlay(o, o.points.length + 10)).toBe(o);
  });

  it("rebases signal indexes so they still point at the right bar", () => {
    const o = buildBreakoutOverlay("TEST", rangeThenBreakout(200, 60));
    const w = windowOverlay(o, 100);
    expect(w.points).toHaveLength(100);
    for (const s of w.signals) {
      expect(w.points[s.index]!.date).toBe(s.date);
      expect(s.plannedExitIndex - s.index).toBe(o.config.horizonBars);
    }
  });

  it("drops signals that fell outside the window", () => {
    const o = buildBreakoutOverlay("TEST", rangeThenBreakout(200, 60));
    const w = windowOverlay(o, 40);
    const firstVisible = w.points[0]!.date;
    for (const s of w.signals) expect(s.date >= firstVisible).toBe(true);
    expect(w.signals.length).toBeLessThanOrEqual(o.signals.length);
  });
});

describe("overlayDomain", () => {
  it("contains every drawn price, band edge, stop and target", () => {
    const o = buildBreakoutOverlay("TEST", rangeThenBreakout(200, 40));
    const s = o.signals.at(-1)!;
    const [lo, hi] = overlayDomain(o, s);
    for (const p of o.points) {
      expect(p.low).toBeGreaterThanOrEqual(lo);
      expect(p.high).toBeLessThanOrEqual(hi);
    }
    expect(s.stop!).toBeGreaterThanOrEqual(lo);
    expect(s.target!).toBeLessThanOrEqual(hi);
    expect(s.level).toBeGreaterThanOrEqual(lo);
  });

  it("still pads a flat series instead of collapsing to a zero-height axis", () => {
    const flat: BacktestBar[] = Array.from({ length: 80 }, (_, i) => ({
      date: day(i),
      high: 50,
      low: 50,
      close: 50,
      volume: 1000,
    }));
    const o = buildBreakoutOverlay("FLAT", flat);
    const [lo, hi] = overlayDomain(o, null);
    expect(hi).toBeGreaterThan(lo);
  });
});
