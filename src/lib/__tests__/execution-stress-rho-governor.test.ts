import { describe, expect, it } from "vitest";
import {
  calibrateCorrelations,
  type CorrelationCalibration,
} from "@/lib/execution-correlation-calibration";
import {
  formatStressRhoGovernance,
  governStressWithinRho,
  governedStructureFromCalibration,
} from "@/lib/execution-stress-rho-governor";
import { regimeRhos } from "@/lib/execution-correlation-structures";

/** Minimal calibration stub: only the fields the governor reads. */
function makeCal(opts: {
  calmWithin: number;
  stressWithin: number;
  stressRhos: number[];
  calmAcross?: number;
  stressAcross?: number;
}): CorrelationCalibration {
  const windows = [
    ...Array.from({ length: 20 }, (_, i) => ({
      endIndex: i,
      bars: 60,
      withinRho: opts.calmWithin,
      acrossRho: opts.calmAcross ?? opts.calmWithin * 0.5,
      withinPairs: 4,
      acrossPairs: 4,
      stressShare: 0,
      stressWeight: 0,
      stressed: false,
    })),
    ...opts.stressRhos.map((r, i) => ({
      endIndex: 100 + i,
      bars: 60,
      withinRho: r,
      acrossRho: (opts.stressAcross ?? r * 0.6),
      withinPairs: 4,
      acrossPairs: 4,
      stressShare: 1,
      stressWeight: 1,
      stressed: true,
    })),
  ];
  const pooled = (rho: number, n: number) => ({ rho, sd: 0.05, windows: n, weight: n });
  return {
    basis: "absReturns",
    window: 60,
    step: 60, // non-overlapping: blockSize 1, so effN == stressed window count
    shrink: 1,
    blend: 0,
    symbols: ["A", "B", "C", "D"],
    clusters: ["us-index", "us-tech"],
    windows,
    calm: {
      within: pooled(opts.calmWithin, 20),
      across: pooled(opts.calmAcross ?? opts.calmWithin * 0.5, 20),
    },
    stress: {
      within: pooled(opts.stressWithin, opts.stressRhos.length),
      across: pooled(opts.stressAcross ?? opts.stressWithin * 0.6, opts.stressRhos.length),
    },
    stressShare: opts.stressRhos.length / windows.length,
    stressMass: opts.stressRhos.length,
  } as CorrelationCalibration;
}

const tight = Array.from({ length: 24 }, (_, i) => 0.70 + (i % 3) * 0.005);
const fragile = [0.30, 0.95, 0.42, 0.88, 0.35, 0.92, 0.55, 0.20];

