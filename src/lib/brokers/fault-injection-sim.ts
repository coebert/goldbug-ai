// Fault-injecting broker simulator.
//
// The pure ledger simulator (`src/lib/broker-simulator.ts`) answers "is the
// arithmetic sound?". This module answers a different question: "when the
// broker misbehaves, does our reconciliation still tell the truth?".
//
// Every fault modelled here is one we have actually seen from Saxo:
//
//   timeout        The HTTP call dies after the order was already accepted.
//                  The order EXISTS broker-side; a naive retry double-trades.
//   duplicate_ack  The broker acknowledges the same client order id twice.
//                  Correct behaviour is idempotent (one book entry); the
//                  `duplicateBooks` variant models the broken behaviour where
//                  two entries are booked and we over-fill.
//   missing_leg    The API returns a healthy ack with a broker order id, but
//                  nothing is ever booked — the leg silently vanishes.
//   partial_fill   Only part of the quantity executes.
//   adverse_price  The fill prints materially away from the intent.
//   reject         An explicit, reasoned broker rejection (the benign case).
//
// The simulator keeps a broker-side book that is deliberately NOT derived from
// what `placeOrder` returned to the caller — that divergence is the whole
// point. `toExecutedOrders()` exposes the book in exactly the shape
// `reconcileTradeLegs` consumes, so tests can assert that reconciliation
// reconstructs reality from the broker's records rather than from our
// optimistic client-side view.
//
// Deterministic: same seed + same script ⇒ identical outcomes. No I/O, no
// timers, no randomness beyond the seeded generator, so it is safe to import
// from tests and backtests alike.

import type {
  BrokerAdapter,
  BrokerBalance,
  BrokerEnv,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerPingResult,
  BrokerPosition,
} from "./adapter";
import type { ExecutedOrder } from "../trade-leg-reconciliation";

export type FaultKind =
  | "timeout"
  | "duplicate_ack"
  | "missing_leg"
  | "partial_fill"
  | "adverse_price"
  | "reject";

export interface FaultRule {
  kind: FaultKind;
  /** Restrict to a symbol (exact match on the request symbol). */
  symbol?: string;
  /** Restrict to a side. */
  side?: "buy" | "sell";
  /** How many times this rule may fire. Defaults to 1; `Infinity` for always. */
  times?: number;
  /** partial_fill: fraction of the requested quantity that executes (0..1). */
  fillFraction?: number;
  /** adverse_price: signed bps applied against the caller (always adverse). */
  adverseBps?: number;
  /** reject: the reason text the broker states. */
  reason?: string;
  /**
   * duplicate_ack only. When true the broker books TWO entries for one client
   * order id (the broken behaviour we must detect). When false/omitted the
   * duplicate ack is idempotent and books once.
   */
  duplicateBooks?: boolean;
  /**
   * timeout only. When true the order is NOT booked broker-side either — a
   * true dropped request rather than a lost response.
   */
  timeoutDropsOrder?: boolean;
}

export interface SimBookEntry {
  id: string;
  brokerOrderId: string;
  clientOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  filledQuantity: number;
  avgFillPrice: number | null;
  status: "filled" | "working" | "rejected";
  rejectReason: string | null;
  createdAt: string;
  /** Which injected fault, if any, produced this entry. */
  fault: FaultKind | null;
}

export interface FaultEvent {
  kind: FaultKind;
  clientOrderId: string;
  symbol: string;
  side: "buy" | "sell";
  detail: string;
}

export class BrokerTimeoutError extends Error {
  readonly clientOrderId: string;
  /** True when the order was accepted broker-side despite the timeout. */
  readonly maybeAccepted: boolean;
  constructor(clientOrderId: string, maybeAccepted: boolean) {
    super(
      `Broker request timed out for ${clientOrderId}` +
        (maybeAccepted ? " (order may have been accepted)" : ""),
    );
    this.name = "BrokerTimeoutError";
    this.clientOrderId = clientOrderId;
    this.maybeAccepted = maybeAccepted;
  }
}

export interface FaultSimOptions {
  faults?: FaultRule[];
  /** Deterministic seed for anything unspecified by a rule. */
  seed?: number;
  /** Reference price per symbol, used when the request carries no price. */
  prices?: Record<string, number>;
  startingCash?: number;
  currency?: string;
  positions?: BrokerPosition[];
  /** Wall-clock base for `createdAt`; each order advances it by 1 second. */
  startedAtMs?: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A `BrokerAdapter` that misbehaves on demand.
 *
 * Idempotency contract: a `clientOrderId` already present in the book is never
 * booked twice, except under an explicit `duplicate_ack` rule with
 * `duplicateBooks: true`. This is what makes post-timeout retries safe, and
 * what the e2e assertions pin down.
 */
export class FaultInjectingBroker implements BrokerAdapter {
  readonly name = "fault-sim";
  readonly env: BrokerEnv = "sim";

