import { describe, expect, it } from "vitest";
import {
  describeWatchStatus,
  evaluateTickerWatch,
  type TickerMetrics,
  type TickerWatchConfig,
} from "@/lib/ticker-watch";

const config: TickerWatchConfig = {
  symbol: "AAPL",
  buyAbove: 309.35,
  oversoldRsi: 30,
  maxVolPct: 30,
  dropBelow: 280,
};

const base: TickerMetrics = {
  price: 301.22,
  sma20: 323.98,
  sma50: 309.35,
  rsi14: 42.1,
  annualVolPct: 42.1,
  changePct1d: -1.2,
  changePct5d: -9.55,
  priorLow: 295,
};

const codes = (m: Partial<TickerMetrics>) =>
  evaluateTickerWatch(config, { ...base, ...m }).map((t) => t.code);

describe("evaluateTickerWatch", () => {
  it("stays silent in the current dip: below entry, RSI not oversold, above invalidation", () => {
    expect(codes({})).toEqual([]);
  });

  it("does not call a recovery while volatility is still elevated", () => {
    expect(codes({ price: 315 })).toEqual([]);
  });

  it("fires the recovery trigger only when price clears the level AND volatility cools", () => {
    expect(codes({ price: 315, annualVolPct: 24 })).toEqual(["recovery_confirmed"]);
  });

  it("fires an oversold washout at or below the RSI threshold", () => {
    expect(codes({ rsi14: 30 })).toContain("oversold_washout");
    expect(codes({ rsi14: 30.1 })).not.toContain("oversold_washout");
  });

  it("fires a critical invalidation below the stop level", () => {
    const triggers = evaluateTickerWatch(config, { ...base, price: 279 });
    const invalidation = triggers.find((t) => t.code === "invalidation");
    expect(invalidation?.severity).toBe("critical");
    expect(invalidation?.body).toContain("do not average down");
  });

  it("flags a new low for the window", () => {
    expect(codes({ price: 294 })).toContain("new_low");
    expect(codes({ price: 296 })).not.toContain("new_low");
  });

  it("returns nothing without a usable price", () => {
    expect(codes({ price: 0 })).toEqual([]);
  });

  it("treats a missing volatility reading as not blocking the recovery trigger", () => {
    expect(codes({ price: 315, annualVolPct: null })).toEqual(["recovery_confirmed"]);
  });
});

describe("describeWatchStatus", () => {
  it("quantifies the distance to the entry level", () => {
    expect(describeWatchStatus(config, base)).toContain("below the 309.35 entry level");
  });

  it("reports being above the entry level", () => {
    expect(describeWatchStatus(config, { ...base, price: 320 })).toContain(
      "above the 309.35 entry level",
    );
  });
});
