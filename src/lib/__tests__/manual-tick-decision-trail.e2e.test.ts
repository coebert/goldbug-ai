// End-to-end test for a manual trading tick: given an AI decision batch
// containing buys and sells, the pipeline MUST
//
//   1. Route every routable order to the broker adapter (one BrokerOrderRequest
//      per non-rejected, positive-quantity entry).
//   2. Insert exactly one `live_orders` row per routed order, keyed by a
//      deterministic `client_order_id = crypto-<portfolio>-<date>-<symbol>-<side>`
//      so repeated ticks are idempotent.
//   3. Record exactly one `ai_decision_audit` row per decision entry (buys,
//      sells, and passed-through holds), with `outcome` derived from the
//      broker status via the same mapping the DB trigger uses
//      (`tg_sync_ai_audit_from_order`):
//         submitted/accepted/pending/working → "placed"
//         filled                              → "filled"
//         partial/partially_filled            → "partial"
//         rejected                            → "rejected"
//         cancelled/canceled                  → "cancelled"
//         error                               → "error"
//      and a pre-broker skip (rejected===true on the executed entry) → "skipped".
//   4. Every audit row that produced a broker order carries the matching
//      `order_id` from the `live_orders` row inserted for that (symbol, side).
//
// This is the contract the "Run one day" button and the hourly cron rely on:
// if the mapping drifts, the Decisions tab in the UI shows "placed" for
// orders the broker actually rejected, and the operator can't tell why
// nothing traded.
//
// Composes the same conceptual pipeline as
// `src/lib/live-executor.server.ts::routeOrdersToBroker` +
// `src/lib/ai-decision-audit.server.ts::recordAiDecisionAudit` without
// touching Supabase or the Saxo HTTP client. See
// `crypto-etp-saxo-placement.e2e.test.ts` for the same style.

import { describe, it, expect } from "vitest";
import type {
  BrokerAdapter,
  BrokerBalance,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerPingResult,
  BrokerPosition,
} from "@/lib/brokers/adapter";

// ---------------------------------------------------------------------------
// Types mirroring the real DB rows (only the columns this pipeline touches).
// ---------------------------------------------------------------------------
type LiveOrderRow = {
  id: string;
  portfolio_id: string;
  decision_id: string | null;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  order_type: "market" | "limit";
  limit_price: number | null;
  status: string;
  broker_order_id: string | null;
  reject_reason: string | null;
  client_order_id: string;
};

type AuditRow = {
  portfolio_id: string;
  decision_id: string | null;
  symbol: string;
  action: "buy" | "sell" | "hold";
  requested_quantity: number;
  price: number | null;
  order_id: string | null;
  outcome: string;
  outcome_detail: string | null;
};

type DecisionEntry = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  rejected?: string; // pre-broker skip reason from trading-engine
  reason?: string;
};

type Held = { symbol: string; quantity: number };

// Same status → outcome mapping the DB trigger uses
// (`tg_sync_ai_audit_from_order`) and that `ai-decision-audit.server.ts`
// applies when it observes a live_orders row for the (symbol, side) pair.
function statusToOutcome(status: string): "placed" | "filled" | "partial" | "rejected" | "cancelled" | "error" {
  switch (status.toLowerCase()) {
    case "filled": return "filled";
    case "partial":
    case "partially_filled": return "partial";
    case "rejected": return "rejected";
    case "cancelled":
    case "canceled": return "cancelled";
    case "error": return "error";
    default: return "placed"; // pending/working/submitted/accepted
  }
}

