// Planned-vs-actual trade reconciliation.
//
// Three ledgers describe one hourly run, and they disagree in useful ways:
//
//   1. `decisions.raw.orders` / `.executed` — what the AI *planned*, plus any
//      engine-side veto (cash floor, position cap, blocked symbol...).
//   2. `live_orders` — what was actually routed to the broker and the status
//      the broker last reported (`reject_reason` carries Saxo's words).
//   3. `live_fills` — what actually executed, and for how much.
//
// This module joins them into one row per planned attempt and explains the
// gap in plain language, with a dedicated call-out for suitability /
// appropriateness rejections (the ones that need a human at the broker, not
// a retry). Pure functions only — the DB reads live in the server module.

import {
  blockSymbolKey,
  classifyBrokerBlock,
  recommendedActionFor,
  type BrokerBlockReason,
} from "./broker-instrument-blocks";

export type ReconOutcome =
  | "filled"
  | "partial"
  | "rejected_suitability"
  | "rejected_broker"
  | "blocked_pre_trade"
  | "vetoed_by_engine"
  | "pending"
  | "not_routed";

export interface PlannedAttempt {
  decisionId: string;
  runDate: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number | null;
  value: number | null;
  reason: string | null;
  /** Engine-side veto text, when the run rejected the order before routing. */
  engineRejection: string | null;
}

export interface BrokerOrderRow {
  id: string;
  decisionId: string | null;
  symbol: string;
  side: string;
  quantity: number;
  status: string;
  rejectReason: string | null;
  brokerOrderId: string | null;
  createdAt: string;
}

export interface FillRow {
  orderId: string;
  quantity: number;
  fillPrice: number;
}

export interface ActiveBlockRow {
  symbolKey: string;
  reason: string;
}

export interface ReconRow {
  decisionId: string;
  runDate: string;
  symbol: string;
  symbolKey: string;
  side: "buy" | "sell";
  plannedQuantity: number;
  plannedValue: number | null;
  filledQuantity: number;
  avgFillPrice: number | null;
  outcome: ReconOutcome;
  /** Plain-language explanation of the planned-vs-actual gap. */
  explanation: string;
  /** Present only for account-level broker blocks. */
  blockReason: BrokerBlockReason | null;
  recommendedAction: string | null;
  brokerOrderId: string | null;
  brokerStatus: string | null;
  brokerRejectText: string | null;
}

export interface ReconSummary {
  attempts: number;
  filled: number;
  partial: number;
  suitabilityRejected: number;
  otherBrokerRejected: number;
  blockedPreTrade: number;
  vetoedByEngine: number;
  pending: number;
  notRouted: number;
  /** Notional the AI planned but never executed, in portfolio base currency. */
  unexecutedValue: number;
  /** Of that, the slice attributable to suitability/permission blocks. */
  suitabilityBlockedValue: number;
}

export interface SuitabilityGroup {
  symbol: string;
  symbolKey: string;
  reason: BrokerBlockReason;
  attempts: number;
  blockedValue: number;
  firstSeen: string;
  lastSeen: string;
  stillBlocked: boolean;
  recommendedAction: string;
  brokerText: string | null;
}

export interface ReconReport {
  rows: ReconRow[];
  summary: ReconSummary;
  suitability: SuitabilityGroup[];
}

const TERMINAL_FILLED = new Set(["filled"]);
const REJECTED = new Set(["rejected", "cancelled", "expired"]);
const PENDING = new Set(["pending", "submitted", "working", "partial"]);

function normSide(side: string): "buy" | "sell" {
  return String(side).toLowerCase() === "sell" ? "sell" : "buy";
}

