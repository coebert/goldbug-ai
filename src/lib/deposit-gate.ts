// Pure decision helper for the CASH_SYNC deposit gate.
//
// Extracted from live-cash-sync.server.ts so the exact rules that decide
// whether an unexplained cashΔ may bump starting_cash — and the human
// `depositGateReason` string used by the dashboard — can be unit-tested
// without a database. The server module imports this and applies the
// result; any change here is a behavior change to how deposits are booked.
//
// Contract (locked by tests):
//   * SIM portfolios never book deposits and produce no gate reason.
//   * `first funding`: real broker, no local holdings — anything goes.
//   * `no material drift`: |cashΔ − explainedByFills| < epsilon — no gate.
//   * With material unexplained drift on a funded portfolio:
//       - broker returned no TotalValue → allowed, reason mentions that.
//       - no prior TotalValue snapshot → allowed, reason mentions that.
//       - both present → compare `totalValueΔ` to `cashΔ` within
//         max(1, 10% × |cashΔ|); allow iff within tolerance and label
//         the reason with the observed totalValueΔ.

export const DRIFT_EPSILON = 0.5;

export type DepositGateInput = {
  mode: "live_sim" | "live_prod";
  hasLocalHoldings: boolean;
  /** Broker's reported cash balance for this account, if known. */
  brokerCash?: number | null;
  /** brokerCash − localCash (before this sync). */

  delta: number;
  /** Net cash effect of recent fills within the lookback window. */
  explainedCashDelta: number;
  /** Broker's most recent TotalValue reading, if it returned one. */
  brokerTotalValue: number | null;
  /** TotalValue from the latest equity snapshot strictly before today. */
  prevTotalValue: number | null;
};

export type DepositGateDecision = {
  canTreatDriftAsDeposit: boolean;
  depositGateReason: string | null;
};

export function evaluateDepositGate(input: DepositGateInput): DepositGateDecision {
  const { mode, hasLocalHoldings, delta, explainedCashDelta, brokerTotalValue, prevTotalValue } = input;

  if (mode !== "live_prod") {
    return { canTreatDriftAsDeposit: false, depositGateReason: null };
  }

  if (!hasLocalHoldings) {
    // "No local holdings" does NOT prove the account is empty — the holdings
    // sync may simply not have landed yet. If the broker's TotalValue sits
    // materially above its cash balance, the missing money is invested in
    // positions we haven't mirrored locally, so a negative drift is an
    // internal reallocation (cash → stock), not a withdrawal. Booking it
    // would drop starting_cash and manufacture a huge phantom gain on the
    // real-money tile (the 2026-08-01 −£8,999.68 / +781% incident).
    const brokerCash = Number(input.brokerCash);
    const brokerPositionsValue =
      brokerTotalValue != null && Number.isFinite(brokerTotalValue) && Number.isFinite(brokerCash)
        ? brokerTotalValue - brokerCash
        : 0;
    if (delta < 0 && brokerPositionsValue > Math.max(1, Math.abs(delta) * 0.1)) {
      return {
        canTreatDriftAsDeposit: false,
        depositGateReason: `blocked: broker holds ${brokerPositionsValue.toFixed(2)} in un-synced positions — cash moved into holdings, not a withdrawal`,
      };
    }
    return {
      canTreatDriftAsDeposit: true,
      depositGateReason: "no local holdings — first funding",
    };
  }


  const unexplained = delta - explainedCashDelta;
  if (Math.abs(unexplained) < DRIFT_EPSILON) {
    // Drift is fully explained by known fills; nothing to book against
    // starting_cash and no reason is recorded (matches server behaviour).
    return { canTreatDriftAsDeposit: false, depositGateReason: null };
  }

  const totalValueUsable =
    brokerTotalValue != null && Number.isFinite(brokerTotalValue) && brokerTotalValue > 0;
  if (!totalValueUsable) {
    return {
      canTreatDriftAsDeposit: true,
      depositGateReason: "broker did not return TotalValue",
    };
  }

  const prevUsable =
    prevTotalValue != null && Number.isFinite(prevTotalValue) && prevTotalValue > 0;
  if (!prevUsable) {
    return {
      canTreatDriftAsDeposit: true,
      depositGateReason: "no prior TotalValue reference",
    };
  }

  const totalValueDelta = (brokerTotalValue as number) - (prevTotalValue as number);
  const tolerance = Math.max(1, Math.abs(delta) * 0.1);
  if (Math.abs(totalValueDelta - delta) <= tolerance) {
    return {
      canTreatDriftAsDeposit: true,
      depositGateReason: `corroborated by TotalValueΔ=${totalValueDelta.toFixed(2)}`,
    };
  }
  return {
    canTreatDriftAsDeposit: false,
    depositGateReason: `blocked: cashΔ=${delta.toFixed(2)} vs totalValueΔ=${totalValueDelta.toFixed(2)} — internal reallocation, not a deposit`,
  };
}
