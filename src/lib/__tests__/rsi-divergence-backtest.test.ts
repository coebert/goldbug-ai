import { describe, expect, it } from "vitest";

import {
  backtestRsiDivergences,
  divergenceBacktestVerdict,
} from "@/lib/rsi-divergence-backtest";
import { computeRsiSeries, type HistoryPoint } from "@/lib/market-symbol-history";
import { detectRsiDivergences } from "@/lib/rsi-divergence";

function build(closes: number[]): HistoryPoint[] {
  const rsi = computeRsiSeries(closes);
  return closes.map((close, i) => ({
    date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
    close,
    indexed: 100,
    sma20: null,
    sma50: null,
    sma100: null,
    sma200: null,
    rsi14: rsi[i] ?? null,
  }));
}

/**
 * A sharp slide (RSI pinned low), a bounce, then a gentler slide to a
 * marginally lower low — the textbook bullish divergence shape. `tail` is a
 * list of daily multipliers applied after the second pivot.
 */
function bullishTape(tail: number[]): HistoryPoint[] {
  const closes: number[] = [];
  let p = 200;
  for (let i = 0; i < 30; i++) {
    p *= 0.97;
    closes.push(p);
  }
  for (let i = 0; i < 8; i++) {
    p *= 1.02;
    closes.push(p);
  }
  for (let i = 0; i < 14; i++) {
    p *= 0.987;
    closes.push(p);
  }
  for (const m of tail) {
    p *= m;
    closes.push(p);
  }
  return build(closes.map((c) => Number(c.toFixed(4))));
}

const RISING_TAIL = [1.01, 1.02, 1.02, 1.02, 1.02, 1.02, 1.02, 1.02, 1.02, 1.02];
const BREAKDOWN_TAIL = [1.01, 1.02, 1.02, 0.96, 0.95, 0.95, 0.95, 0.95, 0.95, 0.95];

describe("backtestRsiDivergences", () => {
  it("returns an empty, well-formed result with no divergences", () => {
    const flat = build(Array.from({ length: 60 }, () => 100));
    const r = backtestRsiDivergences(flat);
    expect(r.trades).toHaveLength(0);
    expect(r.overall.trades).toBe(0);
    expect(r.overall.hitRate).toBe(0);
    expect(divergenceBacktestVerdict(r)).toMatch(/No confirmed divergences/);
  });

  it("never enters before the signal pivot is confirmed", () => {
    const points = bullishTape(RISING_TAIL);
    const divs = detectRsiDivergences(points, { lookaround: 3 });
    const r = backtestRsiDivergences(points, { lookaround: 3 });
    expect(divs.length).toBeGreaterThan(0);
    for (const t of r.trades) {
      const pivot = divs.find((d) => d.to.date === t.pivotDate);
      expect(pivot).toBeTruthy();
      const entryIndex = points.findIndex((p) => p.date === t.entryDate);
      expect(entryIndex).toBe((pivot as NonNullable<typeof pivot>).to.index + 3);
    }
  });

  it("marks a bullish divergence that runs to target as a reversal", () => {
    const points = bullishTape(RISING_TAIL);
    const r = backtestRsiDivergences(points, { targetPct: 3, horizon: 15, frictionBps: 0 });
    const bull = r.trades.filter((t) => t.kind === "bullish");
    expect(bull.length).toBeGreaterThan(0);
    expect(bull.some((t) => t.outcome === "reversal")).toBe(true);
    const win = bull.find((t) => t.outcome === "reversal") as NonNullable<
      (typeof bull)[number]
    >;
    expect(win.netReturn).toBeGreaterThan(0);
    expect(win.mfe).toBeGreaterThanOrEqual(0.03);
  });

  it("marks a bullish divergence that breaks its pivot low as failed", () => {
    const points = bullishTape(BREAKDOWN_TAIL);
    const r = backtestRsiDivergences(points, { targetPct: 3, horizon: 15, frictionBps: 0 });
    const bull = r.trades.filter((t) => t.kind === "bullish");
    expect(bull.length).toBeGreaterThan(0);
    expect(bull.every((t) => t.outcome !== "reversal")).toBe(true);
    expect(bull.some((t) => t.outcome === "failed")).toBe(true);
    expect(r.overall.failRate).toBeGreaterThan(0);
  });

  it("charges friction on every setup", () => {
    const points = bullishTape(RISING_TAIL);
    const free = backtestRsiDivergences(points, { frictionBps: 0 });
    const costly = backtestRsiDivergences(points, { frictionBps: 100 });
    expect(costly.trades).toHaveLength(free.trades.length);
    for (let i = 0; i < free.trades.length; i++) {
      expect(costly.trades[i].netReturn).toBeCloseTo(free.trades[i].netReturn - 0.01, 8);
    }
  });

  it("splits stats by direction and keeps counts consistent", () => {
    const points = bullishTape(RISING_TAIL);
    const r = backtestRsiDivergences(points);
    expect(r.bullish.trades + r.bearish.trades).toBe(r.overall.trades);
    expect(r.overall.hitRate + r.overall.failRate).toBeLessThanOrEqual(1);
  });

  it("skips divergences without enough forward tape to trade", () => {
    const points = bullishTape([1.01, 1.02, 1.02]);
    const r = backtestRsiDivergences(points, { lookaround: 3 });
    for (const t of r.trades) {
      const entryIndex = points.findIndex((p) => p.date === t.entryDate);
      expect(entryIndex).toBeLessThan(points.length - 1);
    }
  });
});
