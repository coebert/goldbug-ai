import { describe, it, expect } from "vitest";
import {
  simulateAlgoRegimeConfig,
  compareAlgoRegimeConfigs,
  type DailyRegimeInput,
} from "@/lib/microstructure/algo-regime-backtest";
import {
  DEFAULT_ALGO_REGIME_CONFIG,
  type AlgoRegimeConfig,
} from "@/lib/microstructure/algo-regime";
import type { EquityPoint } from "@/lib/microstructure/algo-regime-calibration";

function makeCloses(n: number, vol: number, seed = 1): number[] {
  let x = seed;
  const closes: number[] = [100];
  for (let i = 1; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const shock = ((x / 0x7fffffff) - 0.5) * 2 * vol;
    closes.push(closes[i - 1] * (1 + shock));
  }
  return closes;
}

function isoDate(offset: number): string {
  const d = new Date("2025-01-01T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

describe("simulateAlgoRegimeConfig", () => {
  it("reclassifies days under a stricter volBurstRatio and reports drawdown", () => {
    const perDay: DailyRegimeInput[] = [];
    const equity: EquityPoint[] = [];
    let equityValue = 100_000;
    for (let day = 0; day < 40; day++) {
      const isTurbulent = day % 5 === 0;
      const closes = makeCloses(60, isTurbulent ? 0.03 : 0.005, day + 1);
      const volumes = closes.map(() => 1_000_000);
      perDay.push({ date: isoDate(day), primary: { closes, volumes } });
      // equity drops 2% on turbulent days, +0.3% otherwise
      const ret = isTurbulent ? -0.02 : 0.003;
      equityValue *= 1 + ret;
      equity.push({ date: isoDate(day), totalValue: equityValue });
    }
    // Append a final anchor so the last day has a forward return.
    equity.push({ date: isoDate(40), totalValue: equityValue * 1.001 });

    const loose: AlgoRegimeConfig = { ...DEFAULT_ALGO_REGIME_CONFIG, volBurstRatio: 1.5 };
    const strict: AlgoRegimeConfig = { ...DEFAULT_ALGO_REGIME_CONFIG, volBurstRatio: 3.5 };
    const looseSim = simulateAlgoRegimeConfig(perDay, equity, loose);
    const strictSim = simulateAlgoRegimeConfig(perDay, equity, strict);
    expect(looseSim.matched).toBeGreaterThan(0);
    expect(strictSim.matched).toBeGreaterThan(0);
    // Loose config flags more elevated/extreme days than strict.
    const looseFlagged = looseSim.perTier.filter((t) => t.tier !== "normal")
      .reduce((a, b) => a + b.count, 0);
    const strictFlagged = strictSim.perTier.filter((t) => t.tier !== "normal")
      .reduce((a, b) => a + b.count, 0);
    expect(looseFlagged).toBeGreaterThanOrEqual(strictFlagged);
    // Drawdown per tier is a non-positive fraction.
    for (const t of looseSim.perTier) {
      expect(t.maxDrawdown).toBeLessThanOrEqual(0);
    }
  });

  it("compareAlgoRegimeConfigs reports safety when candidate == baseline", () => {
    const perDay: DailyRegimeInput[] = Array.from({ length: 20 }, (_, i) => ({
      date: isoDate(i),
      primary: { closes: makeCloses(60, 0.01, i + 1), volumes: new Array(60).fill(500_000) },
    }));
    const equity: EquityPoint[] = perDay.map((d, i) => ({
      date: d.date, totalValue: 100_000 * (1 + i * 0.001),
    }));
    equity.push({ date: isoDate(20), totalValue: 100_000 * 1.021 });

    const cmp = compareAlgoRegimeConfigs(
      perDay, equity, DEFAULT_ALGO_REGIME_CONFIG, DEFAULT_ALGO_REGIME_CONFIG,
    );
    expect(cmp.safeToSchedule).toBe(true);
    for (const d of cmp.deltas) {
      expect(d.countDelta).toBe(0);
      expect(d.meanReturnDelta).toBeCloseTo(0, 10);
      expect(d.maxDrawdownDelta).toBeCloseTo(0, 10);
    }
  });
});
