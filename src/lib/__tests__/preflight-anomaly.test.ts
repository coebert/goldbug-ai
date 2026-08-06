import { describe, it, expect } from "vitest";
import {
  analyzePreflight,
  buildPhaseBaselines,
  robustScore,
  phaseLabel,
} from "@/lib/preflight-anomaly";
import type { PhaseTiming, RunPhase } from "@/lib/run-telemetry";

function p(phase: RunPhase, ms: number, skipped = false, note?: string): PhaseTiming {
  return { phase, ms, skipped, note };
}

/** A steady baseline: prices ~2s, news ~3s, saxo ~500ms. */
function steadyHistory(runs = 10) {
  return Array.from({ length: runs }, (_, i) => [
    { phase: "saxo_refresh" as const, ms: 480 + (i % 3) * 20 },
    { phase: "news" as const, ms: 3_000 + (i % 4) * 100 },
    { phase: "prices" as const, ms: 2_000 + (i % 5) * 50 },
  ]);
}

describe("baselines", () => {
  it("computes median/MAD per phase and ignores skipped zero samples", () => {
    const b = buildPhaseBaselines([
      [{ phase: "news", ms: 1_000 }],
      [{ phase: "news", ms: 2_000 }],
      [{ phase: "news", ms: 3_000 }],
      [{ phase: "news", ms: 0 }],
    ]);
    const news = b.get("news")!;
    expect(news.samples).toBe(3);
    expect(news.medianMs).toBe(2_000);
    expect(news.madMs).toBe(1_000);
  });

  it("returns no score without enough history", () => {
    const b = buildPhaseBaselines([[{ phase: "prices", ms: 1_000 }]]);
    expect(robustScore(9_000, b.get("prices")!)).toBeNull();
  });

  it("scores a jump even when MAD is zero", () => {
    const b = buildPhaseBaselines([
      [{ phase: "symbols", ms: 200 }],
      [{ phase: "symbols", ms: 200 }],
      [{ phase: "symbols", ms: 200 }],
    ]);
    const s = robustScore(3_000, b.get("symbols")!)!;
    expect(s).toBeGreaterThan(6);
  });
});

describe("analyzePreflight", () => {
  it("reports normal when every step matches its baseline", () => {
    const r = analyzePreflight({
      phases: [p("saxo_refresh", 500), p("news", 3_050), p("prices", 2_100)],
      history: steadyHistory(),
      budgetMs: 55_000,
    });
    expect(r.anomalous).toBe(false);
    expect(r.culprit).toBeNull();
    expect(r.recommendation).toMatch(/Nothing to investigate/);
  });

  it("flags the slow step and names it in the recommendation", () => {
    const r = analyzePreflight({
      phases: [p("saxo_refresh", 520), p("news", 3_000), p("prices", 18_000)],
      history: steadyHistory(),
      budgetMs: 55_000,
    });
    expect(r.anomalous).toBe(true);
    expect(r.culprit?.phase).toBe("prices");
    expect(r.culprit?.severity).toBe("critical");
    expect(r.headline).toContain(phaseLabel("prices"));
    expect(r.recommendation).toContain("price_cache");
  });

  it("picks the worst step when several are degraded", () => {
    const r = analyzePreflight({
      phases: [p("saxo_refresh", 4_000), p("news", 25_000), p("prices", 2_000)],
      history: steadyHistory(),
      budgetMs: 55_000,
    });
    expect(r.culprit?.phase).toBe("news");
    expect(r.recommendation).toContain("feed");
  });

  it("flags a budget hog even without a baseline", () => {
    const r = analyzePreflight({
      phases: [p("regime", 30_000)],
      history: [],
      budgetMs: 55_000,
    });
    expect(r.anomalous).toBe(true);
    expect(r.culprit?.phase).toBe("regime");
    expect(r.culprit?.reason).toMatch(/% of the run budget/);
  });

  it("marks mild drift as watch, not an anomaly", () => {
    const r = analyzePreflight({
      phases: [p("news", 4_200), p("prices", 2_050)],
      history: steadyHistory(),
      budgetMs: 55_000,
    });
    expect(r.phases.find((x) => x.phase === "news")?.severity).toBe("watch");
    expect(r.anomalous).toBe(false);
    expect(r.culprit?.phase).toBe("news");
  });

  it("ignores skipped phases and portfolio ticks", () => {
    const r = analyzePreflight({
      phases: [p("news", 0, true, "preflight disabled"), p("ticks", 40_000), p("prices", 2_000)],
      history: steadyHistory(),
      budgetMs: 55_000,
    });
    expect(r.phases.map((x) => x.phase)).toEqual(["prices"]);
    expect(r.totalPreflightMs).toBe(2_000);
  });

  it("warns about skipping pre-flight when it eats most of the budget", () => {
    const r = analyzePreflight({
      phases: [p("prices", 20_000), p("news", 12_000)],
      history: steadyHistory(),
      budgetMs: 55_000,
    });
    expect(r.preflightBudgetShare).toBeGreaterThan(0.5);
    expect(r.recommendation).toMatch(/disabling pre-flight refresh/);
  });

  it("notes a failed step", () => {
    const r = analyzePreflight({
      phases: [p("saxo_refresh", 600, false, "failed")],
      history: steadyHistory(),
      budgetMs: 55_000,
    });
    expect(r.phases[0].reason).toContain("the step failed");
  });

  it("says the baseline is still building with too little history", () => {
    const r = analyzePreflight({
      phases: [p("prices", 2_000)],
      history: [[{ phase: "prices", ms: 2_000 }]],
      budgetMs: 55_000,
    });
    expect(r.headline).toMatch(/baseline still building/);
  });
  it("does not flag a fast sub-second phase that doubled against a tiny baseline", () => {
    // Regression: news at 260ms vs a 117ms median is 2.2x and scores hard, but
    // 0.26s cannot threaten the deadline — it must not read as an anomaly.
    const history = Array.from({ length: 10 }, (_, i) => [
      { phase: "news" as const, ms: 110 + (i % 4) * 5 },
    ]);
    const r = analyzePreflight({
      phases: [p("news", 260)],
      history,
      budgetMs: 55_000,
    });
    expect(r.phases[0].severity).toBe("ok");
    expect(r.anomalous).toBe(false);
    expect(r.culprit).toBeNull();
    expect(r.headline).not.toMatch(/anomaly/i);
    // The ratio is still reported for the dashboard, just not acted on.
    expect(r.phases[0].ratio).toBeGreaterThan(2);
  });

  it("still flags a slow phase once the regression is absolutely meaningful", () => {
    const history = Array.from({ length: 10 }, (_, i) => [
      { phase: "news" as const, ms: 110 + (i % 4) * 5 },
    ]);
    const r = analyzePreflight({
      phases: [p("news", 4_000)],
      history,
      budgetMs: 55_000,
    });
    expect(r.phases[0].severity).toBe("critical");
    expect(r.culprit?.phase).toBe("news");
  });

  it("keeps absolute-ceiling and budget-share flags independent of the noise floor", () => {
    const r = analyzePreflight({
      phases: [p("news", 13_000)],
      history: steadyHistory(),
      budgetMs: 55_000,
    });
    expect(r.phases[0].reason).toContain("ceiling");
    expect(r.anomalous).toBe(true);
  });
});
