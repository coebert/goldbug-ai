import { describe, expect, it } from "vitest";

import { atrPctFromBars, runRuleWhatIf, type WhatIfBar } from "@/lib/backtest/rule-what-if";

function bars(closes: number[], spread = 0.005): WhatIfBar[] {
  const start = Date.UTC(2026, 0, 5);
  return closes.map((c, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    open: c,
    high: c * (1 + spread),
    low: c * (1 - spread),
    close: c,
  }));
}

const CFG = { stop_loss_pct: 0.05, take_profit_pct: 0.1, max_hold_days: 10 };

describe("atrPctFromBars", () => {
  it("returns null without enough bars and a positive fraction otherwise", () => {
    expect(atrPctFromBars([])).toBeNull();
    const a = atrPctFromBars(bars([100, 101, 102, 103, 104], 0.02));
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(0.1);
  });
});

describe("runRuleWhatIf", () => {
  it("returns null when history is too short", () => {
    expect(runRuleWhatIf({ symbol: "X", bars: bars([100, 101]), config: CFG })).toBeNull();
  });

  it("hits the profit target on a steady uptrend", () => {
    const r = runRuleWhatIf({
      symbol: "UP",
      bars: bars([100, 102, 104, 107, 110, 113, 116, 120]),
      config: CFG,
    })!;
    expect(r.trades.length).toBeGreaterThan(0);
    expect(r.trades[0]!.reason).toBe("target");
    expect(r.summary.totalReturnPct).toBeGreaterThan(0);
    expect(r.buyHoldPct).toBeGreaterThan(0);
  });

  it("stops out on a steady downtrend and never loses more than the stop plus slack", () => {
    const r = runRuleWhatIf({
      symbol: "DOWN",
      bars: bars([100, 97, 94, 90, 86, 82, 78, 74]),
      config: CFG,
    })!;
    expect(r.trades.every((t) => t.reason === "stop" || t.reason === "open")).toBe(true);
    expect(r.summary.totalReturnPct).toBeLessThan(0);
    expect(r.summary.maxDrawdownPct).toBeGreaterThan(0);
    for (const t of r.trades) expect(t.returnPct).toBeGreaterThan(-0.2);
  });

  it("exits on max hold when price goes nowhere", () => {
    const flat = Array.from({ length: 40 }, (_, i) => 100 + (i % 2 === 0 ? 0.2 : -0.2));
    const r = runRuleWhatIf({ symbol: "FLAT", bars: bars(flat, 0.001), config: CFG })!;
    expect(r.summary.exitMix.max_hold).toBeGreaterThan(0);
    expect(r.rules.maxHoldDays).toBe(10);
  });

  it("prefers the adverse level when a bar spans both stop and target", () => {
    const b = bars([100, 100]);
    b.push({ date: "2026-01-07", open: 100, high: 130, low: 80, close: 120 });
    b.push({ date: "2026-01-08", open: 120, high: 121, low: 119, close: 120 });
    b.push({ date: "2026-01-09", open: 120, high: 121, low: 119, close: 120 });
    const r = runRuleWhatIf({ symbol: "GAP", bars: b, config: CFG })!;
    expect(r.trades[0]!.reason).toBe("stop");
  });

  it("uses a trailing stop once configured", () => {
    const r = runRuleWhatIf({
      symbol: "TRAIL",
      bars: bars([100, 104, 108, 112, 108, 104, 100, 96]),
      config: { stop_loss_pct: 0.2, take_profit_enabled: false, atr_trailing_mult: 1, max_hold_days: 30 },
    })!;
    expect(r.rules.trailingPct).toBeGreaterThan(0);
    expect(r.summary.exitMix.trailing + r.summary.exitMix.stop).toBeGreaterThan(0);
  });

  it("summarises consistently with the trade list", () => {
    const r = runRuleWhatIf({
      symbol: "MIX",
      bars: bars([100, 105, 96, 101, 110, 99, 104, 112, 101, 96, 105]),
      config: CFG,
    })!;
    const total = r.trades.reduce((s, t) => s + t.returnPct, 0);
    expect(r.summary.totalReturnPct).toBeCloseTo(total, 10);
    expect(r.summary.trades).toBe(r.trades.length);
    expect(r.equity).toHaveLength(r.trades.length);
    expect(r.summary.wins + r.summary.losses).toBe(r.trades.length);
  });
});
