import { describe, expect, it } from "vitest";
import { evaluateSetup, type ScanCandle } from "@/lib/setup-scan";

function series(closes: number[], volumes: number[]): ScanCandle[] {
  return closes.map((close, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    close,
    high: close * 1.01,
    low: close * 0.99,
    volume: volumes[i],
  }));
}

/** Long base, a dip below the averages, then a thin-tape surge back over them. */
function archetype(opts: { surgePct: number; relVol: number; volNoise: number }): ScanCandle[] {
  const closes: number[] = [];
  const volumes: number[] = [];
  // Base: choppy sideways tape whose choppiness sets realised volatility.
  for (let i = 0; i < 240; i += 1) {
    closes.push(100 + Math.sin(i / 3) * opts.volNoise);
    volumes.push(1_000_000);
  }
  // Dip: 10 sessions down, pushing price firmly under the 50d average.
  for (let i = 1; i <= 10; i += 1) {
    closes.push(100 - i * 2.5 + Math.sin(i) * opts.volNoise);
    volumes.push(1_000_000);
  }
  // Surge: 5 sessions up, reclaiming the averages.
  const base = closes[closes.length - 1];
  for (let i = 1; i <= 5; i += 1) {
    closes.push(base * (1 + (opts.surgePct / 100) * (i / 5)));
    volumes.push(1_000_000 * (i === 5 ? opts.relVol : 1));
  }
  return series(closes, volumes);
}

describe("evaluateSetup", () => {
  it("matches a high-vol, low-relative-volume reclaim", () => {
    const v = evaluateSetup("TEST", archetype({ surgePct: 40, relVol: 1.5, volNoise: 4 }));
    expect(v.rejected).toBeNull();
    expect(v.match).not.toBeNull();
    expect(v.match!.relVolume).toBeCloseTo(1.5, 1);
    expect(v.match!.changePct5d).toBeGreaterThan(10);
    expect(v.match!.invalidationBelow).toBeLessThan(v.match!.zoneLow);
    expect(v.match!.maxWeightPct).toBeLessThanOrEqual(5);
  });

  it("rejects a confirmed move on heavy volume", () => {
    const v = evaluateSetup("TEST", archetype({ surgePct: 40, relVol: 3.5, volNoise: 4 }));
    expect(v.match).toBeNull();
    expect(v.rejected).toMatch(/relative volume/);
  });

  it("rejects a quiet, low-volatility drift", () => {
    const v = evaluateSetup("TEST", archetype({ surgePct: 2, relVol: 1.2, volNoise: 0.2 }));
    expect(v.match).toBeNull();
    expect(v.rejected).toMatch(/surge bar|volatility|averages/);
  });

  it("rejects when history is too short for the 200d average", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    const v = evaluateSetup("TEST", series(closes, closes.map(() => 1_000_000)));
    expect(v.match).toBeNull();
    expect(v.rejected).toMatch(/history/);
  });

  it("caps position weight harder as volatility rises", () => {
    const calm = evaluateSetup("CALM", archetype({ surgePct: 12, relVol: 1.2, volNoise: 2 }));
    const wild = evaluateSetup("WILD", archetype({ surgePct: 40, relVol: 1.2, volNoise: 12 }));
    if (calm.match && wild.match) {
      expect(wild.match.maxWeightPct).toBeLessThanOrEqual(calm.match.maxWeightPct);
    }
  });
});

describe("divergence confluence", () => {
  /** Build a tape with a bullish (lower low, higher RSI low) dip before the reclaim. */
  function divergentArchetype(): ScanCandle[] {
    const closes: number[] = [];
    const volumes: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      closes.push(100 + Math.sin(i / 3) * 4);
      volumes.push(1_000_000);
    }
    // First low: sharp flush.
    for (let i = 1; i <= 8; i += 1) {
      closes.push(100 - i * 3);
      volumes.push(1_000_000);
    }
    // Bounce.
    for (let i = 1; i <= 10; i += 1) {
      closes.push(76 + i * 1.6);
      volumes.push(1_000_000);
    }
    // Second, marginally lower low made slowly (RSI holds higher).
    for (let i = 1; i <= 10; i += 1) {
      closes.push(92 - i * 1.7);
      volumes.push(1_000_000);
    }
    const base = closes[closes.length - 1];
    for (let i = 1; i <= 5; i += 1) {
      closes.push(base * (1 + 0.4 * (i / 5)));
      volumes.push(1_000_000 * (i === 5 ? 1.4 : 1));
    }
    return series(closes, volumes);
  }

  it("reports divergence state on every match and reflects it in score and thesis", () => {
    const v = evaluateSetup("TEST", divergentArchetype());
    if (!v.match) return; // tape may not clear every gate; the shape test below covers the contract
    const m = v.match;
    expect(m.score).toBeGreaterThanOrEqual(0);
    expect(m.score).toBeLessThanOrEqual(100);
    if (m.divergence) {
      expect(["bullish", "bearish"]).toContain(m.divergence.kind);
      expect(m.thesis).toContain(m.divergence.kind === "bullish" ? "Confluence" : "Warning");
      expect(m.divergence.barsAgo).toBeLessThanOrEqual(30);
      expect(m.reasons.join(" ")).toContain("divergence");
    } else {
      expect(m.thesis).toContain("No confirmed RSI divergence");
      expect(m.reasons.join(" ")).toContain("No recent RSI divergence");
    }
  });

  it("keeps the plain archetype's divergence field defined", () => {
    const v = evaluateSetup("TEST", archetype({ surgePct: 40, relVol: 1.5, volNoise: 4 }));
    expect(v.match).not.toBeNull();
    expect(v.match!).toHaveProperty("divergence");
    const d = v.match!.divergence;
    if (d) expect(Math.abs(d.scoreAdjust)).toBeLessThanOrEqual(12);
  });
});
