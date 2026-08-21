// Locks the behaviour the revised cost governor + FX leg are supposed to have:
// an exhausted friction window must never become a permanent stop, and a
// foreign-currency buy must not die on decimal precision.

import { describe, it, expect } from "vitest";
import {
  compareGovernorArms,
  runGovernorReplay,
  simulateFxLeg,
  DEFAULT_FX_RULE,
  type ReplayBar,
} from "../backtest/governor-replay";

/** Deterministic trending tape: a slow uptrend with shallow pullbacks. */
function tape(bars: number, symbols: string[], seed = 7): ReplayBar[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5);
  const px: Record<string, number> = {};
  for (const sym of symbols) px[sym] = 100 + symbols.indexOf(sym) * 10;
  const out: ReplayBar[] = [];
  for (let i = 0; i < bars; i += 1) {
    const closes: Record<string, number> = {};
    for (const sym of symbols) {
      px[sym] = Math.max(1, px[sym]! * (1 + 0.0009 + rnd() * 0.012));
      closes[sym] = Number(px[sym]!.toFixed(4));
    }
    const d = new Date(Date.UTC(2022, 0, 3) + i * 86_400_000);
    out.push({ date: d.toISOString().slice(0, 10), closes });
  }
  return out;
}

const SYMBOLS = ["AAA", "BBB", "CCC", "DDD"];

describe("FX funding leg", () => {
  it("legacy posts the raw float and Saxo rejects the decimals", () => {
    const leg = simulateFxLeg(1236.437219, DEFAULT_FX_RULE, "legacy");
    expect(leg.ok).toBe(false);
    expect(leg.reason).toMatch(/decimals/i);
  });

  it("revised floors to the pair's decimals and funds the buy", () => {
    const leg = simulateFxLeg(1236.437219, DEFAULT_FX_RULE, "revised");
    expect(leg.ok).toBe(true);
    expect(leg.amount).toBe(1236.43);
  });

  it("revised still refuses a sub-minimum leg, with an actionable reason", () => {
    const leg = simulateFxLeg(12.5, DEFAULT_FX_RULE, "revised");
    expect(leg.ok).toBe(false);
    expect(leg.reason).toMatch(/minimum/);
  });
});

describe("governor replay", () => {
  const bars = tape(400, SYMBOLS);

  it("the FX fix converts rejected foreign buys into fills", () => {
    const cmp = compareGovernorArms(bars, { foreignSymbols: SYMBOLS, signal: "churn" });
    expect(cmp.legacy.fxLegsRejected).toBeGreaterThan(0);
    expect(cmp.revised.fxLegsRejected).toBe(0);
    expect(cmp.revised.buysAdmitted).toBeGreaterThan(cmp.legacy.buysAdmitted);
  });

  it("an exhausted friction window never becomes a permanent stop", () => {
    const opts = { signal: "churn" as const, seedFrictionBase: 175 };
    const legacy = runGovernorReplay(bars, "legacy", opts);
    const revised = runGovernorReplay(bars, "revised", opts);
    expect(revised.longestIdleStreakDays).toBeLessThan(legacy.longestIdleStreakDays);
    expect(revised.barsToFirstBuy!).toBeLessThanOrEqual(legacy.barsToFirstBuy!);
    expect(revised.buysBlocked).toBeLessThan(legacy.buysBlocked);
    // …and the trades it unblocks are the ones that would have paid.
    expect(revised.profitableBlockedPnl).toBeLessThan(legacy.profitableBlockedPnl);
  });

  it("unblocking does not come at the cost of a worse drawdown", () => {
    const cmp = compareGovernorArms(bars, { signal: "churn", seedFrictionBase: 175 });
    expect(cmp.revised.maxDrawdownPct).toBeLessThanOrEqual(cmp.legacy.maxDrawdownPct + 1.5);
    expect(cmp.verdict).not.toBe("revised_worse");
  });

  it("sells are never gated, whatever the budget state", () => {
    const out = runGovernorReplay(bars, "revised", { signal: "churn", seedFrictionBase: 5_000 });
    expect(out.trades.length).toBeGreaterThan(0);
    expect(out.equityCurve.at(-1)!.equity).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const a = runGovernorReplay(bars, "revised", { signal: "churn" });
    const b = runGovernorReplay(bars, "revised", { signal: "churn" });
    expect(a.equityCurve).toEqual(b.equityCurve);
    expect(a.trades).toEqual(b.trades);
  });
});
