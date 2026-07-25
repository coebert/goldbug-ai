import { describe, it, expect } from "vitest";
import {
  reconcileBuysWithFxLegs,
  type PlannedFxLegLite,
  type FxLegOutcome,
  type RoutedBuy,
} from "@/lib/post-broker-reconciliation";

const leg = (
  triggeredBySymbol: string,
  from: string,
  to: string,
): PlannedFxLegLite => ({
  triggeredBySymbol,
  fromCcy: from,
  toCcy: to,
  amountFrom: 100,
  amountTo: 100,
  rate: 1,
  stale: false,
});

describe("reconcileBuysWithFxLegs", () => {
  it("marks a base-ccy buy with no FX leg as fully funded", () => {
    const routed: RoutedBuy[] = [
      { symbol: "VOD.L", side: "buy", status: "filled" },
    ];
    const [entry] = reconcileBuysWithFxLegs(routed, [], []);
    expect(entry).toMatchObject({
      symbol: "VOD.L",
      status: "fully_funded",
      reason: null,
      expectedFxLegs: 0,
      fulfilledFxLegs: 0,
      orderStatus: "filled",
    });
  });

  it("marks a cross-ccy buy fully funded when its FX leg placed ok", () => {
    const routed: RoutedBuy[] = [
      { symbol: "AAPL", side: "buy", status: "filled" },
    ];
    const plan = [leg("AAPL", "GBP", "USD")];
    const outcomes: FxLegOutcome[] = [{ triggerSymbol: "AAPL", kind: "ok" }];
    const [entry] = reconcileBuysWithFxLegs(routed, plan, outcomes);
    expect(entry.status).toBe("fully_funded");
    expect(entry.expectedFxLegs).toBe(1);
    expect(entry.fulfilledFxLegs).toBe(1);
  });

  it("fails a buy whose FX leg was rejected, using the FX reason", () => {
    const routed: RoutedBuy[] = [
      { symbol: "AAPL", side: "buy", status: "skipped", skipped: "fx spot failed: InsufficientCollateral" },
    ];
    // After the executor re-trims, the failed-leg buy is skipped and has no
    // planned leg attached; the pre-skip reason wins.
    const [entry] = reconcileBuysWithFxLegs(routed, [], [
      { triggerSymbol: "AAPL", kind: "failed", reason: "InsufficientCollateral" },
    ]);
    expect(entry.status).toBe("failed");
    expect(entry.reason).toMatch(/fx spot failed/);
    expect(entry.orderStatus).toBe("skipped");
  });

  it("fails a buy when the broker rejected the order", () => {
    const routed: RoutedBuy[] = [
      { symbol: "AAPL", side: "buy", status: "rejected", reason: "InsufficientCash" },
    ];
    const [entry] = reconcileBuysWithFxLegs(routed, [leg("AAPL", "GBP", "USD")], [
      { triggerSymbol: "AAPL", kind: "ok" },
    ]);
    expect(entry.status).toBe("failed");
    expect(entry.reason).toBe("InsufficientCash");
  });

  it("fails a buy when the FX leg quietly failed to place (missing outcome)", () => {
    const routed: RoutedBuy[] = [
      { symbol: "AAPL", side: "buy", status: "filled" },
    ];
    const [entry] = reconcileBuysWithFxLegs(routed, [leg("AAPL", "GBP", "USD")], []);
    expect(entry.status).toBe("failed");
    expect(entry.reason).toMatch(/expected 1 FX leg but only 0 placed/);
    expect(entry.fulfilledFxLegs).toBe(0);
  });

  it("multi-hop: all legs ok → funded; any leg failed → failed", () => {
    const routed: RoutedBuy[] = [{ symbol: "SAP", side: "buy", status: "filled" }];
    const plan = [leg("SAP", "USD", "GBP"), leg("SAP", "GBP", "EUR")];
    const funded = reconcileBuysWithFxLegs(routed, plan, [
      { triggerSymbol: "SAP", kind: "ok" },
      { triggerSymbol: "SAP", kind: "ok" },
    ])[0];
    expect(funded.status).toBe("fully_funded");
    expect(funded.expectedFxLegs).toBe(2);
    expect(funded.fulfilledFxLegs).toBe(2);

    const partial = reconcileBuysWithFxLegs(routed, plan, [
      { triggerSymbol: "SAP", kind: "ok" },
      { triggerSymbol: "SAP", kind: "failed", reason: "hop2 rejected" },
    ])[0];
    expect(partial.status).toBe("failed");
    expect(partial.reason).toBe("hop2 rejected");
  });

  it("ignores sells (they do not require FX legs)", () => {
    const routed: RoutedBuy[] = [
      { symbol: "AAPL", side: "sell", status: "filled" },
      { symbol: "VOD.L", side: "buy", status: "filled" },
    ];
    const out = reconcileBuysWithFxLegs(routed, [], []);
    expect(out).toHaveLength(1);
    expect(out[0].symbol).toBe("VOD.L");
  });

  it("treats an unknown terminal status as failed rather than silently funded", () => {
    const routed: RoutedBuy[] = [
      { symbol: "AAPL", side: "buy", status: "weird-broker-state" },
    ];
    const [entry] = reconcileBuysWithFxLegs(routed, [], []);
    expect(entry.status).toBe("failed");
    expect(entry.reason).toMatch(/unrecognised order status/);
  });
});
