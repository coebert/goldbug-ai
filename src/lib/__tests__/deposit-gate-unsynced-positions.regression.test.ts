import { describe, expect, it } from "vitest";
import { evaluateDepositGate } from "@/lib/deposit-gate";

// Regression: 2026-08-01. CASH_SYNC saw brokerCash £1,300.32 against a local
// baseline of £10,300 while the holdings sync had not yet written any local
// rows. The gate's "first funding" bypass booked the −£8,999.68 drift as a
// withdrawal, dropping starting_cash and making the real-money tile read
// +£17,011 / +781.22%. The broker's TotalValue (£10,189.12) proves the money
// was invested, not withdrawn.

describe("deposit gate — no local holdings but broker holds positions", () => {
  const base = {
    mode: "live_prod" as const,
    hasLocalHoldings: false,
    explainedCashDelta: 0,
    prevTotalValue: null as number | null,
  };

  it("blocks a negative drift when the broker reports un-synced positions", () => {
    const r = evaluateDepositGate({
      ...base,
      brokerCash: 1300.32,
      brokerTotalValue: 10189.12,
      delta: -8999.68,
    });
    expect(r.canTreatDriftAsDeposit).toBe(false);
    expect(r.depositGateReason).toMatch(/un-synced positions/);
  });

  it("still allows genuine first funding on an all-cash account", () => {
    const r = evaluateDepositGate({
      ...base,
      brokerCash: 10300,
      brokerTotalValue: 10300,
      delta: 10300,
    });
    expect(r.canTreatDriftAsDeposit).toBe(true);
    expect(r.depositGateReason).toBe("no local holdings — first funding");
  });

  it("still allows a real withdrawal from an all-cash account", () => {
    const r = evaluateDepositGate({
      ...base,
      brokerCash: 1300,
      brokerTotalValue: 1300,
      delta: -9000,
    });
    expect(r.canTreatDriftAsDeposit).toBe(true);
  });

  it("falls back to first funding when the broker gives no TotalValue", () => {
    const r = evaluateDepositGate({
      ...base,
      brokerCash: 1300,
      brokerTotalValue: null,
      delta: -9000,
    });
    expect(r.canTreatDriftAsDeposit).toBe(true);
  });
});
