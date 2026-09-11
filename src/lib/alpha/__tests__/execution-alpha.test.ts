import { describe, it, expect } from "vitest";
import {
  planOrderSlices,
  todExecutionAdjustment,
  inferVenueFromSymbol,
  venueMinuteOfDay,
} from "../execution-alpha";

describe("planOrderSlices", () => {
  it("returns empty plan for zero notional", () => {
    const p = planOrderSlices({
      parentNotional: 0,
      price: 100,
      adv20d: 1_000_000,
      participationCap: 0.05,
      maxChildNotional: 5000,
    });
    expect(p.childCount).toBe(0);
  });

  it("single slice when parent fits under both caps", () => {
    const p = planOrderSlices({
      parentNotional: 1_000,
      price: 50,
      adv20d: 1_000_000, // ADV value = 50m; 5% = 2.5m
      participationCap: 0.05,
      maxChildNotional: 5_000,
    });
    expect(p.childCount).toBe(1);
    expect(p.childNotional).toBe(1_000);
  });

  it("slices when parent exceeds max child notional", () => {
    const p = planOrderSlices({
      parentNotional: 12_000,
      price: 100,
      adv20d: 1_000_000,
      participationCap: 0.5,
      maxChildNotional: 5_000,
    });
    expect(p.childCount).toBe(3); // ceil(12000/5000)
    expect(p.childNotional).toBeCloseTo(4_000, 6);
  });

  it("respects ADV participation cap", () => {
    const p = planOrderSlices({
      parentNotional: 100_000,
      price: 10,
      adv20d: 10_000, // ADV value = 100k; 5% = 5k
      participationCap: 0.05,
      maxChildNotional: 1_000_000,
    });
    expect(p.childCount).toBe(20); // ceil(100k/5k), capped at maxChildren=20
    expect(p.advParticipationPct).toBeCloseTo(1, 6);
  });

  it("no ADV → single slice with null participation", () => {
    const p = planOrderSlices({
      parentNotional: 500,
      price: 10,
      adv20d: null,
      participationCap: 0.05,
      maxChildNotional: 1_000,
    });
    expect(p.childCount).toBe(1);
    expect(p.advParticipationPct).toBeNull();
  });
});

describe("inferVenueFromSymbol", () => {
  it("classifies global equity and crypto tickers", () => {
    expect(inferVenueFromSymbol("VOD.L")).toBe("LSE");
    expect(inferVenueFromSymbol("AAPL")).toBe("NYSE");
    expect(inferVenueFromSymbol("BTC-USD")).toBe("CRYPTO");
    expect(inferVenueFromSymbol("SGLN:XLON")).toBe("LSE");
    expect(inferVenueFromSymbol("SAP.DE")).toBe("XETR");
    expect(inferVenueFromSymbol("AIR.PA")).toBe("EURONEXT");
    expect(inferVenueFromSymbol("NESN.SW")).toBe("SIX");
    expect(inferVenueFromSymbol("VOLV-B.ST")).toBe("NORDIC");
  });
});

describe("todExecutionAdjustment", () => {
  it("no session for crypto → neutral", () => {
    const r = todExecutionAdjustment({
      venue: "CRYPTO",
      avoidOpenMin: 15,
      avoidCloseMin: 15,
    });
    expect(r.allow).toBe(true);
    expect(r.multiplier).toBe(1);
  });

  it("outside RTH is neutral so batch ticks still execute", () => {
    // LSE opens at 08:00 London. Pick 05:00 UTC on a summer day where London = 06:00 BST.
    const before = new Date("2025-07-15T05:00:00Z");
    const r = todExecutionAdjustment({
      now: before,
      venue: "LSE",
      avoidOpenMin: 15,
      avoidCloseMin: 15,
    });
    expect(r.allow).toBe(true);
    expect(r.multiplier).toBe(1);
    expect(r.reason).toMatch(/outside RTH/);
  });

  it("hard blocks buys inside the opening window when configured", () => {
    // London 08:05 BST → UTC 07:05 in summer.
    const openWindow = new Date("2025-07-15T07:05:00Z");
    const r = todExecutionAdjustment({
      now: openWindow,
      venue: "LSE",
      avoidOpenMin: 30,
      avoidCloseMin: 15,
      hardBlockOpenMin: 15,
    });
    expect(r.allow).toBe(false);
    expect(r.multiplier).toBe(0);
  });

  it("haircuts inside the softer open window", () => {
    // London 08:20 BST → UTC 07:20 (past hard block, inside soft avoid)
    const softOpen = new Date("2025-07-15T07:20:00Z");
    const r = todExecutionAdjustment({
      now: softOpen,
      venue: "LSE",
      avoidOpenMin: 30,
      avoidCloseMin: 15,
      hardBlockOpenMin: 15,
      openHaircut: 0.5,
    });
    expect(r.allow).toBe(true);
    expect(r.multiplier).toBe(0.5);
  });

  it("mid-session leaves size untouched", () => {
    // London 12:00 BST → UTC 11:00
    const mid = new Date("2025-07-15T11:00:00Z");
    const r = todExecutionAdjustment({
      now: mid,
      venue: "LSE",
      avoidOpenMin: 15,
      avoidCloseMin: 15,
    });
    expect(r.multiplier).toBe(1);
    expect(r.reason).toBe("mid-session");
  });

  it("venueMinuteOfDay tracks London wall clock", () => {
    // 07:00 UTC on 15 Jul 2025 → 08:00 London (BST)
    expect(venueMinuteOfDay(new Date("2025-07-15T07:00:00Z"), "LSE")).toBe(8 * 60);
  });
});
