import { describe as suite, it, expect } from "vitest";
import {
  generateEventStream,
  runMonteCarlo,
  runMonteCarloPath,
  pathSeed,
  describe as describeDist,
  percentile,
  formatMonteCarloReport,
  DEFAULT_EVENT_INTENSITIES,
  type MonteCarloConfig,
} from "@/lib/monte-carlo-events";
import { HARNESS_UNIVERSE } from "@/lib/backtest-event-harness";

const SYMBOLS = HARNESS_UNIVERSE.map((u) => u.symbol);

const baseConfig = (over: Partial<MonteCarloConfig> = {}): MonteCarloConfig => ({
  paths: 12,
  bars: 90,
  baseSeed: 20260803,
  options: { startingCash: 1000, riskLevel: "balanced" },
  ...over,
});

suite("monte carlo event generator", () => {
  it("is deterministic for a given seed", () => {
    const a = generateEventStream(1234, 250, SYMBOLS);
    const b = generateEventStream(1234, 250, SYMBOLS);
    expect(a).toEqual(b);
  });

  it("produces different streams for different seeds", () => {
    const a = generateEventStream(1, 250, SYMBOLS);
    const b = generateEventStream(2, 250, SYMBOLS);
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });

  it("keeps every event inside the tape and well-formed", () => {
    const events = generateEventStream(99, 300, SYMBOLS);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.barIndex).toBeGreaterThanOrEqual(0);
      expect(e.barIndex).toBeLessThan(300);
      expect(Number.isFinite(e.magnitude)).toBe(true);
      expect(e.durationBars).toBeGreaterThanOrEqual(1);
      if (e.symbols) {
        expect(e.symbols.length).toBeGreaterThan(0);
        for (const s of e.symbols) expect(SYMBOLS).toContain(s);
      }
    }
  });

  it("bounds magnitudes per kind", () => {
    const events = generateEventStream(7, 2000, SYMBOLS);
    for (const e of events) {
      if (e.kind === "liquidity_crunch") {
        expect(e.magnitude).toBeGreaterThan(0);
        expect(e.magnitude).toBeLessThanOrEqual(0.9);
      } else if (e.kind === "flash_crash") {
        expect(e.magnitude).toBeLessThan(0);
        expect(e.magnitude).toBeGreaterThanOrEqual(-0.85);
      } else if (e.kind === "melt_up") {
        expect(e.magnitude).toBeGreaterThan(0);
      } else {
        expect(Math.abs(e.magnitude)).toBeLessThanOrEqual(0.9);
      }
    }
  });

  it("respects arrival intensity — rarer kinds fire less often", () => {
    const events = generateEventStream(31337, 5040, SYMBOLS); // ~20 years
    const count = (k: string) => events.filter((e) => e.kind === k).length;
    expect(count("earnings_gap")).toBeGreaterThan(count("macro_shock"));
    expect(count("macro_shock")).toBeGreaterThan(count("flash_crash"));
    // ~20y at 1.1/yr => order of 22 macro shocks; allow wide sampling slack.
    expect(count("macro_shock")).toBeGreaterThan(5);
    expect(count("macro_shock")).toBeLessThan(60);
  });

  it("disables a kind when its rate is zero", () => {
    const events = generateEventStream(5, 2000, SYMBOLS, {
      ...DEFAULT_EVENT_INTENSITIES,
      flash_crash: { ...DEFAULT_EVENT_INTENSITIES.flash_crash, ratePerYear: 0 },
    });
    expect(events.some((e) => e.kind === "flash_crash")).toBe(false);
  });

  it("derives stable, distinct per-path seeds", () => {
    const seeds = Array.from({ length: 200 }, (_, i) => pathSeed(777, i));
    expect(new Set(seeds).size).toBe(200);
    expect(pathSeed(777, 5)).toBe(seeds[5]);
  });
});

suite("distribution helpers", () => {
  it("computes percentiles by linear interpolation", () => {
    const xs = [0, 10, 20, 30, 40];
    expect(percentile(xs, 0)).toBe(0);
    expect(percentile(xs, 0.5)).toBe(20);
    expect(percentile(xs, 1)).toBe(40);
    expect(percentile(xs, 0.25)).toBe(10);
  });

  it("describes a sample without NaN", () => {
    const d = describeDist([1, 2, 3, 4, 5, Number.NaN]);
    expect(d.n).toBe(5);
    expect(d.median).toBe(3);
    expect(d.min).toBe(1);
    expect(d.max).toBe(5);
    expect(Number.isFinite(d.std)).toBe(true);
  });

  it("handles the empty sample", () => {
    expect(describeDist([]).n).toBe(0);
  });
});