  private readonly rules: Array<FaultRule & { remaining: number }>;
  private readonly rand: () => number;
  private readonly prices: Record<string, number>;
  private readonly currency: string;
  private cash: number;
  private readonly positions: BrokerPosition[];
  private clock: number;
  private seq = 0;

  readonly book: SimBookEntry[] = [];
  readonly events: FaultEvent[] = [];
  /** Every placeOrder call, including the ones that threw. */
  readonly attempts: Array<{ clientOrderId: string; symbol: string; side: "buy" | "sell" }> = [];

  constructor(opts: FaultSimOptions = {}) {
    this.rules = (opts.faults ?? []).map((r) => ({
      ...r,
      remaining: r.times ?? 1,
    }));
    this.rand = mulberry32(opts.seed ?? 1);
    this.prices = opts.prices ?? {};
    this.currency = opts.currency ?? "GBP";
    this.cash = opts.startingCash ?? 100_000;
    this.positions = opts.positions ?? [];
    this.clock = opts.startedAtMs ?? Date.parse("2026-08-21T10:00:00Z");
  }

  // ------------------------------------------------------------- internals

  private takeRule(req: BrokerOrderRequest): (FaultRule & { remaining: number }) | null {
    for (const rule of this.rules) {
      if (rule.remaining <= 0) continue;
      if (rule.symbol && rule.symbol !== req.symbol) continue;
      if (rule.side && rule.side !== req.side) continue;
      rule.remaining -= 1;
      return rule;
    }
    return null;
  }

  private nextTimestamp(): string {
    this.clock += 1_000;
    return new Date(this.clock).toISOString();
  }

  private priceFor(req: BrokerOrderRequest): number {
    const quoted = req.limitPrice ?? req.stopPrice ?? this.prices[req.symbol];
    if (Number.isFinite(quoted) && (quoted as number) > 0) return quoted as number;
    // Deterministic fallback so a missing price never makes a test flaky.
    return 100 + Math.round(this.rand() * 100) / 100;
  }

  private existing(clientOrderId: string): SimBookEntry | undefined {
    return this.book.find((o) => o.clientOrderId === clientOrderId);
  }

  private bookOrder(
    req: BrokerOrderRequest,
    over: Partial<SimBookEntry> & { fault: FaultKind | null },
  ): SimBookEntry {
    this.seq += 1;
    const price = this.priceFor(req);
    const entry: SimBookEntry = {
      id: `sim-order-${this.seq}`,
      brokerOrderId: `SAXO-${100_000 + this.seq}`,
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      side: req.side,
      quantity: req.quantity,
      filledQuantity: req.quantity,
      avgFillPrice: price,
      status: "filled",
      rejectReason: null,
      createdAt: this.nextTimestamp(),
      ...over,
    };
    this.book.push(entry);
    if (entry.status === "filled") {
      const notional = entry.filledQuantity * (entry.avgFillPrice ?? 0);
      this.cash += entry.side === "buy" ? -notional : notional;
    }
    return entry;
  }

  private record(kind: FaultKind, req: BrokerOrderRequest, detail: string): void {
    this.events.push({
      kind,
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      side: req.side,
      detail,
    });
  }

  // ------------------------------------------------------ adapter surface

  async ping(): Promise<BrokerPingResult> {
    return { ok: true, latencyMs: 1, accountId: "sim-account" };
  }

