/**
 * Pure decision logic for "re-check Saxo blocks".
 *
 * The app learns permanent broker rejections (suitability / tradability /
 * permission) and drops those symbols from the live universe. After the user
 * completes an assessment at Saxo, we want to *verify* rather than assume:
 * the app runs a broker-side order precheck (a dry run — nothing is placed)
 * for each blocked symbol and decides what the result means.
 *
 * Three outcomes:
 *   - "cleared"  — the broker no longer refuses this instrument for account
 *                  reasons, so the block can be lifted.
 *   - "blocked"  — the same suitability/permission refusal came back.
 *   - "unknown"  — the probe itself failed (network, auth, symbol lookup),
 *                  so we leave the block exactly as it was.
 */

import { classifyBrokerBlock } from "@/lib/broker-instrument-blocks";

export type RecheckOutcome = "cleared" | "blocked" | "unknown";

export type RecheckProbe = {
  /** Probe reached the broker and produced a verdict. */
  ok: boolean;
  errorCode?: string | null;
  message?: string | null;
  /** Set when the probe could not be run at all. */
  failed?: boolean;
};

export type RecheckDecision = {
  outcome: RecheckOutcome;
  /** Short, user-facing explanation of the outcome. */
  note: string;
};

export function decideRecheck(probe: RecheckProbe): RecheckDecision {
  if (probe.failed) {
    return {
      outcome: "unknown",
      note: "Could not reach the broker to re-check — block left in place.",
    };
  }

  if (probe.ok) {
    return { outcome: "cleared", note: "Saxo accepted a test order check — unblocked." };
  }

  const verdict = classifyBrokerBlock(probe.message ?? null, probe.errorCode ?? null);
  if (verdict.block) {
    return {
      outcome: "blocked",
      note: verdict.detail ?? "Saxo still refuses this instrument on this account.",
    };
  }

  // Rejected for an unrelated reason (cash, market closed, price tolerance).
  // Those are transient/order-specific — the account-level restriction is
  // gone, which is exactly what we are testing for.
  return {
    outcome: "cleared",
    note: "No account restriction left (rejection was order-specific) — unblocked.",
  };
}

export type RecheckSymbolResult = RecheckDecision & { symbol: string; symbolKey: string };

export function summariseRecheck(results: RecheckSymbolResult[]): {
  checked: number;
  cleared: number;
  stillBlocked: number;
  unknown: number;
  message: string;
} {
  const cleared = results.filter((r) => r.outcome === "cleared").length;
  const stillBlocked = results.filter((r) => r.outcome === "blocked").length;
  const unknown = results.filter((r) => r.outcome === "unknown").length;

  let message: string;
  if (results.length === 0) message = "No blocked instruments to re-check.";
  else if (cleared === results.length) message = `All ${cleared} instrument${cleared === 1 ? "" : "s"} unblocked.`;
  else if (cleared === 0 && unknown === 0) message = "Saxo still refuses every blocked instrument.";
  else
    message =
      `${cleared} unblocked, ${stillBlocked} still blocked` +
      (unknown > 0 ? `, ${unknown} could not be checked.` : ".");

  return { checked: results.length, cleared, stillBlocked, unknown, message };
}