suite("monte carlo sweep", () => {
  it("runs paths deterministically and reproduces identical reports", async () => {
    const a = await runMonteCarlo(baseConfig({ paths: 6 }));
    const b = await runMonteCarlo(baseConfig({ paths: 6 }));
    expect(a.paths.map((p) => p.totalReturnPct)).toEqual(
      b.paths.map((p) => p.totalReturnPct),
    );
    expect(a.risk).toEqual(b.risk);
  }, 60_000);

  it("produces finite, ordered distributional statistics", async () => {
    const report = await runMonteCarlo(baseConfig({ paths: 16 }));
    const d = report.distributions.totalReturnPct;
    expect(d.n).toBe(16);
    expect(d.min).toBeLessThanOrEqual(d.p5);
    expect(d.p5).toBeLessThanOrEqual(d.median);
    expect(d.median).toBeLessThanOrEqual(d.p95);
    expect(d.p95).toBeLessThanOrEqual(d.max);
    for (const v of Object.values(d)) expect(Number.isFinite(v)).toBe(true);
    expect(report.distributions.maxDrawdownPct.max).toBeLessThanOrEqual(0);
  }, 60_000);

  it("keeps probabilities in [0,100] and CVaR at least as bad as VaR", async () => {
    const report = await runMonteCarlo(baseConfig({ paths: 24 }));
    const r = report.risk;
    for (const key of [
      "probLossPct",
      "probRuinPct",
      "probDrawdownWorseThan20Pct",
      "probDrawdownWorseThan35Pct",
    ] as const) {
      expect(r[key]).toBeGreaterThanOrEqual(0);
      expect(r[key]).toBeLessThanOrEqual(100);
    }
    expect(r.cvar95Pct).toBeGreaterThanOrEqual(r.var95Pct - 1e-9);
    expect(r.var99Pct).toBeGreaterThanOrEqual(r.var95Pct - 1e-9);
  }, 60_000);

  it("never lets a path borrow — equity and cash stay non-negative", async () => {
    const report = await runMonteCarlo(baseConfig({ paths: 12 }));
    for (const p of report.paths) {
      expect(p.endingEquity).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(p.sharpe)).toBe(true);
      expect(p.maxDrawdownPct).toBeLessThanOrEqual(0);
    }
  }, 60_000);

  it("passes the full invariant audit on every audited path", async () => {
    const report = await runMonteCarlo(baseConfig({ paths: 10, audit: true }));
    expect(report.invariantFailures).toEqual([]);
    expect(report.config.audited).toBe(true);
  }, 90_000);

  it("identifies worst and best paths consistently with the distribution", async () => {
    const report = await runMonteCarlo(baseConfig({ paths: 16 }));
    expect(report.worstPath?.totalReturnPct).toBeCloseTo(
      report.distributions.totalReturnPct.min,
      6,
    );
    expect(report.bestPath?.totalReturnPct).toBeCloseTo(
      report.distributions.totalReturnPct.max,
      6,
    );
  }, 60_000);

  it("reports progress and formats a readable summary", async () => {
    const seen: number[] = [];
    const report = await runMonteCarlo(baseConfig({ paths: 8 }), (done) =>
      seen.push(done),
    );
    expect(seen[seen.length - 1]).toBe(8);
    const text = formatMonteCarloReport(report);
    expect(text).toContain("Monte Carlo");
    expect(text).toContain("VaR95");
    expect(text).not.toContain("NaN");
  }, 60_000);

  it("higher risk widens the terminal-return distribution", async () => {
    const cons = await runMonteCarlo(
      baseConfig({ paths: 12, options: { startingCash: 1000, riskLevel: "conservative" } }),
    );
    const aggr = await runMonteCarlo(
      baseConfig({ paths: 12, options: { startingCash: 1000, riskLevel: "aggressive" } }),
    );
    expect(aggr.distributions.totalReturnPct.std).toBeGreaterThanOrEqual(
      cons.distributions.totalReturnPct.std - 1e-9,
    );
  }, 120_000);

  it("a single path is reproducible in isolation", async () => {
    const cfg = baseConfig();
    const a = await runMonteCarloPath(3, cfg);
    const b = await runMonteCarloPath(3, cfg);
    expect(a).toEqual(b);
  }, 60_000);
});