  async getBalance(): Promise<BrokerBalance> {
    return {
      cash: this.cash,
      currency: this.currency,
      totalValue: this.cash,
      cashAvailable: this.cash,
      spendingPower: this.cash,
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    return this.positions.map((p) => ({ ...p }));
  }

  async placeOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult> {
    this.attempts.push({
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      side: req.side,
    });

    // Idempotency first: a retry of a known client order id never re-books.
    const prior = this.existing(req.clientOrderId);
    if (prior) {
      const dupRule = this.rules.find(
        (r) =>
          r.kind === "duplicate_ack" &&
          r.remaining > 0 &&
          (!r.symbol || r.symbol === req.symbol) &&
          (!r.side || r.side === req.side),
      );
      if (dupRule?.duplicateBooks) {
        dupRule.remaining -= 1;
        const dup = this.bookOrder(req, { fault: "duplicate_ack" });
        this.record(
          "duplicate_ack",
          req,
          `Broker booked a SECOND entry ${dup.brokerOrderId} for ${req.clientOrderId}.`,
        );
        return {
          brokerOrderId: dup.brokerOrderId,
          status: "filled",
          filledQuantity: dup.filledQuantity,
          avgFillPrice: dup.avgFillPrice ?? undefined,
        };
      }
      this.record(
        "duplicate_ack",
        req,
        `Idempotent replay of ${req.clientOrderId} → ${prior.brokerOrderId}.`,
      );
      return {
        brokerOrderId: prior.brokerOrderId,
        status: prior.status === "filled" ? "filled" : "submitted",
        filledQuantity: prior.filledQuantity,
        avgFillPrice: prior.avgFillPrice ?? undefined,
      };
    }

    const rule = this.takeRule(req);

    switch (rule?.kind) {
      case "timeout": {
        const dropped = rule.timeoutDropsOrder === true;
        if (!dropped) {
          // The order landed; only the response was lost.
          this.bookOrder(req, { fault: "timeout" });
        }
        this.record(
          "timeout",
          req,
          dropped
            ? `Request for ${req.clientOrderId} never reached the broker.`
            : `Response lost for ${req.clientOrderId}; order accepted broker-side.`,
        );
        throw new BrokerTimeoutError(req.clientOrderId, !dropped);
      }

      case "missing_leg": {
        // Healthy-looking ack, nothing booked. The worst failure mode: our
        // ledger believes it traded and the broker has no record at all.
        this.seq += 1;
        const phantomId = `SAXO-GHOST-${100_000 + this.seq}`;
        this.record(
          "missing_leg",
          req,
          `Acked ${phantomId} for ${req.clientOrderId} but booked nothing.`,
        );
        return { brokerOrderId: phantomId, status: "submitted" };
      }

      case "partial_fill": {
        const frac = Math.min(1, Math.max(0, rule.fillFraction ?? 0.4));
        const filled = Math.floor(req.quantity * frac);
        const entry = this.bookOrder(req, {
          fault: "partial_fill",
          filledQuantity: filled,
          status: filled > 0 ? "filled" : "working",
        });
        this.record(
          "partial_fill",
          req,
          `Filled ${filled} of ${req.quantity} ${req.symbol}.`,
        );
        return {
          brokerOrderId: entry.brokerOrderId,
          status: "filled",
          filledQuantity: filled,
          avgFillPrice: entry.avgFillPrice ?? undefined,
        };
      }

      case "adverse_price": {
        const bps = Math.abs(rule.adverseBps ?? 300);
        const base = this.priceFor(req);
        const price = req.side === "buy" ? base * (1 + bps / 10_000) : base * (1 - bps / 10_000);
        const entry = this.bookOrder(req, { fault: "adverse_price", avgFillPrice: price });
        this.record("adverse_price", req, `Printed ${price.toFixed(4)} vs ${base.toFixed(4)}.`);
        return {
          brokerOrderId: entry.brokerOrderId,
          status: "filled",
          filledQuantity: entry.filledQuantity,
          avgFillPrice: price,
        };
      }

      case "reject": {
        const reason = rule.reason ?? "Not enough funds";
        const entry = this.bookOrder(req, {
          fault: "reject",
          status: "rejected",
          filledQuantity: 0,
          avgFillPrice: null,
          rejectReason: reason,
        });
        this.record("reject", req, reason);
        return { brokerOrderId: entry.brokerOrderId, status: "rejected", reason };
      }

      default: {
        const entry = this.bookOrder(req, { fault: null });
        return {
          brokerOrderId: entry.brokerOrderId,
          status: "filled",
          filledQuantity: entry.filledQuantity,
          avgFillPrice: entry.avgFillPrice ?? undefined,
        };
      }
    }
  }

  async cancelOrder(brokerOrderId: string): Promise<{ ok: boolean; reason?: string }> {
    const entry = this.book.find((o) => o.brokerOrderId === brokerOrderId);
    if (!entry) return { ok: false, reason: "unknown order" };
    if (entry.status === "filled") return { ok: false, reason: "already filled" };
    entry.status = "rejected";
    entry.rejectReason = "cancelled by client";
    return { ok: true };
  }

  // ----------------------------------------------------------- inspection

  /** The broker's own book, in the shape `reconcileTradeLegs` consumes. */
  toExecutedOrders(decisionIdForClientOrderId?: (clientOrderId: string) => string | null): ExecutedOrder[] {
    return this.book.map((o) => ({
      id: o.id,
      decisionId: decisionIdForClientOrderId?.(o.clientOrderId) ?? o.clientOrderId,
      symbol: o.symbol,
      side: o.side,
      quantity: o.quantity,
      status: o.status === "rejected" ? "rejected" : o.status,
      rejectReason: o.rejectReason,
      brokerOrderId: o.brokerOrderId,
      createdAt: o.createdAt,
      filledQuantity: o.filledQuantity,
      avgFillPrice: o.avgFillPrice,
    }));
  }

  /** Net executed quantity per symbol, signed (+bought / −sold). */
  netExecuted(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const o of this.book) {
      if (o.status !== "filled" || o.filledQuantity <= 0) continue;
      out[o.symbol] = (out[o.symbol] ?? 0) + (o.side === "buy" ? o.filledQuantity : -o.filledQuantity);
    }
    return out;
  }

  faultsFired(): FaultKind[] {
    return this.events.map((e) => e.kind);
  }
}
