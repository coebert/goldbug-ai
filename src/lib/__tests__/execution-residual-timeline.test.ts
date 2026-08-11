import { describe, expect, it } from "vitest";
import {
  bucketWindows,
  formatResidualEpisodes,
  formatResidualHeatmap,
  formatResidualTimeline,
  pairLabel,
  residualShade,
  residualTimeline,
} from "@/lib/execution-residual-timeline";
import { makeCorrelationStructure } from "@/lib/execution-correlation-structures";

// Two clusters, a stress patch in the middle where the clusters merge, and a
// late regime shift where cluster `b` decouples — the timeline should show
// *when* each of those happens, not just an average.
function tape(bars = 500) {
  const symbols = ["a1", "a2", "a3", "b1", "b2", "b3"];
  const groups = new Map(symbols.map((s) => [s, s.startsWith("a") ? "alpha" : "beta"]));
  const series = new Map<string, number[]>(symbols.map((s) => [s, [100]]));
  const volZ: number[] = [0];
  const dates: string[] = ["2020-01-01"];
  const stressFrom = 200;
  const stressTo = 260;
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  const day = (i: number) =>
    new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);

  for (let i = 1; i < bars; i++) {
    const stressed = i >= stressFrom && i < stressTo;
    const market = rnd() * (stressed ? 0.06 : 0.003);
    const ca = rnd() * 0.012;
    // Late in the tape beta's own cluster cohesion collapses.
    const cb = rnd() * (i > 380 ? 0.001 : 0.012);
    for (const s of symbols) {
      const prev = series.get(s)!.at(-1)!;
      series.get(s)!.push(prev * (1 + market + (s.startsWith("a") ? ca : cb) + rnd() * 0.005));
    }
    volZ.push(stressed ? 2.4 : -0.3);
    dates.push(day(i));
  }
  return { series, volZ, dates, groups, stressFrom, stressTo };
}

const base = (t: ReturnType<typeof tape>) => ({
  groups: t.groups,
  volZ: t.volZ,
  dates: t.dates,
  window: 60,
  step: 10,
  stressZ: 1.5,
  minStressShare: 0.25,
});

