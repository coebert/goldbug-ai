import { describe, it, expect } from "vitest";
import { evaluateDepositGate, DRIFT_EPSILON } from "@/lib/deposit-gate";

// These tests lock the exact rules and reason strings the CASH_SYNC path
// records for the reconciliation dashboard. Any regression here would
// silently change how deposits are booked against starting_cash and
// corrupt % change on every portfolio tile.

const base = {
  mode: "live_prod" as const,
  hasLocalHoldings: true,
  delta: 0,
  explainedCashDelta: 0,
  brokerTotalValue: null as number | null,
  prevTotalValue: null as number | null,
};

describe("evaluateDepositGate", () => {
  it("never books deposits for live_sim portfolios", () => {
    const r = evaluateDepositGate({
      ...base,
      mode: "live_sim",
      delta: 5000,
      brokerTotalValue: 15000,
      prevTotalValue: 10000,
    });
    expect(r).toEqual({ canTreatDriftAsDeposit: false, depositGateReason: null });
  });

  it("first funding: no holdings ⇒ allow without TotalValue check", () => {
    const r = evaluateDepositGate({ ...base, hasLocalHoldings: false, delta: 10_000 });
    expect(r.canTreatDriftAsDeposit).toBe(true);
    expect(r.depositGateReason).toBe("no local holdings — first funding");
  });

  it("drift fully explained by recent fills ⇒ no gate reason recorded", () => {
    const r = evaluateDepositGate({
      ...base,
      delta: -1234.56, // buy consumed cash
      explainedCashDelta: -1234.56,
      brokerTotalValue: 20_000,
      prevTotalValue: 20_000,
    });
    expect(r).toEqual({ canTreatDriftAsDeposit: false, depositGateReason: null });
  });

  it("drift within DRIFT_EPSILON of explained ⇒ still no gate reason", () => {
    const r = evaluateDepositGate({
      ...base,
      delta: -1000 + (DRIFT_EPSILON - 0.01),
      explainedCashDelta: -1000,
      brokerTotalValue: 20_000,
      prevTotalValue: 20_000,
    });
    expect(r.canTreatDriftAsDeposit).toBe(false);
    expect(r.depositGateReason).toBeNull();
  });

  it("unexplained drift but broker returned no TotalValue ⇒ allowed with fallback reason", () => {
    const r = evaluateDepositGate({
      ...base,
      delta: 2500,
      explainedCashDelta: 0,
      brokerTotalValue: null,
      prevTotalValue: 10_000,
    });
    expect(r.canTreatDriftAsDeposit).toBe(true);
    expect(r.depositGateReason).toBe("broker did not return TotalValue");
  });

  it("broker TotalValue non-positive is treated as missing", () => {
    const r = evaluateDepositGate({
      ...base,
      delta: 2500,
      brokerTotalValue: 0,
      prevTotalValue: 10_000,
    });
    expect(r.depositGateReason).toBe("broker did not return TotalValue");
  });

  it("no prior snapshot ⇒ allowed with 'no prior TotalValue reference'", () => {
    const r = evaluateDepositGate({
      ...base,
      delta: 2500,
      brokerTotalValue: 12_500,
      prevTotalValue: null,
    });
    expect(r.canTreatDriftAsDeposit).toBe(true);
    expect(r.depositGateReason).toBe("no prior TotalValue reference");
  });

  it("prior snapshot 0 or negative is treated as missing", () => {
    const r = evaluateDepositGate({
      ...base,
      delta: 2500,
      brokerTotalValue: 12_500,
      prevTotalValue: 0,
    });
    expect(r.depositGateReason).toBe("no prior TotalValue reference");
  });

  it("cashΔ corroborated by matching totalValueΔ ⇒ booked with numeric reason", () => {
    const r = evaluateDepositGate({
      ...base,
      delta: 5000,
      brokerTotalValue: 15_000,
      prevTotalValue: 10_000,
    });
    expect(r.canTreatDriftAsDeposit).toBe(true);
    expect(r.depositGateReason).toBe("corroborated by TotalValueΔ=5000.00");
  });

  it("tolerance = max(1, 10% × |cashΔ|): 9% skew still corroborates", () => {
    // cashΔ=5000, tolerance=500; totalValueΔ=4550 → within tolerance
    const r = evaluateDepositGate({
      ...base,
      delta: 5000,
      brokerTotalValue: 14_550,
      prevTotalValue: 10_000,
    });
    expect(r.canTreatDriftAsDeposit).toBe(true);
    expect(r.depositGateReason).toBe("corroborated by TotalValueΔ=4550.00");
  });

  it("tolerance floor of £1 applies to tiny drifts", () => {
    // cashΔ=0.75 (>epsilon), 10% would be 0.075 → floor 1; totalValueΔ=1.5 diff=0.75 ⇒ allow
    const r = evaluateDepositGate({
      ...base,
      delta: 0.75,
      brokerTotalValue: 10_001.5,
      prevTotalValue: 10_000,
    });
    expect(r.canTreatDriftAsDeposit).toBe(true);
    expect(r.depositGateReason).toBe("corroborated by TotalValueΔ=1.50");
  });

  it("2026-07-28 incident: cashΔ +2049 with flat TotalValue ⇒ BLOCKED with exact reason", () => {
    const r = evaluateDepositGate({
      ...base,
      delta: 2049,
      brokerTotalValue: 10_005,
      prevTotalValue: 10_000,
    });
    expect(r.canTreatDriftAsDeposit).toBe(false);
    expect(r.depositGateReason).toBe(
      "blocked: cashΔ=2049.00 vs totalValueΔ=5.00 — internal reallocation, not a deposit",
    );
  });

  it("withdrawal: cashΔ −5000 matching totalValueΔ ⇒ booked", () => {
    const r = evaluateDepositGate({
      ...base,
      delta: -5000,
      brokerTotalValue: 5_000,
      prevTotalValue: 10_000,
    });
    expect(r.canTreatDriftAsDeposit).toBe(true);
    expect(r.depositGateReason).toBe("corroborated by TotalValueΔ=-5000.00");
  });

  it("sign mismatch: cash rose but TotalValue fell ⇒ blocked", () => {
    const r = evaluateDepositGate({
      ...base,
      delta: 1000,
      brokerTotalValue: 9_500,
      prevTotalValue: 10_000,
    });
    expect(r.canTreatDriftAsDeposit).toBe(false);
    expect(r.depositGateReason).toContain("blocked:");
    expect(r.depositGateReason).toContain("totalValueΔ=-500.00");
  });

  it("just outside tolerance (10.01% skew) ⇒ blocked", () => {
    // cashΔ=1000, tolerance=100; totalValueΔ=899 (diff 101) → blocked
    const r = evaluateDepositGate({
      ...base,
      delta: 1000,
      brokerTotalValue: 10_899,
      prevTotalValue: 10_000,
    });
    expect(r.canTreatDriftAsDeposit).toBe(false);
    expect(r.depositGateReason).toBe(
      "blocked: cashΔ=1000.00 vs totalValueΔ=899.00 — internal reallocation, not a deposit",
    );
  });

  it("exactly at tolerance edge ⇒ allowed (≤, not <)", () => {
    // cashΔ=1000, tolerance=100; totalValueΔ=900 (diff exactly 100)
    const r = evaluateDepositGate({
      ...base,
      delta: 1000,
      brokerTotalValue: 10_900,
      prevTotalValue: 10_000,
    });
    expect(r.canTreatDriftAsDeposit).toBe(true);
  });

  it("fills partially explain drift; unexplained residue still gated by TotalValue", () => {
    // cash moved -300; fills explain -800 (a big sell was expected but didn't
    // happen fully). Unexplained = +500. TotalValue confirms +500 → allow.
    const r = evaluateDepositGate({
      ...base,
      delta: -300,
      explainedCashDelta: -800,
      brokerTotalValue: 10_500,
      prevTotalValue: 10_000,
    });
    // Gate compares raw cashΔ vs totalValueΔ (−300 vs +500 → mismatch),
    // which is the current server behaviour; lock it so any change is
    // deliberate.
    expect(r.canTreatDriftAsDeposit).toBe(false);
    expect(r.depositGateReason).toContain("blocked:");
  });
});
