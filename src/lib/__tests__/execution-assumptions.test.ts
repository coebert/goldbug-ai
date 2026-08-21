import { describe, it, expect } from "vitest";
import {
  ASSUMPTION_PRESETS,
  assumptionsFromFlags,
  describeAssumptions,
  impactBpsFor,
  LIVE_MODEL_ASSUMPTIONS,
  priceTicket,
  resolveAssumptions,
  spreadBpsFor,
} from "../backtest/execution-assumptions";
import { estimateTradeCosts } from "../trade-viability-gate";

const ticket = { symbol: "VUSA.L", side: "buy" as const, quantity: 20, price: 70 };

describe("resolveAssumptions", () => {
  it("defaults to the live model so existing backtests are unchanged", () => {
    expect(resolveAssumptions()).toEqual(LIVE_MODEL_ASSUMPTIONS);
  });

  it("accepts a preset id or a partial override on top of a preset", () => {
    expect(resolveAssumptions("pessimistic").spreadBps).toBe(30);
    const a = resolveAssumptions({ spreadBps: 22 }, "realistic");
    expect(a.spreadBps).toBe(22);
    expect(a.slippageBps).toBe(ASSUMPTION_PRESETS.realistic.slippageBps);
  });

  it("never lets a bad value poison a run", () => {
    const a = resolveAssumptions({
      spreadBps: Number.NaN,
      slippageBps: -5,
      impactRefNotionalBase: 0,
    });
    expect(a.spreadBps).toBe(10);
    expect(a.slippageBps).toBe(0);
    expect(a.impactRefNotionalBase).toBeGreaterThan(0);
  });

  it("supports per-symbol spread overrides, case-insensitively", () => {
    const a = resolveAssumptions({ spreadBps: 10, spreadBpsBySymbol: { "mks.l": 45 } });
    expect(spreadBpsFor(a, "MKS.L")).toBe(45);
    expect(spreadBpsFor(a, "VUSA.L")).toBe(10);
  });
});

describe("priceTicket", () => {
  it("reproduces the live estimator exactly under the live preset", () => {
    const priced = priceTicket(ticket, resolveAssumptions("live"));
    const live = estimateTradeCosts({ ...ticket, spreadBps: 10 });
    expect(priced.totalCost).toBeCloseTo(live.oneWayCost, 10);
    expect(priced.roundTripBps).toBeCloseTo(live.roundTripBps, 10);
    expect(priced.fillPrice).toBeCloseTo(70 * (1 + 5 / 10_000), 10);
  });

  it("charges more as the assumptions get harsher", () => {
    const cheap = priceTicket(ticket, resolveAssumptions("optimistic")).totalBps;
    const mid = priceTicket(ticket, resolveAssumptions("realistic")).totalBps;
    const nasty = priceTicket(ticket, resolveAssumptions("pessimistic")).totalBps;
    expect(cheap).toBeLessThan(mid);
    expect(mid).toBeLessThan(nasty);
  });

  it("moves the fill price against the side being traded", () => {
    const a = resolveAssumptions({ spreadBps: 20, slippageBps: 5 });
    const buy = priceTicket({ ...ticket, side: "buy" }, a);
    const sell = priceTicket({ ...ticket, side: "sell" }, a);
    expect(buy.fillPrice).toBeGreaterThan(70);
    expect(sell.fillPrice).toBeLessThan(70);
  });

  it("scales impact with the square root of ticket size", () => {
    const a = resolveAssumptions({ impactBps: 10, impactRefNotionalBase: 10_000 });
    expect(impactBpsFor(a, 10_000)).toBeCloseTo(10, 10);
    expect(impactBpsFor(a, 40_000)).toBeCloseTo(20, 10);
    expect(impactBpsFor(a, 0)).toBe(0);
  });

  it("only charges the FX spread on foreign tickets", () => {
    const a = resolveAssumptions({ fxSpreadBps: 20 });
    const home = priceTicket(ticket, a);
    const away = priceTicket({ ...ticket, foreign: true }, a);
    expect(home.fxSpread).toBe(0);
    expect(away.fxSpread).toBeCloseTo((20 / 10_000) * 1400, 10);
  });

  it("honours a commission floor override and a stamp exemption", () => {
    const a = resolveAssumptions({ commissionFloorBase: 12, stampMult: 0 });
    const p = priceTicket({ ...ticket, symbol: "MKS.L" }, a);
    expect(p.commission).toBeGreaterThanOrEqual(12);
    expect(p.stampDuty).toBe(0);
  });

  it("prices a frictionless run at zero", () => {
    const p = priceTicket(ticket, resolveAssumptions("frictionless"));
    expect(p.totalCost).toBeCloseTo(0, 10);
    expect(p.fillPrice).toBeCloseTo(70, 10);
  });
});

describe("CLI flags", () => {
  it("layers explicit flags over a named preset", () => {
    const a = assumptionsFromFlags([
      "--assumptions", "realistic",
      "--spread-bps", "25",
      "--slippage-bps=6",
      "--no-stamp",
      "--no-ptm",
    ]);
    expect(a.spreadBps).toBe(25);
    expect(a.slippageBps).toBe(6);
    expect(a.stampMult).toBe(0);
    expect(a.ptmLevy).toBe(false);
    expect(a.impactBps).toBe(ASSUMPTION_PRESETS.realistic.impactBps);
  });

  it("falls back to the live model on an unknown preset", () => {
    expect(assumptionsFromFlags(["--assumptions", "nonsense"])).toEqual(LIVE_MODEL_ASSUMPTIONS);
  });

  it("describes itself in one readable line", () => {
    expect(describeAssumptions(resolveAssumptions("realistic"))).toContain("14bps spread");
  });
});
