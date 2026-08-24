// Orphaned pending-order detection (pure logic, no I/O).
//
// The MKS.L sell that "never happened" is the canonical case: a marketable
// limit was accepted by the broker, rested above a falling market, and then
// either (a) stayed working for hours while every replacement was refused as a
// duplicate, or (b) vanished from the broker's open-order list while our
// `live_orders` row stayed `submitted` forever. Either way the engine kept
// believing an exit was in flight and refused to route a new one.
//
// This module classifies each open local order — and each untracked broker
// order — into an action the sweeper can execute BEFORE new trades are
// considered on the next tick.

export type OrphanAction =
  /** Broker still shows it working, but it has rested too long: cancel it. */
  | "cancel_broker"
  /** Broker no longer knows it; ask the reconciler for the true outcome. */
  | "reconcile"
  /** Never reached the broker (or is unknowably old): close it locally. */
  | "close_local"
  /** Working order at the broker with no matching local row: cancel it. */
  | "cancel_untracked"
  /** Young enough to leave alone. */
  | "none";

export interface LocalOpenOrder {
  id: string;
  symbol: string;
  side: string;
  status: string;
  quantity: number;
  brokerOrderId: string | null;
  /** submitted_at ?? created_at */
  placedAt: string | null;
}

export interface BrokerWorkingOrder {
  brokerOrderId: string;
  symbol: string;
  amount: number;
  filledAmount: number;
  buySell?: "Buy" | "Sell";
  orderTime?: string;
}

export interface OrphanFinding {
  action: OrphanAction;
  reason: string;
  ageMs: number | null;
  orderId?: string;
  brokerOrderId: string | null;
  symbol: string;
  side?: string;
}

export interface SweepThresholds {
  /** A resting broker order older than this is cancelled (default 45 min). */
  staleWorkingMs?: number;
  /** A local order the broker doesn't know about, older than this, is reconciled (default 10 min). */
  missingAtBrokerMs?: number;
  /** Beyond this age nothing can be recovered; close the local row (default 48 h). */
  abandonMs?: number;
}

const DEFAULTS: Required<SweepThresholds> = {
  staleWorkingMs: 45 * 60_000,
  missingAtBrokerMs: 10 * 60_000,
  abandonMs: 48 * 3600_000,
};

function ageMsOf(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, nowMs - t);
}

/** Open at the broker means: accepted, not fully filled. */
export function isBrokerOrderOpen(o: BrokerWorkingOrder): boolean {
  return Number(o.amount) - Number(o.filledAmount) > 0;
}

/**
 * Classify every open local order plus any untracked broker order.
 * Deterministic and side-effect free so the sweeper stays testable.
 */
export function classifyOrphanOrders(args: {
  local: LocalOpenOrder[];
  brokerWorking: BrokerWorkingOrder[];
  /** Set false when the broker list could not be fetched — never close rows blind. */
  brokerListOk?: boolean;
  nowMs?: number;
  thresholds?: SweepThresholds;
}): OrphanFinding[] {
  const nowMs = args.nowMs ?? Date.now();
  const t = { ...DEFAULTS, ...(args.thresholds ?? {}) };
  const brokerListOk = args.brokerListOk !== false;

  const openBroker = args.brokerWorking.filter(isBrokerOrderOpen);
  const byBrokerId = new Map(openBroker.map((o) => [String(o.brokerOrderId), o]));
  const matchedBrokerIds = new Set<string>();
  const findings: OrphanFinding[] = [];

  for (const row of args.local) {
    const age = ageMsOf(row.placedAt, nowMs);
    const base = {
      orderId: row.id,
      brokerOrderId: row.brokerOrderId,
      symbol: row.symbol,
      side: row.side,
      ageMs: age,
    };

    if (!row.brokerOrderId) {
      // Never got an id back: the POST failed or the response was lost. It can
      // never be reconciled against the broker, so it must not keep blocking.
      if (age != null && age >= t.missingAtBrokerMs) {
        findings.push({ ...base, action: "close_local", reason: "no broker order id" });
      } else {
        findings.push({ ...base, action: "none", reason: "awaiting broker id" });
      }
      continue;
    }

    const brokerOrder = byBrokerId.get(String(row.brokerOrderId));
    if (brokerOrder) {
      matchedBrokerIds.add(String(row.brokerOrderId));
      const brokerAge = ageMsOf(brokerOrder.orderTime, nowMs) ?? age;
      if (brokerAge != null && brokerAge >= t.staleWorkingMs) {
        findings.push({
          ...base,
          ageMs: brokerAge,
          action: "cancel_broker",
          reason: `resting ${Math.round(brokerAge / 60_000)}m at broker`,
        });
      } else {
        findings.push({ ...base, action: "none", reason: "working, still fresh" });
      }
      continue;
    }

    if (!brokerListOk) {
      findings.push({ ...base, action: "none", reason: "broker order list unavailable" });
      continue;
    }

    if (age != null && age >= t.abandonMs) {
      findings.push({ ...base, action: "close_local", reason: "abandoned: past recovery window" });
    } else if (age == null || age >= t.missingAtBrokerMs) {
      findings.push({ ...base, action: "reconcile", reason: "not in broker open orders" });
    } else {
      findings.push({ ...base, action: "none", reason: "recently submitted" });
    }
  }

  if (brokerListOk) {
    for (const o of openBroker) {
      if (matchedBrokerIds.has(String(o.brokerOrderId))) continue;
      const age = ageMsOf(o.orderTime, nowMs);
      if (age != null && age >= t.staleWorkingMs) {
        findings.push({
          action: "cancel_untracked",
          reason: "working at broker with no local order row",
          ageMs: age,
          brokerOrderId: o.brokerOrderId,
          symbol: o.symbol,
          side: o.buySell,
        });
      }
    }
  }

  return findings;
}

/** True when anything found needs an action before new trades are routed. */
export function hasBlockingOrphans(findings: OrphanFinding[]): boolean {
  return findings.some((f) => f.action !== "none");
}