// ---------------------------------------------------------------------------
// The pipeline under test — a manual tick that composes broker routing +
// audit recording against in-memory tables.
// ---------------------------------------------------------------------------
async function runManualTick(input: {
  portfolioId: string;
  decisionId: string;
  runDate: string; // YYYY-MM-DD
  executed: DecisionEntry[];
  heldAfter: Held[];
  adapter: BrokerAdapter;
  liveOrders: LiveOrderRow[];
  audit: AuditRow[];
}): Promise<void> {
  const { portfolioId, decisionId, runDate, executed, heldAfter, adapter, liveOrders, audit } = input;

  // Track the live_orders row we inserted for each (symbol, side) so we can
  // stamp order_id + outcome onto the matching audit row.
  const orderIndex = new Map<string, LiveOrderRow>();
  const sellSyms = new Set<string>();

  for (const e of executed) {
    if (e.side === "sell") sellSyms.add(e.symbol.toUpperCase());

    // Pre-broker skip — never touches the broker, audit outcome = "skipped".
    if (e.rejected || !(e.quantity > 0) || !Number.isFinite(e.price)) continue;

    const clientOrderId = `crypto-${portfolioId}-${runDate}-${e.symbol}-${e.side}`;

    // Idempotency: if we already inserted for this client_order_id, skip.
    if (liveOrders.some((r) => r.client_order_id === clientOrderId)) continue;

    const res: BrokerOrderResult = await adapter.placeOrder({
      symbol: e.symbol,
      side: e.side,
      quantity: e.quantity,
      orderType: "market",
      limitPrice: e.price,
      clientOrderId,
    });

    const row: LiveOrderRow = {
      id: `lo-${liveOrders.length + 1}`,
      portfolio_id: portfolioId,
      decision_id: decisionId,
      symbol: e.symbol,
      side: e.side,
      quantity: e.quantity,
      order_type: "market",
      limit_price: e.price,
      status: res.status,
      broker_order_id: res.brokerOrderId ?? null,
      reject_reason: res.reason ?? null,
      client_order_id: clientOrderId,
    };
    liveOrders.push(row);
    orderIndex.set(`${e.symbol.toUpperCase()}|${e.side}`, row);
  }

  // Emit audit rows: one per executed entry (buy/sell), plus one per still-held
  // symbol we didn't sell this tick.
  for (const e of executed) {
    const sym = e.symbol.toUpperCase();
    const row = orderIndex.get(`${sym}|${e.side}`) ?? null;
    let outcome: string;
    let detail: string | null;
    if (e.rejected) {
      outcome = "skipped";
      detail = e.rejected;
    } else if (row) {
      outcome = statusToOutcome(row.status);
      detail = row.reject_reason;
    } else {
      outcome = "skipped";
      detail = "invalid quantity/price";
    }
    audit.push({
      portfolio_id: portfolioId,
      decision_id: decisionId,
      symbol: sym,
      action: e.side,
      requested_quantity: e.quantity,
      price: e.price,
      order_id: row?.id ?? null,
      outcome,
      outcome_detail: detail,
    });
  }
  for (const h of heldAfter) {
    const sym = h.symbol.toUpperCase();
    if (sellSyms.has(sym)) continue;
    if (!(h.quantity > 0)) continue;
    audit.push({
      portfolio_id: portfolioId,
      decision_id: decisionId,
      symbol: sym,
      action: "hold",
      requested_quantity: h.quantity,
      price: null,
      order_id: null,
      outcome: "hold",
      outcome_detail: null,
    });
  }
}

// ---------------------------------------------------------------------------
// Fake broker that returns a scripted BrokerOrderResult per symbol+side.
// ---------------------------------------------------------------------------
function makeScriptedAdapter(script: Record<string, BrokerOrderResult>): {
  adapter: BrokerAdapter;
  placed: BrokerOrderRequest[];
} {
  const placed: BrokerOrderRequest[] = [];
  const adapter: BrokerAdapter = {
    name: "fake",
    env: "sim",
    async ping(): Promise<BrokerPingResult> { return { ok: true, latencyMs: 1 }; },
    async getBalance(): Promise<BrokerBalance> { return { cash: 0, currency: "GBP", totalValue: 0 }; },
    async getPositions(): Promise<BrokerPosition[]> { return []; },
    async placeOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult> {
      placed.push(req);
      const key = `${req.symbol.toUpperCase()}|${req.side}`;
      return script[key] ?? { brokerOrderId: `b-${placed.length}`, status: "submitted", filledQuantity: req.quantity, avgFillPrice: req.limitPrice };
    },
    async cancelOrder() { return { ok: true }; },
  };
  return { adapter, placed };
}

const PORTFOLIO = "pf-test";
const DECISION = "dec-1";
const RUN_DATE = "2026-07-28";

