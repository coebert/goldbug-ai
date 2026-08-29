import { describe, it, expect } from "vitest";
import { evaluateFxLegPlaybook, FX_PLAYBOOK } from "../fx-leg-playbook";
import { runFxPlaybookBacktest, legPnlPct } from "../fx-playbook-backtest";

const base = {
  symbol: "GBPUSD",
  quantity: -10_000,
  avgCost: 1.3,
  rate: 1.3,
  pnlQuote: 0,
  notionalQuote: 13_000,
  stale: false,
  rateAgeMinutes: 2,
};

describe("evaluateFxLegPlaybook", () => {
  it("keeps a leg inside the band", () => {
    const v = evaluateFxLegPlaybook({ ...base, pnlQuote: 50 });
    expect(v.action).toBe("keep");
  });

  it("cuts past the -1.5% line", () => {
    const v = evaluateFxLegPlaybook({ ...base, pnlQuote: -0.02 * 13_000 });
    expect(v.action).toBe("close_loss");
    expect(v.signals.find((s) => s.id === "stop_line")?.triggered).toBe(true);
  });

  it("takes profit past the +2.0% line", () => {
    const v = evaluateFxLegPlaybook({ ...base, pnlQuote: 0.025 * 13_000 });
    expect(v.action).toBe("close_profit");
  });

  it("never acts on a stale mark", () => {
    const v = evaluateFxLegPlaybook({
      ...base,
      pnlQuote: -0.05 * 13_000,
      stale: true,
    });
    expect(v.action).toBe("hold_stale");
  });

  it("treats an old rate as stale even when the feed says otherwise", () => {
    const v = evaluateFxLegPlaybook({
      ...base,
      rateAgeMinutes: FX_PLAYBOOK.staleMinutes + 1,
    });
    expect(v.action).toBe("hold_stale");
  });

  it("unwinds an orphaned leg before P&L rules", () => {
    const v = evaluateFxLegPlaybook({ ...base, orphaned: true, pnlQuote: 0.03 * 13_000 });
    expect(v.action).toBe("unwind_orphan");
  });
});

describe("runFxPlaybookBacktest", () => {
  it("short leg profits when the base currency falls", () => {
    expect(legPnlPct("short", 1.3, 1.2)).toBeGreaterThan(0);
    expect(legPnlPct("long", 1.3, 1.2)).toBeLessThan(0);
  });

  it("records a take-profit exit and charges costs", () => {
    const bars = [
      { date: "2024-01-01", rate: 1.3 },
      { date: "2024-01-02", rate: 1.29 },
      { date: "2024-01-03", rate: 1.25 },
    ];
    const r = runFxPlaybookBacktest("GBPUSD", bars, { side: "short", costBps: 10, cooldownDays: 1 });
    expect(r.trades[0]?.reason).toBe("take_profit");
    expect(r.trades[0]!.pnlPct).toBeCloseTo(legPnlPct("short", 1.3, 1.25) - 0.001, 6);
    expect(r.hitTakeProfit).toBe(1);
  });

  it("reports a drawdown when stops chain together", () => {
    const bars = [
      { date: "2024-01-01", rate: 1.0 },
      { date: "2024-01-02", rate: 1.02 },
      { date: "2024-01-03", rate: 1.04 },
      { date: "2024-01-04", rate: 1.06 },
      { date: "2024-01-05", rate: 1.08 },
      { date: "2024-01-06", rate: 1.1 },
    ];
    const r = runFxPlaybookBacktest("GBPUSD", bars, { side: "short", cooldownDays: 1 });
    expect(r.hitStopLoss).toBeGreaterThan(0);
    expect(r.maxDrawdownPct).toBeGreaterThan(0);
    expect(r.totalReturnPct).toBeLessThan(0);
    expect(r.equityCurve.length).toBe(r.tradeCount);
  });

  it("is empty-safe", () => {
    const r = runFxPlaybookBacktest("GBPUSD", []);
    expect(r.tradeCount).toBe(0);
    expect(r.maxDrawdownPct).toBe(0);
  });
});
