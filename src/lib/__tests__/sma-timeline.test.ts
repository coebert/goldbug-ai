import { describe, it, expect } from "vitest";
import { buildSmaSymbolReport, type SmaBarInput } from "@/lib/sma-timeline";
import { DEFAULT_SMA_CROSS_RULES } from "@/lib/alpha/sma-cross-rules";

/** Deterministic series: a long downtrend, then a long uptrend. */
function vShape(days: number): SmaBarInput[] {
  const out: SmaBarInput[] = [];
  const start = Date.UTC(2020, 0, 1);
  for (let i = 0; i < days; i++) {
    const date = new Date(start + i * 86400000).toISOString().slice(0, 10);
    const half = days / 2;
    const close = i < half ? 200 - i * 0.5 : 200 - half * 0.5 + (i - half) * 0.7;
    out.push({ date, close });
  }
  return out;
}

const dateAt = (bars: SmaBarInput[], i: number) => bars[i]!.date;

describe("buildSmaSymbolReport", () => {
  it("returns an empty but well-formed report with no data", () => {
    const r = buildSmaSymbolReport("AAPL", []);
    expect(r.bars).toEqual([]);
    expect(r.crosses).toEqual([]);
    expect(r.summary.barCount).toBe(0);
    expect(r.summary.currentRegime).toBe("unknown");
    expect(r.summary.quality).toBe("insufficient");
  });

  it("computes SMA20/50/200 only once enough history exists", () => {
    const bars = vShape(400);
    const r = buildSmaSymbolReport("AAPL", bars);
    expect(r.bars[18]!.sma20).toBeNull();
    expect(r.bars[19]!.sma20).toBeCloseTo(
      bars.slice(0, 20).reduce((a, b) => a + Number(b.close), 0) / 20,
      9,
    );
    expect(r.bars[198]!.sma200).toBeNull();
    expect(r.bars[199]!.sma200).not.toBeNull();
    expect(r.summary.quality).toBe("full");
  });

  it("finds the SMA20/50 bull cross on the turn and marks it confirmed", () => {
    const r = buildSmaSymbolReport("AAPL", vShape(400));
    const fast = r.crosses.filter((c) => c.kind === "fast");
    expect(fast.length).toBeGreaterThan(0);
    const bull = fast.find((c) => c.direction === "bull")!;
    expect(bull.whipsaw).toBe(false);
    expect(bull.confirmedDate).not.toBeNull();
    // The V bottoms at bar 200; the fast cross follows it, not precedes it.
    expect(bull.barIndex).toBeGreaterThan(200);
    expect(bull.forwardReturnPct!).toBeGreaterThan(0);
  });

  it("tracks the golden/death regime as contiguous segments covering every bar", () => {
    const r = buildSmaSymbolReport("AAPL", vShape(500));
    expect(r.regimes[0]!.regime).toBe("unknown"); // pre-SMA200 warm-up
    expect(r.regimes.reduce((a, s) => a + s.bars, 0)).toBe(r.summary.barCount);
    for (let i = 1; i < r.regimes.length; i++) {
      expect(r.regimes[i]!.regime).not.toBe(r.regimes[i - 1]!.regime);
      expect(r.regimes[i]!.startDate > r.regimes[i - 1]!.endDate).toBe(true);
    }
    expect(r.regimes.some((s) => s.regime === "death")).toBe(true);
    expect(r.summary.currentRegime).toBe("golden");
    expect(r.summary.goldenCrosses).toBeGreaterThanOrEqual(1);
  });

  it("annotates each decision with the trend state at the time", () => {
    const bars = vShape(500);
    const r = buildSmaSymbolReport("AAPL", bars, [
      { date: dateAt(bars, 240), side: "buy", quantity: 10, price: 125, value: 1250, reason: "dip" },
      { date: dateAt(bars, 400), side: "buy", quantity: 10, price: 200, value: 2000 },
      { date: dateAt(bars, 450), side: "sell", quantity: 5, price: 230, value: 1150 },
    ]);
    const [dip, late, sell] = r.decisions;
    expect(dip!.regime).toBe("death");
    expect(dip!.alignment).toBe("against_trend");
    expect(dip!.note).toContain("death regime");
    expect(late!.regime).toBe("golden");
    expect(late!.lastFastCross).toBe("bull");
    expect(late!.alignment).toBe("with_trend");
    expect(sell!.alignment).toBe("against_trend"); // selling into an uptrend
    expect(r.summary.buys).toBe(2);
    expect(r.summary.sells).toBe(1);
    expect(r.summary.withTrendPct).toBeCloseTo(1 / 3, 9);
  });

  it("rolls trades into the regime segment that contains them", () => {
    const bars = vShape(500);
    const r = buildSmaSymbolReport("AAPL", bars, [
      { date: dateAt(bars, 400), side: "buy", value: 1000 },
      { date: dateAt(bars, 410), side: "sell", value: 400 },
    ]);
    const seg = r.regimes.find((s) => s.startDate <= dateAt(bars, 400) && s.endDate >= dateAt(bars, 400))!;
    expect(seg.buys).toBe(1);
    expect(seg.sells).toBe(1);
    expect(seg.netValue).toBeCloseTo(600, 9);
  });

  it("snaps a trade on a non-trading day back to the previous bar", () => {
    const bars = vShape(300).filter((_, i) => i !== 250);
    const r = buildSmaSymbolReport("AAPL", bars, [{ date: "2020-09-07", side: "buy" }]);
    const row = r.decisions[0]!;
    expect(row.barIndex).not.toBeNull();
    expect(row.close).not.toBeNull();
    expect(bars[row.barIndex!]!.date <= "2020-09-07").toBe(true);
  });

  it("keeps decisions that predate the price history without inventing state", () => {
    const bars = vShape(100);
    const r = buildSmaSymbolReport("AAPL", bars, [{ date: "1999-01-01", side: "sell" }]);
    const row = r.decisions[0]!;
    expect(row.barIndex).toBeNull();
    expect(row.close).toBeNull();
    expect(row.regime).toBe("unknown");
    expect(row.alignment).toBe("neutral");
  });

  it("drops malformed bars, dedupes dates and sorts out-of-order input", () => {
    const r = buildSmaSymbolReport("AAPL", [
      { date: "2024-01-03", close: 12 },
      { date: "2024-01-01", close: 10 },
      { date: "2024-01-02", close: "11" },
      { date: "2024-01-02", close: 11.5 },
      { date: "not-a-date", close: 5 },
      { date: "2024-01-04", close: null },
      { date: "2024-01-05", close: -3 },
    ]);
    expect(r.bars.map((b) => b.date)).toEqual(["2024-01-01", "2024-01-02", "2024-01-03"]);
    expect(r.bars[1]!.close).toBe(11.5);
    expect(r.summary.droppedBars).toBe(3);
    expect(r.summary.warnings.join(" ")).toContain("invalid bar");
  });

  it("classifies sub-threshold flips as whipsaws instead of tradable crosses", () => {
    // Tiny alternating noise around a flat level: SMAs cross repeatedly but
    // never clear the separation band.
    const bars: SmaBarInput[] = [];
    for (let i = 0; i < 200; i++) {
      bars.push({
        date: new Date(Date.UTC(2021, 0, 1) + i * 86400000).toISOString().slice(0, 10),
        close: 100 + Math.sin(i / 7) * 0.05,
      });
    }
    const r = buildSmaSymbolReport("AAPL", bars, [], {
      ...DEFAULT_SMA_CROSS_RULES,
      fastSeparationPct: 0.05,
    });
    expect(r.summary.fastCrosses).toBeGreaterThan(0);
    expect(r.summary.confirmedFastCrosses).toBe(0);
    expect(r.summary.whipsawFastCrosses).toBe(r.summary.fastCrosses);
  });

  it("is deterministic for the same inputs", () => {
    const bars = vShape(320);
    const decisions = [{ date: dateAt(bars, 300), side: "buy" as const, value: 100 }];
    expect(JSON.stringify(buildSmaSymbolReport("X", bars, decisions))).toBe(
      JSON.stringify(buildSmaSymbolReport("X", bars, decisions)),
    );
  });
});