describe("residualTimeline", () => {
  const t = tape();
  const report = residualTimeline(t.series, base(t));

  it("scores both structures on the same windows", () => {
    expect(report.structures.map((s) => s.kind)).toEqual(["blocks", "contagion"]);
    expect(report.windows.length).toBeGreaterThan(10);
    for (const s of report.structures) {
      expect(s.rmseByWindow).toHaveLength(report.windows.length);
    }
  });

  it("labels windows with the calendar date of their right edge", () => {
    for (const w of report.windows) {
      expect(w.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const dates = report.windows.map((w) => w.date!);
    expect([...dates].sort()).toEqual(dates);
  });

  it("covers every observed cluster pair, within and across", () => {
    const labels = report.structures[0]!.pairs.map((p) => pairLabel(p.a, p.b)).sort();
    expect(labels).toEqual(["alpha", "alpha↔beta", "beta"]);
    expect(report.structures[0]!.pairs.filter((p) => p.within)).toHaveLength(2);
  });

  it("error is exactly implied − realised", () => {
    for (const s of report.structures) {
      for (const p of s.pairs) {
        for (const c of p.cells) {
          expect(c.error).toBeCloseTo(c.implied - c.realised, 12);
          expect(c.realised).toBeGreaterThanOrEqual(-1);
          expect(c.realised).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("marks the stress patch as stressed and everything else as calm", () => {
    const stressed = report.windows.filter((w) => w.stressWeight > 0.5);
    expect(stressed.length).toBeGreaterThan(0);
    for (const w of stressed) {
      expect(w.endIndex).toBeGreaterThan(t.stressFrom - 60);
      expect(w.endIndex).toBeLessThan(t.stressTo + 60);
    }
  });

  it("blends the implied leg with the window's soft regime weight", () => {
    const soft = residualTimeline(t.series, { ...base(t), blend: 1 });
    const s = soft.structures[0]!;
    const partial = soft.windows.filter((w) => w.stressWeight > 0 && w.stressWeight < 1);
    expect(partial.length).toBeGreaterThan(0);
    const within = s.pairs.find((p) => p.within)!;
    const implied = new Map(within.cells.map((c) => [c.window, c.implied]));
    const calm = implied.get(soft.windows.find((w) => w.stressWeight === 0)!.index)!;
    const mid = implied.get(partial[0]!.index)!;
    const hot = implied.get(
      soft.windows.find((w) => w.stressWeight === 1)?.index
        ?? partial.at(-1)!.index,
    )!;
    expect(mid).toBeGreaterThanOrEqual(Math.min(calm, hot) - 1e-9);
    expect(mid).toBeLessThanOrEqual(Math.max(calm, hot) + 1e-9);
  });

  it("finds the late beta decoupling as the fastest-drifting pair", () => {
    const s = report.structures[1]!;
    const drifting = [...s.pairs].sort((a, b) => b.drift - a.drift)[0]!;
    expect(pairLabel(drifting.a, drifting.b)).toBe("beta");
    expect(drifting.drift).toBeGreaterThan(0);
    const late = drifting.cells.filter((c) => report.windows[c.window]!.date! > "2021-01-15");
    expect(Math.abs(late.at(-1)!.error)).toBeGreaterThan(Math.abs(drifting.cells[0]!.error));
  });

  it("ranks episodes worst-first and matches the per-window rmse", () => {
    const s = report.structures[0]!;
    const rmses = s.episodes.map((e) => e.rmse);
    expect([...rmses].sort((a, b) => b - a)).toEqual(rmses);
    for (const e of s.episodes) {
      expect(e.rmse).toBeCloseTo(s.rmseByWindow[e.window]!, 12);
      expect(e.date).toBe(report.windows[e.window]!.date);
    }
  });

  it("names a real cluster pair as each episode's worst offender", () => {
    const labels = new Set(report.structures[0]!.pairs.map((p) => pairLabel(p.a, p.b)));
    for (const e of report.structures[0]!.episodes) {
      expect(labels.has(e.worstPair)).toBe(true);
    }
  });

  it("splits overall error into calm and stress halves", () => {
    for (const s of report.structures) {
      expect(Number.isFinite(s.rmseCalm)).toBe(true);
      expect(Number.isFinite(s.rmseStress)).toBe(true);
      expect(s.rmse).toBeGreaterThan(0);
    }
  });

  it("reports where contagion wins and whether the win is regime-driven", () => {
    expect(report.contagionEdgeByWindow).toHaveLength(report.windows.length);
    expect(report.contagionWinRate).toBeGreaterThanOrEqual(0);
    expect(report.contagionWinRate).toBeLessThanOrEqual(1);
    expect(report.contagionEdgeStress).toBeGreaterThan(report.contagionEdgeCalm);
  });

  it("accepts a pinned structure instead of re-fitting", () => {
    const pinned = makeCorrelationStructure({
      kind: "contagion", rho: 0.4, withinRho: 0.9, acrossRho: 0.9,
      stressWithinRho: 0.9, stressAcrossRho: 0.9, groups: t.groups,
    });
    const r = residualTimeline(t.series, {
      ...base(t),
      kinds: ["contagion"],
      structures: new Map([["contagion", pinned]]),
    });
    for (const p of r.structures[0]!.pairs) {
      for (const c of p.cells) expect(c.implied).toBeCloseTo(0.9, 6);
    }
    // An absurdly over-coupled structure must read as over-coupled everywhere.
    expect(r.structures[0]!.bias).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const again = residualTimeline(t.series, base(t));
    expect(again.structures[0]!.rmseByWindow).toEqual(report.structures[0]!.rmseByWindow);
  });

  it("returns an empty report for a tape with too few bars or symbols", () => {
    const tiny = residualTimeline(new Map([["a1", [1, 2, 3]]]), base(t));
    expect(tiny.windows).toEqual([]);
    expect(tiny.structures).toEqual([]);
    expect(formatResidualTimeline(tiny)).toContain("no windows");
  });

  it("survives missing dates by falling back to window indices", () => {
    const r = residualTimeline(t.series, { ...base(t), dates: undefined });
    expect(r.windows.every((w) => w.date === null)).toBe(true);
    expect(formatResidualEpisodes(r.structures[0]!)).toContain("w");
  });
});

describe("heatmap rendering", () => {
  const t = tape();
  const report = residualTimeline(t.series, base(t));

  it("shades by sign and magnitude", () => {
    expect(residualShade(0, 0.2)).toBe("·");
    expect(residualShade(0.2, 0.2)).toBe("@");
    expect(residualShade(-0.2, 0.2)).toBe("X");
    expect(residualShade(-0.05, 0.2)).toBe(",");
    expect(residualShade(5, 0.2)).toBe("@");
    expect(residualShade(Number.NaN, 0.2)).toBe(" ");
  });

  it("buckets windows into contiguous, complete columns", () => {
    const b = bucketWindows(10, 4);
    expect(b).toHaveLength(4);
    expect(b.flat()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(bucketWindows(3, 40)).toHaveLength(3);
    expect(bucketWindows(0, 8)).toHaveLength(1);
  });

  it("prints one fixed-width row per pair plus a stress strip", () => {
    const out = formatResidualHeatmap(report, report.structures[0]!, { columns: 30 });
    const rows = out.split("\n").filter((l) => l.includes("|"));
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(rows, null, 1));
    expect(rows).toHaveLength(report.structures[0]!.pairs.length + 1);
    for (const r of rows) {
      expect(r.split("|")[1]).toHaveLength(30);
    }
    expect(out).toContain("stress regime");
    expect(out).toContain("over-coupled");
  });

  it("puts the stress marks under the stress patch", () => {
    const out = formatResidualHeatmap(report, report.structures[0]!, { columns: 20 });
    const strip = out.split("\n").find((l) => l.includes("stress regime"))!.split("|")[1]!;
    const marked = [...strip].map((c, i) => (c.trim() ? i : -1)).filter((i) => i >= 0);
    expect(marked.length).toBeGreaterThan(0);
    // The patch sits early-middle in the tape, never at the very end.
    expect(Math.max(...marked)).toBeLessThan(15);
  });

  it("renders the full report with both structures and the verdict line", () => {
    const out = formatResidualTimeline(report, { columns: 24, episodes: 3 });
    expect(out).toContain("Residual heatmap — blocks");
    expect(out).toContain("Residual heatmap — contagion");
    expect(out).toContain("Worst windows — contagion");
    expect(out).toContain("Blocks vs contagion, per window");
    expect(out).toMatch(/contagion fits better in \d+% of windows/);
  });
});
