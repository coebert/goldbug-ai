// Snapshot coverage for the intended-vs-executed ORDER GRAPH.
//
// Every routing incident this app has had was really a graph problem: an
// intent that silently lost its edge to an executed order (netting cancelled
// an exit, the governor gated a leg, the broker dropped one, a fill came back
// at a bad print). Unit tests catch each hop; this file freezes the whole
// shape so CI fails loudly the moment any hop changes behaviour.
//
// Pipeline mirrored here (same modules the live executor runs):
//
//   intents → aggregateOrders (netting) → planAdmissions (cost governor)
//           → broker execution → reconcileTradeLegs (intended vs executed)
//
// The rendered graph is deterministic text: one line per intent with its
// netting decision, admission decision, executed quantity and any
// reconciliation discrepancy. Read a snapshot diff as "routing changed" —
// if the change is intended, re-record with `vitest -u` and review the diff
// line by line.

import { describe, expect, it } from "vitest";
import { aggregateOrders } from "@/lib/order-aggregation";
import {
  planAdmissions,
  governorForNav,
  type GovernorCandidate,
} from "@/lib/cost-governor";
import {
  reconcileTradeLegs,
  type ExecutedOrder,
  type IntendedLeg,
} from "@/lib/trade-leg-reconciliation";

const NAV = 10_300;
const T0 = Date.parse("2026-08-21T10:00:00Z");

type Intent = {
  decisionId: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  reason?: string;
  isAdd?: boolean;
};

/** What the broker did with the routed ticket. */
type BrokerOutcome = {
  symbol: string;
  status: "filled" | "partial" | "rejected" | "pending" | "missing";
  filledQuantity?: number;
  avgFillPrice?: number;
  rejectReason?: string;
  ageMinutes?: number;
};

type GovernorState = {
  buysAlreadyToday?: number;
  trailingCostBase?: number;
  lastBuyDaysAgo?: Record<string, number>;
};

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * Run the full pipeline and render it as a stable, reviewable graph.
 * Pure text so a snapshot diff reads like a routing changelog.
 */
function renderOrderGraph(args: {
  intents: Intent[];
  broker: BrokerOutcome[];
  governor?: GovernorState;
}): string {
  const { intents } = args;
  const brokerBySymbol = new Map(args.broker.map((b) => [b.symbol, b]));

  // 1. Netting -------------------------------------------------------------
  const agg = aggregateOrders(
    intents.map((i) => ({
      symbol: i.symbol,
      side: i.side,
      quantity: i.quantity,
      price: i.price,
      decisionId: i.decisionId,
      isAdd: i.isAdd ?? i.side === "buy",
      reason: i.reason ?? null,
    })),
  );
  const nettedBySymbol = new Map(agg.orders.map((o) => [o.symbol, o]));

  // 2. Cost governor -------------------------------------------------------
  const candidates: GovernorCandidate[] = agg.orders.map((o) => ({
    symbol: o.symbol,
    side: o.side as "buy" | "sell",
    notionalBase: o.quantity * o.price,
    estCostBase: 8,
    isAdd: Boolean(o.isAdd),
  }));
  const plan = planAdmissions(candidates, {
    navBase: NAV,
    ...governorForNav(NAV),
    buysAlreadyToday: args.governor?.buysAlreadyToday ?? 0,
    trailingCostBase: args.governor?.trailingCostBase ?? 0,
    lastBuyDaysAgo: args.governor?.lastBuyDaysAgo ?? {},
  });
  const decisionBySymbol = new Map(plan.decisions.map((d) => [d.candidate.symbol, d]));

  // 3. Execution -----------------------------------------------------------
  const orders: ExecutedOrder[] = [];
  for (const [symbol, netted] of nettedBySymbol) {
    const admitted = decisionBySymbol.get(symbol)?.kind === "admit";
    if (!admitted) continue;
    const out = brokerBySymbol.get(symbol);
    if (!out || out.status === "missing") continue; // ghost ack: nothing booked
    const filled =
      out.status === "filled"
        ? (out.filledQuantity ?? netted.quantity)
        : out.status === "partial"
          ? (out.filledQuantity ?? 0)
          : 0;
    orders.push({
      id: `O-${symbol}`,
      decisionId: netted.decisionId ?? null,
      symbol,
      side: netted.side,
      quantity: netted.quantity,
      status: out.status === "partial" ? "pending" : out.status,
      rejectReason: out.rejectReason ?? null,
      brokerOrderId: out.status === "rejected" ? null : `B-${symbol}`,
      createdAt: new Date(T0 - (out.ageMinutes ?? 1) * 60_000).toISOString(),
      filledQuantity: filled,
      avgFillPrice: filled > 0 ? (out.avgFillPrice ?? netted.price) : null,
    });
  }

  // 4. Reconciliation ------------------------------------------------------
  const intended: IntendedLeg[] = agg.orders.map((o) => ({
    decisionId: o.decisionId ?? o.symbol,
    symbol: o.symbol,
    side: o.side as "buy" | "sell",
    quantity: o.quantity,
    price: o.price,
    engineRejection:
      decisionBySymbol.get(o.symbol)?.kind === "admit"
        ? null
        : `governor: ${decisionBySymbol.get(o.symbol)?.kind ?? "unknown"}`,
  }));
  const recon = reconcileTradeLegs({ intended, orders, nowMs: T0 });
  const discBySymbol = new Map<string, string[]>();
  for (const d of recon.discrepancies) {
    const list = discBySymbol.get(d.symbol) ?? [];
    list.push(`${d.code}/${d.severity}`);
    discBySymbol.set(d.symbol, list);
  }

  // 5. Render --------------------------------------------------------------
  const lines: string[] = [];
  lines.push("INTENTS");
  for (const i of intents) {
    const netted = nettedBySymbol.get(i.symbol);
    const survived = netted && netted.side === i.side;
    const note = agg.notes.find((n) => n.symbol === i.symbol && n.side === i.side);
    const fate = survived
      ? note?.netted
        ? `netted->${netted.side} ${num(netted.quantity)}`
        : note && note.merged > 1
          ? `merged(${note.merged})->${num(netted.quantity)}`
          : "kept"
      : "cancelled-by-netting";
    lines.push(`  ${pad(i.decisionId, 6)} ${pad(`${i.side} ${i.symbol} ${num(i.quantity)}`, 26)} ${fate}`);
  }

  lines.push("ROUTED");
  for (const o of agg.orders) {
    const d = decisionBySymbol.get(o.symbol);
    const ex = orders.find((x) => x.symbol === o.symbol);
    const disc = discBySymbol.get(o.symbol);
    lines.push(
      `  ${pad(`${o.side} ${o.symbol} ${num(o.quantity)}`, 26)} governor=${pad(d?.kind ?? "n/a", 7)} ` +
        `executed=${ex ? `${ex.status} ${num(ex.filledQuantity)}` : "none"}` +
        (disc ? ` flags=[${disc.sort().join(",")}]` : ""),
    );
  }

  lines.push("SUMMARY");
  lines.push(
    `  ticketsSaved=${agg.ticketsSaved} intended=${recon.summary.intendedLegs} matched=${recon.summary.matchedLegs} ` +
      `dropped=${recon.summary.droppedLegs} mismatched=${recon.summary.mismatchedLegs} ` +
      `phantom=${recon.summary.phantomLegs} unexecuted=${num(recon.summary.unexecutedValue)}`,
  );
  return lines.join("\n");
}

