import { describe, expect, it } from "vitest";
import {
  buildCalibration,
  convictionPercentile,
  readCalibration,
  wilsonInterval,
  MIN_BAND_SAMPLES,
  type CalibrationSample,
} from "../confidence-calibration";
import { forwardReturn, indexPrices, buildCalibrationSamples } from "../confidence-calibration.server";

function samples(spec: Array<[number, boolean]>, ret = 0.01): CalibrationSample[] {
  return spec.map(([conviction, hit]) => ({ conviction, hit, forwardReturn: hit ? ret : -ret }));
}

describe("wilsonInterval", () => {
  it("brackets the point estimate and widens with small n", () => {
    const [lo, hi] = wilsonInterval(7, 10);
    expect(lo).toBeLessThan(0.7);
    expect(hi).toBeGreaterThan(0.7);
    const [lo2, hi2] = wilsonInterval(70, 100);
    expect(hi2 - lo2).toBeLessThan(hi - lo);
  });
  it("is safe for n = 0", () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
  });
});

describe("buildCalibration", () => {
  it("buckets samples into conviction bands with hit-rates", () => {
    const s = samples([
      [0.1, false], [0.15, false], [0.1, true],
      [0.7, true], [0.72, true], [0.65, false], [0.9, true],
    ]);
    const r = buildCalibration(s, { horizonDays: 5 });
    expect(r.totalSamples).toBe(7);
    const low = r.bands.find((b) => b.label === "0–20%")!;
    expect(low.n).toBe(3);
    expect(low.hitRate).toBeCloseTo(1 / 3, 5);
    const high = r.bands.find((b) => b.label === "60–80%")!;
    expect(high.n).toBe(3);
    expect(high.hitRate).toBeCloseTo(2 / 3, 5);
    expect(r.horizonDays).toBe(5);
  });

  it("places conviction 1.0 in the top band", () => {
    const r = buildCalibration(samples([[1, true]]));
    expect(r.bands[r.bands.length - 1].n).toBe(1);
  });

  it("ignores out-of-range conviction values", () => {
    const r = buildCalibration([
      { conviction: 1.4, hit: true },
      { conviction: -0.2, hit: false },
      { conviction: 0.5, hit: true },
    ]);
    expect(r.totalSamples).toBe(1);
  });

  it("computes calibration error only for well-populated bands", () => {
    const thin = buildCalibration(samples([[0.7, true], [0.7, false]]));
    expect(thin.calibrationError).toBeNull();
    const thick = buildCalibration(
      samples(Array.from({ length: 10 }, (_, i) => [0.7, i < 7] as [number, boolean])),
    );
    expect(thick.calibrationError).toBeCloseTo(0, 1);
  });
});

describe("convictionPercentile", () => {
  it("ranks a conviction within history", () => {
    const s = samples([[0.1, true], [0.2, true], [0.3, false], [0.9, true]]);
    expect(convictionPercentile(0.9, s)).toBe(88);
    expect(convictionPercentile(0.05, s)).toBe(0);
  });
  it("returns null with no history", () => {
    expect(convictionPercentile(0.5, [])).toBeNull();
  });
});

describe("readCalibration", () => {
  const dense = samples(
    Array.from({ length: 20 }, (_, i) => [0.7, i < 14] as [number, boolean]),
  );
  const report = buildCalibration(dense, { horizonDays: 5 });

  it("explains the band hit-rate in plain language", () => {
    const r = readCalibration(0.7, report, dense);
    expect(r.insufficient).toBe(false);
    expect(r.band?.label).toBe("60–80%");
    expect(r.sentence).toMatch(/70% hit-rate/);
    expect(r.sentence).toMatch(/within 5 trading days/);
    expect(r.sentence).toMatch(/95% range/);
    expect(r.verdict).toBe("well-calibrated");
  });

  it("flags optimistic confidence when stated exceeds realized", () => {
    const s = samples(Array.from({ length: 20 }, (_, i) => [0.9, i < 8] as [number, boolean]));
    const rep = buildCalibration(s);
    const r = readCalibration(0.9, rep, s);
    expect(r.verdict).toBe("optimistic");
    expect(r.sentence).toMatch(/ahead of outcomes/);
  });

  it("flags conservative confidence when outcomes beat the stated number", () => {
    const s = samples(Array.from({ length: 20 }, (_, i) => [0.3, i < 18] as [number, boolean]));
    const rep = buildCalibration(s);
    const r = readCalibration(0.3, rep, s);
    expect(r.verdict).toBe("conservative");
  });

  it("refuses to quote a hit-rate with too few samples", () => {
    const s = samples([[0.7, true], [0.7, false]]);
    const rep = buildCalibration(s);
    const r = readCalibration(0.7, rep, s);
    expect(r.insufficient).toBe(true);
    expect(r.sentence).toContain(`needs ${MIN_BAND_SAMPLES}`);
  });

  it("handles a missing conviction", () => {
    const r = readCalibration(null, report, dense);
    expect(r.verdict).toBe("unknown");
    expect(r.sentence).toMatch(/No conviction was recorded/);
  });
});

describe("forward returns from price history", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    symbol: "MKS.L",
    price_date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    close: 100 + i,
  }));

  it("signs the return by trade side", () => {
    const idx = indexPrices(rows);
    const series = idx.get("MKS.L");
    const buy = forwardReturn(series, "2026-01-01", "buy", 5);
    const sell = forwardReturn(series, "2026-01-01", "sell", 5);
    expect(buy).toBeCloseTo(5 / 100, 6);
    expect(sell).toBeCloseTo(-5 / 100, 6);
  });

  it("returns null when the horizon runs past available data", () => {
    const idx = indexPrices(rows);
    expect(forwardReturn(idx.get("MKS.L"), "2026-01-10", "buy", 5)).toBeNull();
    expect(forwardReturn(undefined, "2026-01-01", "buy", 5)).toBeNull();
  });

  it("builds samples from decisions and prices, matching LSE symbol variants", () => {
    const decisions = [
      {
        id: "d1",
        run_date: "2026-01-01",
        portfolio_value: 10000,
        raw: {
          orders: [
            { symbol: "MKS:xlon", side: "buy", quantity: 10, price: 1, conviction: 0.8, reason: "trend" },
          ],
          executed: [
            { symbol: "MKS:xlon", side: "buy", quantity: 10, price: 1, value: 10 },
          ],
        },
      },
    ];
    const out = buildCalibrationSamples(decisions, rows, 5);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].conviction).toBeCloseTo(0.8, 5);
    expect(out[0].hit).toBe(true);
  });
});