function matchKey(symbol: string, side: string): string {
  return `${blockSymbolKey(symbol)}:${normSide(side)}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Is this engine veto text explained by a learned broker block? */
function vetoMentionsBlock(text: string | null): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("broker block") ||
    t.includes("blocked instrument") ||
    t.includes("suitability") ||
    t.includes("not tradable") ||
    t.includes("not permitted")
  );
}

export function buildReconciliationReport(input: {
  planned: PlannedAttempt[];
  orders: BrokerOrderRow[];
  fills: FillRow[];
  activeBlocks: ActiveBlockRow[];
}): ReconReport {
  const fillsByOrder = new Map<string, { qty: number; notional: number }>();
  for (const f of input.fills) {
    const agg = fillsByOrder.get(f.orderId) ?? { qty: 0, notional: 0 };
    agg.qty += Number(f.quantity ?? 0);
    agg.notional += Number(f.quantity ?? 0) * Number(f.fillPrice ?? 0);
    fillsByOrder.set(f.orderId, agg);
  }

  // Index broker orders by decision + symbol root + side, and keep a
  // decision-less fallback so runs that predate `decision_id` still join.
  const byDecision = new Map<string, BrokerOrderRow[]>();
  const bySymbolOnly = new Map<string, BrokerOrderRow[]>();
  for (const o of input.orders) {
    const k = matchKey(o.symbol, o.side);
    if (o.decisionId) {
      const dk = `${o.decisionId}|${k}`;
      byDecision.set(dk, [...(byDecision.get(dk) ?? []), o]);
    }
    bySymbolOnly.set(k, [...(bySymbolOnly.get(k) ?? []), o]);
  }
  const consumed = new Set<string>();

  const blockedKeys = new Map(
    input.activeBlocks.map((b) => [blockSymbolKey(b.symbolKey), b.reason]),
  );

  const rows: ReconRow[] = [];

  for (const p of input.planned) {
    const key = matchKey(p.symbol, p.side);
    const symbolKey = blockSymbolKey(p.symbol);
    const candidates = [
      ...(byDecision.get(`${p.decisionId}|${key}`) ?? []),
      ...(bySymbolOnly.get(key) ?? []),
    ].filter((o) => !consumed.has(o.id));
    const order = candidates[0] ?? null;
    if (order) consumed.add(order.id);

    const fill = order ? fillsByOrder.get(order.id) : undefined;
    const filledQuantity = fill?.qty ?? 0;
    const avgFillPrice =
      fill && fill.qty > 0 ? round2(fill.notional / fill.qty) : null;
    const plannedValue =
      p.value != null
        ? Number(p.value)
        : p.price != null
          ? round2(Number(p.price) * Number(p.quantity ?? 0))
          : null;

    let outcome: ReconOutcome;
    let explanation: string;
    let blockReason: BrokerBlockReason | null = null;

    const brokerStatus = order ? String(order.status ?? "").toLowerCase() : null;
    const brokerRejectText = order?.rejectReason ?? null;
    const classification = classifyBrokerBlock(brokerRejectText);

    if (order && TERMINAL_FILLED.has(brokerStatus!) ) {
      outcome = "filled";
      explanation = `Filled ${filledQuantity || p.quantity} @ ${avgFillPrice ?? "broker price"}.`;
    } else if (order && (brokerStatus === "partial" || (filledQuantity > 0 && filledQuantity < p.quantity))) {
      outcome = "partial";
      explanation = `Partially filled ${filledQuantity} of ${p.quantity} planned.`;
    } else if (order && REJECTED.has(brokerStatus!)) {
      if (classification.block && classification.reason) {
        outcome = "rejected_suitability";
        blockReason = classification.reason;
        explanation =
          classification.detail ??
          "Broker refused the order at the account level.";
      } else {
        outcome = "rejected_broker";
        explanation =
          brokerRejectText?.trim() ||
          `Broker ${brokerStatus} the order without a stated reason.`;
      }
    } else if (order && PENDING.has(brokerStatus!)) {
      outcome = "pending";
      explanation = `Routed to the broker and still ${brokerStatus}; no fill confirmed yet.`;
    } else if (p.engineRejection && vetoMentionsBlock(p.engineRejection)) {
      outcome = "blocked_pre_trade";
      blockReason =
        (blockedKeys.get(symbolKey) as BrokerBlockReason | undefined) ??
        "suitability";
      explanation = `Suppressed before routing: ${p.engineRejection}`;
    } else if (p.engineRejection) {
      outcome = "vetoed_by_engine";
      explanation = `Risk/guardrail veto: ${p.engineRejection}`;
    } else if (blockedKeys.has(symbolKey)) {
      outcome = "blocked_pre_trade";
      blockReason = blockedKeys.get(symbolKey) as BrokerBlockReason;
      explanation =
        "Symbol is on the learned broker blocklist, so no order was sent.";
    } else if (order) {
      outcome = "pending";
      explanation = `Broker status "${order.status}" is not yet terminal.`;
    } else {
      outcome = "not_routed";
      explanation =
        "Planned by the AI but no matching broker order was recorded for this run.";
    }

    rows.push({
      decisionId: p.decisionId,
      runDate: p.runDate,
      symbol: p.symbol.toUpperCase(),
      symbolKey,
      side: p.side,
      plannedQuantity: Number(p.quantity ?? 0),
      plannedValue,
      filledQuantity,
      avgFillPrice,
      outcome,
      explanation,
      blockReason,
      recommendedAction: blockReason ? recommendedActionFor(blockReason) : null,
      brokerOrderId: order?.brokerOrderId ?? null,
      brokerStatus: order?.status ?? null,
      brokerRejectText,
    });
  }

  const summary: ReconSummary = {
    attempts: rows.length,
    filled: rows.filter((r) => r.outcome === "filled").length,
    partial: rows.filter((r) => r.outcome === "partial").length,
    suitabilityRejected: rows.filter((r) => r.outcome === "rejected_suitability").length,
    otherBrokerRejected: rows.filter((r) => r.outcome === "rejected_broker").length,
    blockedPreTrade: rows.filter((r) => r.outcome === "blocked_pre_trade").length,
    vetoedByEngine: rows.filter((r) => r.outcome === "vetoed_by_engine").length,
    pending: rows.filter((r) => r.outcome === "pending").length,
    notRouted: rows.filter((r) => r.outcome === "not_routed").length,
    unexecutedValue: round2(
      rows
        .filter((r) => r.outcome !== "filled")
        .reduce((s, r) => s + (r.plannedValue ?? 0), 0),
    ),
    suitabilityBlockedValue: round2(
      rows
        .filter(
          (r) =>
            r.outcome === "rejected_suitability" || r.outcome === "blocked_pre_trade",
        )
        .reduce((s, r) => s + (r.plannedValue ?? 0), 0),
    ),
  };

  const groups = new Map<string, SuitabilityGroup>();
  for (const r of rows) {
    if (r.outcome !== "rejected_suitability" && r.outcome !== "blocked_pre_trade") continue;
    const reason = r.blockReason ?? "suitability";
    const g = groups.get(r.symbolKey);
    if (!g) {
      groups.set(r.symbolKey, {
        symbol: r.symbol,
        symbolKey: r.symbolKey,
        reason,
        attempts: 1,
        blockedValue: r.plannedValue ?? 0,
        firstSeen: r.runDate,
        lastSeen: r.runDate,
        stillBlocked: blockedKeys.has(r.symbolKey),
        recommendedAction: recommendedActionFor(reason),
        brokerText: r.brokerRejectText,
      });
      continue;
    }
    g.attempts += 1;
    g.blockedValue = round2(g.blockedValue + (r.plannedValue ?? 0));
    if (r.runDate < g.firstSeen) g.firstSeen = r.runDate;
    if (r.runDate > g.lastSeen) g.lastSeen = r.runDate;
    if (!g.brokerText && r.brokerRejectText) g.brokerText = r.brokerRejectText;
  }

  return {
    rows,
    summary,
    suitability: [...groups.values()].sort((a, b) => b.attempts - a.attempts),
  };
}
