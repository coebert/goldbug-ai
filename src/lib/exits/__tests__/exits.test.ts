import { describe, it, expect } from "vitest";
import {
  evaluateChandelier,
  evaluateScaleOut,
  DEFAULT_SCALE_OUT_LEVELS,
  evaluateTimeStop,
  evaluateEventBlackout,
  reentryLockoutDays,
} from "../index";

describe("evaluateChandelier", () => {
  it("does not breach when price is at HWM", () => {
    const r = evaluateChandelier({
      avgCost: 100, price: 120, highWaterMark: 120, atrPct: 0.02,
      initialStopAtrMult: 2.5, kBase: 3, kTight: 1.5, tightenAfterR: 2,
    });
    expect(r.breached).toBe(false);
    expect(r.stopPrice).toBeLessThan(120);
  });
  it("tightens k as unrealised R grows", () => {
    const early = evaluateChandelier({
      avgCost: 100, price: 105, highWaterMark: 105, atrPct: 0.02,
      initialStopAtrMult: 2.5, kBase: 3, kTight: 1.5, tightenAfterR: 2,
    });
    const late = evaluateChandelier({
      avgCost: 100, price: 130, highWaterMark: 130, atrPct: 0.02,
      initialStopAtrMult: 2.5, kBase: 3, kTight: 1.5, tightenAfterR: 2,
    });
    expect(late.effectiveK).toBeLessThan(early.effectiveK);
    expect(late.effectiveK).toBeCloseTo(1.5, 5);
  });
  it("breaches when price falls below the trail", () => {
    const r = evaluateChandelier({
      avgCost: 100, price: 100, highWaterMark: 120, atrPct: 0.02,
      initialStopAtrMult: 2.5, kBase: 3, kTight: 1.5, tightenAfterR: 2,
    });
    expect(r.breached).toBe(true);
  });
});

describe("evaluateScaleOut", () => {
  it("fires L1 at +1R", () => {
    const r = evaluateScaleOut({
      avgCost: 100, price: 105, atrPct: 0.02, initialStopAtrMult: 2.5,
      levels: DEFAULT_SCALE_OUT_LEVELS, levelsAlreadyTaken: 0,
    });
    // 1R = 100 * 2.5 * 0.02 = 5, so price 105 = 1R
    expect(r.fire).toBe(true);
    expect(r.levelIndex).toBe(0);
    expect(r.sellFraction).toBeCloseTo(0.25);
  });
  it("does not double-fire the same level", () => {
    const r = evaluateScaleOut({
      avgCost: 100, price: 108, atrPct: 0.02, initialStopAtrMult: 2.5,
      levels: DEFAULT_SCALE_OUT_LEVELS, levelsAlreadyTaken: 1,
    });
    // levelsAlreadyTaken=1 means L1 done; L2 needs 2R = price 110
    expect(r.fire).toBe(false);
  });
  it("fires L2 at +2R once L1 is done", () => {
    const r = evaluateScaleOut({
      avgCost: 100, price: 111, atrPct: 0.02, initialStopAtrMult: 2.5,
      levels: DEFAULT_SCALE_OUT_LEVELS, levelsAlreadyTaken: 1,
    });
    expect(r.fire).toBe(true);
    expect(r.levelIndex).toBe(1);
  });
  it("stops firing after all levels taken", () => {
    const r = evaluateScaleOut({
      avgCost: 100, price: 200, atrPct: 0.02, initialStopAtrMult: 2.5,
      levels: DEFAULT_SCALE_OUT_LEVELS, levelsAlreadyTaken: 2,
    });
    expect(r.fire).toBe(false);
  });
});

describe("evaluateTimeStop", () => {
  const day = 86_400_000;
  it("does not trigger before horizon elapses", () => {
    const r = evaluateTimeStop({
      avgCost: 100, price: 101, atrPct: 0.02, initialStopAtrMult: 2.5,
      openedAtMs: 1_000 * day, nowMs: 1_010 * day, horizonDays: 30, minProgressR: 0.5,
    });
    expect(r.triggered).toBe(false);
  });
  it("triggers when horizon elapsed and R < min progress", () => {
    const r = evaluateTimeStop({
      avgCost: 100, price: 101, atrPct: 0.02, initialStopAtrMult: 2.5,
      openedAtMs: 1_000 * day, nowMs: 1_040 * day, horizonDays: 30, minProgressR: 0.5,
    });
    expect(r.triggered).toBe(true);
  });
  it("does not trigger when R progress exceeds min", () => {
    const r = evaluateTimeStop({
      avgCost: 100, price: 110, atrPct: 0.02, initialStopAtrMult: 2.5,
      openedAtMs: 1_000 * day, nowMs: 1_040 * day, horizonDays: 30, minProgressR: 0.5,
    });
    expect(r.triggered).toBe(false);
  });
});

describe("evaluateEventBlackout", () => {
  it("trims oversized position ahead of a matching earnings event", () => {
    const r = evaluateEventBlackout({
      symbol: "AAPL", positionValue: 800, portfolioValue: 10_000,
      events: [{ event_date: "2026-08-01", impact: "high", kind: "earnings", symbol: "AAPL" }],
      asOf: "2026-07-30", windowDays: 3, blackoutPctNav: 0.05, targetPctNav: 0.03,
      highImpactOnly: true,
    });
    expect(r.trim).toBe(true);
    // 8% -> 3% => trim 5/8 = 0.625
    expect(r.sellFraction).toBeCloseTo(0.625, 3);
  });
  it("triggers on macro events (no symbol) for any large position", () => {
    const r = evaluateEventBlackout({
      symbol: "SPY", positionValue: 600, portfolioValue: 10_000,
      events: [{ event_date: "2026-08-02", impact: "critical", kind: "fomc", symbol: null }],
      asOf: "2026-07-30", windowDays: 5, blackoutPctNav: 0.05, targetPctNav: 0.03,
      highImpactOnly: true,
    });
    expect(r.trim).toBe(true);
  });
  it("does nothing when position is under threshold", () => {
    const r = evaluateEventBlackout({
      symbol: "AAPL", positionValue: 100, portfolioValue: 10_000,
      events: [{ event_date: "2026-08-01", impact: "high", kind: "earnings", symbol: "AAPL" }],
      asOf: "2026-07-30", windowDays: 3, blackoutPctNav: 0.05, targetPctNav: 0.03,
      highImpactOnly: true,
    });
    expect(r.trim).toBe(false);
  });
});

describe("reentryLockoutDays", () => {
  it("returns at least the base cooldown for low-vol names", () => {
    const d = reentryLockoutDays({
      atrPct: 0.005, baseCooldownDays: 5, atrDaysMult: 0.05, minDays: 3, maxDays: 60,
    });
    expect(d).toBeGreaterThanOrEqual(10);
  });
  it("stays inside min/max envelope", () => {
    const d = reentryLockoutDays({
      atrPct: 0.5, baseCooldownDays: 5, atrDaysMult: 0.05, minDays: 3, maxDays: 60,
    });
    expect(d).toBeGreaterThanOrEqual(3);
    expect(d).toBeLessThanOrEqual(60);
  });
});
