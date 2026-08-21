import { describe, it, expect } from "vitest";
import {
  STRESS_WINDOWS,
  sliceStressWindow,
  volStats,
} from "../backtest/stress-windows";
import { runGovernorReplay, type ReplayBar } from "../backtest/governor-replay";

const dates = (n: number, start = "2020-01-01") => {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < n; i += 1) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
};

describe("stress windows", () => {
  it("declares unique, well-ordered windows", () => {
    const ids = new Set(STRESS_WINDOWS.map((w) => w.id));
    expect(ids.size).toBe(STRESS_WINDOWS.length);
    for (const w of STRESS_WINDOWS) expect(w.from < w.to).toBe(true);
  });

  it("prepends warm-up bars and reports where the window starts", () => {
    const ds = dates(400);
    const loc = sliceStressWindow(ds, { from: ds[300]!, to: ds[350]! }, 210);
    expect(loc).not.toBeNull();
    expect(loc!.start).toBe(300);
    expect(loc!.end).toBe(350);
    expect(loc!.sliceStart).toBe(90);
    expect(loc!.tradeFromIndex).toBe(210);
  });

  it("clamps warm-up when the tape starts inside the window", () => {
    const ds = dates(50);
    const loc = sliceStressWindow(ds, { from: ds[0]!, to: ds[49]! }, 210);
    expect(loc!.sliceStart).toBe(0);
    expect(loc!.tradeFromIndex).toBe(0);
  });

  it("returns null when the window is outside the tape", () => {
    expect(sliceStressWindow(dates(10), { from: "2099-01-01", to: "2099-06-01" })).toBeNull();
  });

  it("measures realised volatility and drawdown", () => {
    const calm = volStats([100, 100.1, 100.2, 100.3, 100.4]);
    const wild = volStats([100, 90, 105, 80, 95]);
    expect(wild.annualisedVolPct).toBeGreaterThan(calm.annualisedVolPct);
    expect(wild.worstDayPct).toBeLessThan(-10);
    expect(wild.drawdownPct).toBeCloseTo(23.81, 1);
    expect(calm.bigMoveDaysPct).toBe(0);
    expect(volStats([]).annualisedVolPct).toBe(0);
  });
});

describe("tradeFromIndex", () => {
  const bars: ReplayBar[] = dates(400).map((date, i) => ({
    // Steady uptrend so SMA20/50 is long throughout and the arm would trade
    // on every allowed bar.
    closes: { AAA: 100 * (1 + i / 400) },
    date,
  }));

  it("suppresses trading and P&L before the window opens", () => {
    const warm = runGovernorReplay(bars, "revised", { tradeFromIndex: 300, signal: "churn" });
    expect(warm.equityCurve).toHaveLength(100);
    expect(warm.equityCurve[0]!.date).toBe(bars[300]!.date);
    expect(warm.barsToFirstBuy).toBeGreaterThanOrEqual(300);
  });

  it("matches an unwindowed run when the window is the whole tape", () => {
    const a = runGovernorReplay(bars, "revised", { signal: "churn" });
    const b = runGovernorReplay(bars, "revised", { tradeFromIndex: 0, signal: "churn" });
    expect(b.totalReturnPct).toBeCloseTo(a.totalReturnPct, 10);
    expect(b.buysAdmitted).toBe(a.buysAdmitted);
  });
});