describe("intended-vs-executed order graph snapshots", () => {
  it("clean tick: merges, nets the exit over the add, and fills everything", () => {
    expect(
      renderOrderGraph({
        intents: [
          { decisionId: "D1", symbol: "AAPL", side: "buy", quantity: 3, price: 190 },
          { decisionId: "D2", symbol: "AAPL", side: "buy", quantity: 2, price: 192 },
          { decisionId: "D3", symbol: "MKS.L", side: "buy", quantity: 400, price: 2, reason: "momentum add" },
          { decisionId: "D4", symbol: "MKS.L", side: "sell", quantity: 250, price: 2, reason: "thesis break" },
        ],
        broker: [
          { symbol: "AAPL", status: "filled" },
          { symbol: "MKS.L", status: "filled" },
        ],
      }),
    ).toMatchSnapshot();
  });

  it("governor-gated tick: exits admitted, adds skipped with budget exhausted", () => {
    expect(
      renderOrderGraph({
        intents: [
          { decisionId: "D1", symbol: "SGLN.L", side: "sell", quantity: 40, price: 45 },
          { decisionId: "D2", symbol: "AAPL", side: "buy", quantity: 8, price: 190 },
          { decisionId: "D3", symbol: "VMID.L", side: "buy", quantity: 2, price: 30 },
        ],
        broker: [
          { symbol: "SGLN.L", status: "filled" },
          { symbol: "AAPL", status: "filled" },
          { symbol: "VMID.L", status: "filled" },
        ],
        governor: {
          buysAlreadyToday: 99,
          trailingCostBase: 10_000,
          lastBuyDaysAgo: { AAPL: 0, "VMID.L": 0 },
        },
      }),
    ).toMatchSnapshot();
  });

  it("broker faults: dropped leg, partial fill, rejection and an adverse print", () => {
    expect(
      renderOrderGraph({
        intents: [
          { decisionId: "D1", symbol: "MKS.L", side: "sell", quantity: 900, price: 2 },
          { decisionId: "D2", symbol: "AAPL", side: "sell", quantity: 10, price: 190 },
          { decisionId: "D3", symbol: "VMID.L", side: "sell", quantity: 60, price: 30 },
          { decisionId: "D4", symbol: "XUKS.L", side: "sell", quantity: 40, price: 55 },
        ],
        broker: [
          { symbol: "MKS.L", status: "missing" }, // ghost ack, nothing booked
          { symbol: "AAPL", status: "partial", filledQuantity: 4 },
          { symbol: "VMID.L", status: "rejected", rejectReason: "not enough funds" },
          { symbol: "XUKS.L", status: "filled", avgFillPrice: 51 }, // ~-727bps
        ],
      }),
    ).toMatchSnapshot();
  });

  it("equal opposing legs drop out of the graph entirely", () => {
    expect(
      renderOrderGraph({
        intents: [
          { decisionId: "D1", symbol: "MKS.L", side: "buy", quantity: 300, price: 2 },
          { decisionId: "D2", symbol: "MKS.L", side: "sell", quantity: 300, price: 2 },
          { decisionId: "D3", symbol: "AAPL", side: "sell", quantity: 6, price: 190 },
        ],
        broker: [{ symbol: "AAPL", status: "filled" }],
      }),
    ).toMatchSnapshot();
  });

  it("stale pending exit is surfaced rather than silently waiting", () => {
    expect(
      renderOrderGraph({
        intents: [{ decisionId: "D1", symbol: "MKS.L", side: "sell", quantity: 900, price: 2 }],
        broker: [{ symbol: "MKS.L", status: "partial", filledQuantity: 0, ageMinutes: 90 }],
      }),
    ).toMatchSnapshot();
  });
});
