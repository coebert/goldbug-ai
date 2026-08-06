import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheSavings,
  clearRegimeCache,
  DEFAULT_MAX_ENTRIES,
  indexFingerprint,
  regimeCache,
  RegimeComputeCache,
  tapeFingerprint,
  thresholdKey,
  warmRegimeCache,
} from "../regime-compute-cache";
import {
  benchmarkIndex,
  classifyRegimeBars,
  dominantRegimeWeighted,
  overlappingWalkForwardWindows,
  type TapeBarLike,
} from "../regime-walk-forward";

function tape(bars = 400, drift = 0.0006): TapeBarLike[] {
  const out: TapeBarLike[] = [];
  let a = 100;
  let b = 50;
  for (let i = 0; i < bars; i++) {
    a *= 1 + drift + 0.01 * Math.sin(i / 9);
    b *= 1 + drift * 0.5 + 0.008 * Math.cos(i / 11);
    const d = new Date(Date.UTC(2022, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    out.push({ date: d, closes: { AAA: a, BBB: b } });
  }
  return out;
}

describe("fingerprints", () => {
  it("are stable for identical content and differ on any change", () => {
    expect(tapeFingerprint(tape())).toBe(tapeFingerprint(tape()));
    const changed = tape();
    changed[10]!.closes["AAA"] = changed[10]!.closes["AAA"]! * 1.01;
    expect(tapeFingerprint(changed)).not.toBe(tapeFingerprint(tape()));
    expect(tapeFingerprint(tape(399))).not.toBe(tapeFingerprint(tape(400)));
  });

  it("ignore symbol ordering but not symbol identity", () => {
    const a: TapeBarLike[] = [{ date: "2024-01-01", closes: { AAA: 1, BBB: 2 } }];
    const b: TapeBarLike[] = [{ date: "2024-01-01", closes: { BBB: 2, AAA: 1 } }];
    const c: TapeBarLike[] = [{ date: "2024-01-01", closes: { AAA: 1, CCC: 2 } }];
    expect(tapeFingerprint(a)).toBe(tapeFingerprint(b));
    expect(tapeFingerprint(a)).not.toBe(tapeFingerprint(c));
  });

  it("distinguish index series", () => {
    const i1 = benchmarkIndex(tape(50));
    const i2 = benchmarkIndex(tape(50, 0.002));
    expect(indexFingerprint(i1)).toBe(indexFingerprint(benchmarkIndex(tape(50))));
    expect(indexFingerprint(i1)).not.toBe(indexFingerprint(i2));
  });

  it("normalises threshold keys against defaults and key order", () => {
    expect(thresholdKey({})).toBe(thresholdKey(undefined));
    expect(thresholdKey({ lookback: 63, minTrendR2: 0.3 })).toBe(
      thresholdKey({ minTrendR2: 0.3, lookback: 63 }),
    );
    expect(thresholdKey({ lookback: 63 })).not.toBe(thresholdKey({ lookback: 42 }));
  });
});

describe("RegimeComputeCache", () => {
  let cache: RegimeComputeCache;
  beforeEach(() => {
    cache = new RegimeComputeCache();
  });

  it("computes once and serves hits thereafter", () => {
    const compute = vi.fn(() => 42);
    expect(cache.memo("ns", "k", compute)).toBe(42);
    expect(cache.memo("ns", "k", compute)).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
    const s = cache.stats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBeCloseTo(0.5, 6);
    expect(s.byNamespace["ns"]).toEqual({ hits: 1, misses: 1 });
  });

  it("returns results identical to the uncached functions", () => {
    const bars = tape(200);
    const index = cache.benchmarkIndex(bars);
    expect(index).toEqual(benchmarkIndex(bars));
    expect(cache.regimeBars(index, { lookback: 40 })).toEqual(
      classifyRegimeBars(index, { lookback: 40 }),
    );
    expect(cache.regimeLabels(index, { lookback: 40 })).toEqual(
      classifyRegimeBars(index, { lookback: 40 }).map((b) => b.label),
    );
    expect(cache.windowRegime(index, 20, 100, { lookback: 40 })).toEqual(
      dominantRegimeWeighted(classifyRegimeBars(index, { lookback: 40 }), 20, 100),
    );
  });

  it("classifies the tape once no matter how many overlapping windows ask", () => {
    const bars = tape(600);
    const index = cache.benchmarkIndex(bars);
    const windows = overlappingWalkForwardWindows(index.length, {
      trainBars: 252,
      testBars: 126,
      overlapPct: 0.75,
    });
    expect(windows.length).toBeGreaterThan(4);
    for (const w of windows) cache.windowRegime(index, w.testStart, w.testEnd);
    const s = cache.stats();
    expect(s.byNamespace["regimeBars"]!.misses).toBe(1);
    expect(s.byNamespace["regimeBars"]!.hits).toBe(windows.length - 1);
    expect(s.byNamespace["windowRegime"]!.misses).toBe(windows.length);
  });

  it("reuses window votes when overlap flags produce the same ranges", () => {
    const bars = tape(600);
    const index = cache.benchmarkIndex(bars);
    const run = () => {
      for (const w of overlappingWalkForwardWindows(index.length, {
        trainBars: 252,
        testBars: 126,
        overlapPct: 0.5,
      })) {
        cache.windowRegime(index, w.testStart, w.testEnd);
      }
    };
    run();
    const afterFirst = cache.stats().byNamespace["windowRegime"]!.misses;
    run();
    const s = cache.stats().byNamespace["windowRegime"]!;
    expect(s.misses).toBe(afterFirst);
    expect(s.hits).toBe(afterFirst);
  });

  it("separates entries by thresholds and vote options", () => {
    const index = benchmarkIndex(tape(300));
    cache.windowRegime(index, 0, 100, { lookback: 40 });
    cache.windowRegime(index, 0, 100, { lookback: 80 });
    cache.windowRegime(index, 0, 100, { lookback: 40 }, { minConfidence: 0.9 });
    expect(cache.stats().byNamespace["windowRegime"]!.misses).toBe(3);
    cache.windowRegime(index, 0, 100, { lookback: 40 });
    expect(cache.stats().byNamespace["windowRegime"]!.hits).toBe(1);
  });

  it("never serves a stale result after the tape changes", () => {
    const bars = tape(150);
    const first = cache.benchmarkIndex(bars);
    const mutated = tape(150);
    mutated[100]!.closes["AAA"] = mutated[100]!.closes["AAA"]! * 1.5;
    const second = cache.benchmarkIndex(mutated);
    expect(second).not.toEqual(first);
    expect(second).toEqual(benchmarkIndex(mutated));
  });

  it("evicts least-recently-used entries when full", () => {
    const small = new RegimeComputeCache(2);
    small.memo("ns", "a", () => 1);
    small.memo("ns", "b", () => 2);
    small.memo("ns", "a", () => 99); // refresh recency of "a"
    small.memo("ns", "c", () => 3); // evicts "b"
    const recomputed = vi.fn(() => 22);
    small.memo("ns", "b", recomputed);
    expect(recomputed).toHaveBeenCalledTimes(1);
    expect(small.memo("ns", "a", () => 99)).toBe(99); // "a" aged out when "b" returned
    expect(small.stats().evictions).toBeGreaterThan(0);
    expect(small.stats().size).toBeLessThanOrEqual(2);
  });

  it("resizes down by evicting and rejects invalid sizes", () => {
    const c = new RegimeComputeCache(10);
    for (let i = 0; i < 8; i++) c.memo("ns", `k${i}`, () => i);
    c.resize(3);
    expect(c.stats().size).toBe(3);
    expect(c.stats().maxEntries).toBe(3);
    expect(() => new RegimeComputeCache(0)).toThrow();
    expect(() => c.resize(0)).toThrow();
  });

  it("clears and invalidates by namespace", () => {
    const index = benchmarkIndex(tape(120));
    cache.windowRegime(index, 0, 50);
    expect(cache.invalidateNamespace("windowRegime")).toBe(1);
    expect(cache.stats().byNamespace["windowRegime"]).toBeUndefined();
    expect(cache.stats().size).toBeGreaterThan(0);
    cache.clear();
    expect(cache.stats()).toMatchObject({ size: 0, hits: 0, misses: 0, evictions: 0 });
  });

  it("defaults to the documented capacity", () => {
    expect(new RegimeComputeCache().stats().maxEntries).toBe(DEFAULT_MAX_ENTRIES);
  });
});

describe("warmRegimeCache", () => {
  beforeEach(() => clearRegimeCache());

  it("pre-warms so later window lookups never re-classify", () => {
    const bars = tape(500);
    const warm = warmRegimeCache(bars);
    expect(warm.bars).toHaveLength(warm.index.length);
    const before = regimeCache.stats().byNamespace["regimeBars"]!.misses;
    for (const w of overlappingWalkForwardWindows(warm.index.length, {
      trainBars: 200,
      testBars: 100,
      overlapPct: 0.8,
    })) {
      regimeCache.windowRegime(warm.index, w.testStart, w.testEnd, {}, {}, warm.fingerprint);
    }
    expect(regimeCache.stats().byNamespace["regimeBars"]!.misses).toBe(before);
  });
});

describe("cacheSavings", () => {
  it("reports the work avoided by classifying the tape once", () => {
    const windows = overlappingWalkForwardWindows(600, {
      trainBars: 252,
      testBars: 126,
      overlapPct: 0.75,
    });
    const s = cacheSavings(windows, 600);
    expect(s.cachedBarClassifications).toBe(600);
    expect(s.naiveBarClassifications).toBe(windows.length * 126);
    expect(s.speedup).toBeGreaterThan(1);
  });

  it("is zero-safe on an empty tape", () => {
    expect(cacheSavings([], 0)).toEqual({
      naiveBarClassifications: 0,
      cachedBarClassifications: 0,
      speedup: 0,
    });
  });
});
