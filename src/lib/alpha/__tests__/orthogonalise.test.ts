import { describe, expect, it } from "vitest";
import {
  orthogonaliseScores,
  describeOrthogonalisation,
  DEFAULT_ORTHOGONALISATION,
  MIN_OBS,
  type ModelScoreRow,
} from "../orthogonalise";

// Universe where breakout is (almost) a linear copy of trend.
function collinearUniverse(n = 20): ModelScoreRow[] {
  return Array.from({ length: n }, (_, i) => {
    const t = -1 + (2 * i) / (n - 1);
    return { trend: t, breakout: 0.9 * t, quality: 0.1, carry: 0.2, mean_reversion: 0.05 };
  });
}

const corr = (xs: number[], ys: number[]) => {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    cov += (xs[i]! - mx) * (ys[i]! - my);
    vx += (xs[i]! - mx) ** 2;
    vy += (ys[i]! - my) ** 2;
  }
  return cov / Math.sqrt(vx * vy || 1);
};

describe("cross-sectional orthogonalisation", () => {
  it("strips the trend overlap out of breakout", () => {
    const rows = collinearUniverse();
    const before = corr(rows.map((r) => r.trend!), rows.map((r) => r.breakout!));
    expect(Math.abs(before)).toBeGreaterThan(0.95);

    const { rows: out, diagnostics } = orthogonaliseScores(rows);
    const after = corr(out.map((r) => r.trend!), out.map((r) => r.breakout!));
    expect(Math.abs(after)).toBeLessThan(Math.abs(before));
    expect(diagnostics.find((d) => d.target === "breakout")?.applied).toBe(true);
  });

  it("never mutates the input rows", () => {
    const rows = collinearUniverse();
    const snapshot = JSON.stringify(rows);
    orthogonaliseScores(rows);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  it("regresses against original scores, so pair order does not matter", () => {
    const rows = collinearUniverse();
    const a = orthogonaliseScores(rows, [
      { target: "breakout", against: "trend" },
      { target: "mean_reversion", against: "trend" },
    ]).rows;
    const b = orthogonaliseScores(rows, [
      { target: "mean_reversion", against: "trend" },
      { target: "breakout", against: "trend" },
    ]).rows;
    expect(a).toEqual(b);
  });

  it("leaves the target alone when the universe is too small", () => {
    const rows = collinearUniverse(MIN_OBS - 1);
    const { rows: out, diagnostics } = orthogonaliseScores(rows);
    expect(out).toEqual(rows);
    expect(diagnostics.every((d) => !d.applied)).toBe(true);
  });

  it("leaves the target alone when the overlap is weak", () => {
    const rows: ModelScoreRow[] = Array.from({ length: 24 }, (_, i) => ({
      trend: i % 2 === 0 ? 0.8 : -0.8,
      breakout: i % 3 === 0 ? 0.5 : -0.2,
    }));
    const { diagnostics } = orthogonaliseScores(rows, [{ target: "breakout", against: "trend" }]);
    expect(diagnostics[0]!.applied).toBe(false);
    expect(diagnostics[0]!.reason).toContain("too weak");
  });

  it("keeps residual scores bounded to [-1, 1]", () => {
    const rows = collinearUniverse(30).map((r) => ({ ...r, breakout: r.breakout! * 1.05 }));
    const { rows: out } = orthogonaliseScores(rows);
    for (const r of out) {
      for (const v of Object.values(r)) expect(Math.abs(v as number)).toBeLessThanOrEqual(1);
    }
  });

  it("collapses a perfectly collinear model to nothing — it adds no information", () => {
    const rows = collinearUniverse(40);
    const out = orthogonaliseScores(rows).rows;
    for (const r of out) expect(Math.abs(r.breakout! - out[0]!.breakout!)).toBeLessThan(1e-6);
  });

  it("preserves the dispersion of a partially overlapping model", () => {
    const rows: ModelScoreRow[] = Array.from({ length: 40 }, (_, i) => {
      const t = -1 + (2 * i) / 39;
      const idiosyncratic = ((i * 37) % 11) / 11 - 0.5; // deterministic noise
      return { trend: t, breakout: 0.5 * t + idiosyncratic, quality: 0.1, carry: 0.2 };
    });
    const sd = (xs: number[]) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
    };
    const before = sd(rows.map((r) => r.breakout!));
    const after = sd(orthogonaliseScores(rows).rows.map((r) => r.breakout!));
    // Clamping can shave a little, but the model must not be flattened.
    expect(after).toBeGreaterThan(before * 0.7);
  });

  it("ignores rows missing either score", () => {
    const rows: ModelScoreRow[] = [...collinearUniverse(12), { quality: 0.5 }];
    const { rows: out } = orthogonaliseScores(rows);
    expect(out[12]).toEqual({ quality: 0.5 });
  });

  it("summarises what it removed", () => {
    const { diagnostics } = orthogonaliseScores(collinearUniverse());
    expect(describeOrthogonalisation(diagnostics)).toContain("breakout");
    expect(describeOrthogonalisation([])).toContain("no material overlap");
  });

  it("defaults to residualising the three known overlaps", () => {
    expect(DEFAULT_ORTHOGONALISATION.map((p) => `${p.target}<-${p.against}`)).toEqual([
      "breakout<-trend",
      "mean_reversion<-trend",
      "carry<-quality",
    ]);
  });
});
