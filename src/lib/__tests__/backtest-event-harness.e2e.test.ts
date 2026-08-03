import { describe, it, expect } from "vitest";
import {
  auditBacktest,
  buildEventTape,
  defaultHarnessScenarios,
  diffRunsPerDay,
  runHarnessScenario,
  HARNESS_UNIVERSE,
  DEFAULT_HARNESS_CAPS,
  type HarnessScenario,
} from "../backtest-event-harness";
import { runAiBacktest } from "../ai-backtest";

const scenarios = defaultHarnessScenarios();

function describeViolations(v: { rule: string; date: string; detail: string }[]) {
  return v.slice(0, 5).map((x) => `${x.date} ${x.rule}: ${x.detail}`).join("\n");
}

describe("backtest event harness (e2e)", () => {
  it.each(scenarios.map((s) => [s.name, s] as const))(
    "%s: holds every cap and invariant, and is deterministic per day",
    async (_name, scenario) => {
      const outcome = await runHarnessScenario(scenario as HarnessScenario);
      expect(describeViolations(outcome.audit.violations)).toBe("");
      expect(describeViolations(outcome.determinism)).toBe("");
      expect(outcome.ok).toBe(true);
      expect(outcome.audit.days).toBe(scenario.bars);
      expect(outcome.audit.peakNameConcentration).toBeLessThanOrEqual(
        DEFAULT_HARNESS_CAPS.maxNamePctOfNav + 1e-9,
      );
    },
    60_000,
  );

  it("actually trades through the event streams (the harness isn't vacuous)", async () => {
    const outcomes = await Promise.all(
      scenarios.map((s) => runHarnessScenario(s)),
    );
    const totalFills = outcomes.reduce((a, o) => a + o.audit.fills, 0);
    expect(totalFills).toBeGreaterThan(10);
    for (const o of outcomes) {
      expect(o.run.equityCurve.at(-1)!.totalValue).toBeGreaterThan(0);
    }
  }, 120_000);

  it("event tape applies shocks to prices and thins the book on a crunch", () => {
    const clean = buildEventTape(HARNESS_UNIVERSE, 60, 99, []);
    const shocked = buildEventTape(HARNESS_UNIVERSE, 60, 99, [
      { kind: "macro_shock", barIndex: 30, magnitude: -0.5 },
      { kind: "liquidity_crunch", barIndex: 30, magnitude: 0.01, durationBars: 5 },
    ]);
    expect(shocked.bars[29].closes.MEGA).toBeCloseTo(clean.bars[29].closes.MEGA, 6);
    expect(shocked.bars[31].closes.MEGA).toBeLessThan(clean.bars[31].closes.MEGA * 0.6);
    expect(shocked.volumes[31].MEGA).toBeLessThan(clean.volumes[31].MEGA * 0.1);
    expect(shocked.volumes[40].MEGA).toBe(clean.volumes[40].MEGA);
    for (const bar of shocked.bars) {
      for (const px of Object.values(bar.closes)) expect(px).toBeGreaterThan(0);
    }
  });

  it("audits every risk level with its own sleeve caps", async () => {
    for (const riskLevel of ["conservative", "balanced", "aggressive"] as const) {
      const outcome = await runHarnessScenario({
        ...scenarios[1],
        name: `macro-${riskLevel}`,
        options: { ...scenarios[1].options, riskLevel, startingCash: 1000 },
      });
      expect(describeViolations(outcome.audit.violations)).toBe("");
      expect(outcome.ok).toBe(true);
    }
  }, 120_000);

  it("detects a no-short violation when the trade log is tampered with", async () => {
    const tape = buildEventTape(HARNESS_UNIVERSE, 200, 555, []);
    const run = await runAiBacktest(tape.bars);
    const buy = run.tradeLog.find((t) => t.side === "buy");
    expect(buy).toBeDefined();
    const tampered = {
      ...run,
      tradeLog: run.tradeLog.map((t) =>
        t === buy ? { ...t, side: "sell" as const } : t,
      ),
    };
    const audit = auditBacktest(tampered, tape.bars);
    expect(audit.ok).toBe(false);
    expect(audit.violations.some((v) => v.rule === "no_short")).toBe(true);
  }, 60_000);

  it("detects a ledger-parity break when reported cash is wrong", async () => {
    const tape = buildEventTape(HARNESS_UNIVERSE, 160, 606, []);
    const run = await runAiBacktest(tape.bars);
    const idx = run.equityCurve.findIndex((p) => p.trades > 0);
    expect(idx).toBeGreaterThan(-1);
    const curve = run.equityCurve.map((p, i) =>
      i === idx ? { ...p, cash: p.cash + 500, totalValue: p.totalValue + 500 } : p,
    );
    const audit = auditBacktest({ ...run, equityCurve: curve }, tape.bars);
    expect(audit.violations.some((v) => v.rule === "ledger_parity")).toBe(true);
  }, 60_000);

  it("detects non-determinism between two diverging runs", async () => {
    const tape = buildEventTape(HARNESS_UNIVERSE, 150, 808, []);
    const a = await runAiBacktest(tape.bars, { riskLevel: "conservative" });
    const b = await runAiBacktest(tape.bars, { riskLevel: "aggressive" });
    expect(diffRunsPerDay(a, a)).toEqual([]);
    expect(diffRunsPerDay(a, b).length).toBeGreaterThan(0);
  }, 60_000);
});