describe("stress rho governor", () => {
  it("passes a tight, well-sampled stress estimate through at full strength", () => {
    const g = governStressWithinRho(
      makeCal({ calmWithin: 0.30, stressWithin: 0.705, stressRhos: tight }),
      { seed: 7 },
    );
    expect(g.ciWidth).toBeLessThan(0.10);
    expect(g.credibility).toBeCloseTo(1, 5);
    expect(g.governedStressWithin).toBeCloseTo(g.rawStressWithin, 5);
  });

  it("shrinks a wide-CI stress estimate towards the calm coupling", () => {
    const g = governStressWithinRho(
      makeCal({ calmWithin: 0.30, stressWithin: 0.60, stressRhos: fragile }),
      { seed: 7 },
    );
    expect(g.ciWidth).toBeGreaterThan(0.10);
    expect(g.credibility).toBeLessThan(1);
    expect(g.governedStressWithin).toBeLessThan(g.rawStressWithin);
    expect(g.governedStressWithin).toBeGreaterThanOrEqual(g.calmWithin);
  });

  it("never lets the governed value fall below calm or exceed the raw estimate", () => {
    for (const rhos of [tight, fragile, [0.5, 0.5]]) {
      const g = governStressWithinRho(
        makeCal({ calmWithin: 0.30, stressWithin: 0.75, stressRhos: rhos }),
        { seed: 3 },
      );
      expect(g.governedStressWithin).toBeGreaterThanOrEqual(g.calmWithin - 1e-12);
      expect(g.governedStressWithin).toBeLessThanOrEqual(g.rawStressWithin + 1e-12);
    }
  });

  it("collapses to calm when there are no stressed windows", () => {
    const g = governStressWithinRho(
      makeCal({ calmWithin: 0.28, stressWithin: 0.90, stressRhos: [] }),
    );
    expect(g.credibility).toBe(0);
    expect(g.governedStressWithin).toBeCloseTo(0.28, 6);
    expect(g.notes.join(" ")).toMatch(/no stressed windows/i);
  });

  it("discounts a tight CI computed from too few independent windows", () => {
    const few = governStressWithinRho(
      makeCal({ calmWithin: 0.30, stressWithin: 0.70, stressRhos: [0.70, 0.70, 0.70] }),
      { seed: 5, minEffN: 6 },
    );
    const many = governStressWithinRho(
      makeCal({ calmWithin: 0.30, stressWithin: 0.70, stressRhos: tight }),
      { seed: 5, minEffN: 6 },
    );
    expect(few.sampleCredibility).toBeLessThan(1);
    expect(few.credibility).toBeLessThan(many.credibility);
    expect(few.governedStressWithin).toBeLessThan(many.governedStressWithin);
  });

  it("caps an implausibly large raw lift before weighting", () => {
    const g = governStressWithinRho(
      makeCal({ calmWithin: 0.10, stressWithin: 0.95, stressRhos: tight.map(() => 0.95) }),
      { seed: 11, maxLift: 0.35 },
    );
    expect(g.rawLift).toBeGreaterThan(0.35);
    expect(g.appliedLift).toBeLessThanOrEqual(0.35 + 1e-12);
    expect(g.governedStressWithin).toBeLessThanOrEqual(0.45 + 1e-12);
  });

  it("is a no-op when disabled", () => {
    const cal = makeCal({ calmWithin: 0.30, stressWithin: 0.60, stressRhos: fragile });
    const g = governStressWithinRho(cal, { seed: 7, enabled: false });
    expect(g.governedStressWithin).toBeCloseTo(g.rawStressWithin, 6);
  });

  it("is deterministic for the same calibration and seed", () => {
    const cal = makeCal({ calmWithin: 0.30, stressWithin: 0.60, stressRhos: fragile });
    const a = governStressWithinRho(cal, { seed: 42 });
    const b = governStressWithinRho(cal, { seed: 42 });
    expect(a.governedStressWithin).toBe(b.governedStressWithin);
  });

  it("feeds the governed value into the contagion structure and keeps across <= within", () => {
    const cal = makeCal({
      calmWithin: 0.30, calmAcross: 0.15,
      stressWithin: 0.75, stressAcross: 0.60,
      stressRhos: fragile,
    });
    const raw = governedStructureFromCalibration(cal, "contagion", undefined, { enabled: false });
    const gov = governedStructureFromCalibration(cal, "contagion", undefined, { seed: 7 });
    const rawStress = regimeRhos(raw.structure, 1);
    const govStress = regimeRhos(gov.structure, 1);
    expect(govStress.within).toBeLessThan(rawStress.within);
    expect(govStress.across).toBeLessThanOrEqual(govStress.within + 1e-12);
    // calm regime is untouched by the control
    expect(regimeRhos(gov.structure, 0).within).toBeCloseTo(regimeRhos(raw.structure, 0).within, 9);
  });

  it("formats a readable report", () => {
    const g = governStressWithinRho(
      makeCal({ calmWithin: 0.30, stressWithin: 0.60, stressRhos: fragile }),
      { seed: 7 },
    );
    const text = formatStressRhoGovernance(g);
    expect(text).toContain("Stress ρ_within risk control");
    expect(text).toContain("credibility");
  });

  it("works on a real calibration fitted from synthetic series", () => {
    const n = 400;
    const series = new Map<string, number[]>();
    let seed = 1;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648 - 0.5;
    };
    for (const sym of ["SPY", "QQQ", "VOD.L", "BP.L"]) {
      const closes: number[] = [100];
      for (let i = 1; i < n; i++) closes.push(closes[i - 1]! * (1 + rnd() * 0.02));
      series.set(sym, closes);
    }
    const volZ = Array.from({ length: n }, (_, i) => (i % 50 === 0 ? 2.5 : 0));
    const cal = calibrateCorrelations(series, { window: 60, step: 5, volZ });
    const g = governStressWithinRho(cal, { seed: 9 });
    expect(Number.isFinite(g.governedStressWithin)).toBe(true);
    expect(g.governedStressWithin).toBeGreaterThanOrEqual(0);
    expect(g.governedStressWithin).toBeLessThanOrEqual(1);
  });
});