describe("E2E: manual tick creates live_orders and audit trail matches broker outcomes", () => {
  it("routes buys+sells, inserts one live_orders row per routed order, and mirrors status into the audit trail", async () => {
    const script: Record<string, BrokerOrderResult> = {
      "AAPL|buy":  { brokerOrderId: "b-aapl", status: "filled",              filledQuantity: 5, avgFillPrice: 190 },
      "MSFT|buy":  { brokerOrderId: "b-msft", status: "rejected",            reason: "InsufficientCash" },
      "GOOG|buy":  { brokerOrderId: "b-goog", status: "filled",              filledQuantity: 1, avgFillPrice: 140 },

      "TSLA|buy":  { brokerOrderId: "b-tsla", status: "submitted" },
      "NVDA|sell": { brokerOrderId: "b-nvda", status: "filled",   filledQuantity: 3, avgFillPrice: 900 },
    };
    const executed: DecisionEntry[] = [
      { symbol: "AAPL", side: "buy",  quantity: 5, price: 190 },
      { symbol: "MSFT", side: "buy",  quantity: 2, price: 420 },
      { symbol: "GOOG", side: "buy",  quantity: 2, price: 140 },
      { symbol: "TSLA", side: "buy",  quantity: 1, price: 260 },
      { symbol: "NVDA", side: "sell", quantity: 3, price: 900 },
      // Pre-broker skip — earnings blackout, e.g.
      { symbol: "ULVR.L", side: "buy", quantity: 4, price: 43.5, rejected: "overnight-gap guard" },
    ];
    const heldAfter: Held[] = [
      { symbol: "AAPL", quantity: 10 }, // still holding after the buy
      { symbol: "V",    quantity: 4 },  // untouched this tick → "hold" audit row
    ];

    const { adapter, placed } = makeScriptedAdapter(script);
    const liveOrders: LiveOrderRow[] = [];
    const audit: AuditRow[] = [];

    await runManualTick({
      portfolioId: PORTFOLIO, decisionId: DECISION, runDate: RUN_DATE,
      executed, heldAfter, adapter, liveOrders, audit,
    });

    // 1. Only non-rejected, positive-qty entries were routed to the broker.
    expect(placed.map((r) => `${r.symbol}|${r.side}`).sort()).toEqual(
      ["AAPL|buy", "GOOG|buy", "MSFT|buy", "NVDA|sell", "TSLA|buy"].sort(),
    );
    for (const r of placed) {
      expect(r.orderType).toBe("market");
      expect(r.clientOrderId).toBe(`crypto-${PORTFOLIO}-${RUN_DATE}-${r.symbol}-${r.side}`);
    }

    // 2. One live_orders row per routed order, statuses mirror the broker.
    expect(liveOrders).toHaveLength(5);
    const byKey = new Map(liveOrders.map((r) => [`${r.symbol}|${r.side}`, r] as const));
    expect(byKey.get("AAPL|buy")!.status).toBe("filled");
    expect(byKey.get("MSFT|buy")!.status).toBe("rejected");
    expect(byKey.get("MSFT|buy")!.reject_reason).toBe("InsufficientCash");
    expect(byKey.get("GOOG|buy")!.status).toBe("partial");
    expect(byKey.get("TSLA|buy")!.status).toBe("submitted");
    expect(byKey.get("NVDA|sell")!.status).toBe("filled");
    // Every routed row has the deterministic client_order_id.
    for (const r of liveOrders) {
      expect(r.client_order_id).toBe(`crypto-${PORTFOLIO}-${RUN_DATE}-${r.symbol}-${r.side}`);
      expect(r.decision_id).toBe(DECISION);
    }

    // 3. Audit trail — one row per executed entry (incl. the pre-broker skip)
    //    plus one hold row for the untouched still-held symbol.
    const auditByKey = new Map(audit.map((r) => [`${r.symbol}|${r.action}`, r] as const));
    expect(auditByKey.get("AAPL|buy")!.outcome).toBe("filled");
    expect(auditByKey.get("MSFT|buy")!.outcome).toBe("rejected");
    expect(auditByKey.get("MSFT|buy")!.outcome_detail).toBe("InsufficientCash");
    expect(auditByKey.get("GOOG|buy")!.outcome).toBe("partial");
    expect(auditByKey.get("TSLA|buy")!.outcome).toBe("placed"); // submitted → placed
    expect(auditByKey.get("NVDA|sell")!.outcome).toBe("filled");
    expect(auditByKey.get("ULVR.L|buy")!.outcome).toBe("skipped");
    expect(auditByKey.get("ULVR.L|buy")!.outcome_detail).toBe("overnight-gap guard");
    expect(auditByKey.get("ULVR.L|buy")!.order_id).toBeNull();

    // 4. Every non-skipped audit row is linked to the matching live_orders row.
    for (const [key, ar] of auditByKey) {
      if (ar.action === "hold" || ar.outcome === "skipped") continue;
      const lo = byKey.get(key);
      expect(lo, `live_orders row missing for ${key}`).toBeDefined();
      expect(ar.order_id).toBe(lo!.id);
    }

    // Hold rows: AAPL was sold this tick? No — AAPL was BOUGHT; we still hold
    // it, so a hold row is expected. V was untouched → hold row. NVDA was
    // sold, so it must NOT get a hold row even if it appears in heldAfter.
    expect(auditByKey.get("AAPL|hold")!.requested_quantity).toBe(10);
    expect(auditByKey.get("V|hold")!.requested_quantity).toBe(4);
    expect(auditByKey.has("NVDA|hold")).toBe(false);
  });

  it("is idempotent: re-running the same tick creates no duplicate live_orders", async () => {
    const { adapter } = makeScriptedAdapter({
      "AAPL|buy": { brokerOrderId: "b-aapl", status: "filled", filledQuantity: 1, avgFillPrice: 190 },
    });
    const executed: DecisionEntry[] = [{ symbol: "AAPL", side: "buy", quantity: 1, price: 190 }];
    const liveOrders: LiveOrderRow[] = [];
    const audit: AuditRow[] = [];

    await runManualTick({
      portfolioId: PORTFOLIO, decisionId: DECISION, runDate: RUN_DATE,
      executed, heldAfter: [], adapter, liveOrders, audit,
    });
    await runManualTick({
      portfolioId: PORTFOLIO, decisionId: DECISION, runDate: RUN_DATE,
      executed, heldAfter: [], adapter, liveOrders, audit,
    });

    expect(liveOrders).toHaveLength(1);
    expect(liveOrders[0].client_order_id).toBe(`crypto-${PORTFOLIO}-${RUN_DATE}-AAPL-buy`);
  });

  it("creates NO live_orders when every decision is a pre-broker skip, and every audit row is 'skipped'", async () => {
    const { adapter, placed } = makeScriptedAdapter({});
    const executed: DecisionEntry[] = [
      { symbol: "AAPL", side: "buy", quantity: 5, price: 190, rejected: "algo_regime_extreme:block-new-buys" },
      { symbol: "MSFT", side: "buy", quantity: 2, price: 420, rejected: "earnings-blackout" },
    ];
    const liveOrders: LiveOrderRow[] = [];
    const audit: AuditRow[] = [];

    await runManualTick({
      portfolioId: PORTFOLIO, decisionId: DECISION, runDate: RUN_DATE,
      executed, heldAfter: [], adapter, liveOrders, audit,
    });

    expect(placed).toHaveLength(0);
    expect(liveOrders).toHaveLength(0);
    expect(audit.map((r) => r.outcome)).toEqual(["skipped", "skipped"]);
    expect(audit.every((r) => r.order_id === null)).toBe(true);
  });

  it("propagates broker 'error' status into the audit trail unchanged", async () => {
    const { adapter } = makeScriptedAdapter({
      "AAPL|buy": { brokerOrderId: "b-aapl", status: "error", reason: "network timeout" },
    });
    const liveOrders: LiveOrderRow[] = [];
    const audit: AuditRow[] = [];

    await runManualTick({
      portfolioId: PORTFOLIO, decisionId: DECISION, runDate: RUN_DATE,
      executed: [{ symbol: "AAPL", side: "buy", quantity: 5, price: 190 }],
      heldAfter: [], adapter, liveOrders, audit,
    });

    expect(liveOrders[0].status).toBe("error");
    expect(audit[0].outcome).toBe("error");
    expect(audit[0].outcome_detail).toBe("network timeout");
    expect(audit[0].order_id).toBe(liveOrders[0].id);
  });
});
