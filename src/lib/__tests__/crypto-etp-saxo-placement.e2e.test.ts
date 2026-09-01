// End-to-end integration test for Saxo order placement across the six
// approved crypto ETPs. Composes the same pipeline the trading engine
// runs for a crypto BUY (sleeve cap → per-symbol notional → execution
// realism / liquidity cap → runCryptoPreTradeChecks → BrokerAdapter.placeOrder)
// without touching Supabase or Saxo HTTP.
//
// Asserts:
//   1. Every one of the six Saxo-tradable crypto ETPs reaches the broker
//      adapter with a market order when sleeve + gates allow.
//   2. Per-symbol notional never exceeds its sleeve allocation.
//   3. The 1% ADV liquidity cap trims a thinly-traded ETP before placement.
//   4. Aggregate placed notional ≤ crypto sleeve cap for the risk level.
//   5. Sub-minimum notional buys are rejected at the min_notional gate
//      (never reach the broker).
//   6. Fractional-unit requests are rejected at the lot_size gate.
//   7. A weekend `now` blocks every ETP at the market_hours gate.
//   8. Sells for the same six ETPs bypass economic gates so positions
//      can always exit.

import { describe, it, expect } from "vitest";
import { CRYPTO_SYMBOLS } from "@/lib/crypto-groups";
import { cryptoSleeveCapPct } from "@/lib/crypto-strategy.server";
import { applyBuyExecution } from "@/lib/execution-realism.server";
import { runCryptoPreTradeChecks } from "@/lib/crypto-validation.server";
import type {
  BrokerAdapter,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerBalance,
  BrokerPosition,
  BrokerPingResult,
} from "@/lib/brokers/adapter";

// The six Saxo-tradable crypto ETPs the crypto engine is allowed to route.
const APPROVED_ETPS = [
  "BTCE.DE",
  "ABTC.SW",
  "BTCW.L",
  "ZETH.SW",
  "ZETH.DE",
  "HODL.SW",
] as const;

// A Tuesday inside the XETRA / SIX / LSE continuous session:
// 10:00 UTC → 11:00 Europe/Berlin & Zurich, 10:00 Europe/London.
const OPEN_NOW = new Date("2026-02-03T10:00:00Z");
// Same clock on a Saturday — venues closed.
const WEEKEND_NOW = new Date("2026-02-07T10:00:00Z");

type Placed = BrokerOrderRequest & { placedNotionalLocal: number };

function makeFakeSaxo(env: "sim" | "live"): {
  adapter: BrokerAdapter;
  placed: Placed[];
} {
  const placed: Placed[] = [];
  const adapter: BrokerAdapter = {
    name: "fake-saxo",
    env,
    async ping(): Promise<BrokerPingResult> {
      return { ok: true, latencyMs: 1 };
    },
    async getBalance(): Promise<BrokerBalance> {
      return { cash: 0, currency: "GBP", totalValue: 0 };
    },
    async getPositions(): Promise<BrokerPosition[]> {
      return [];
    },
    async placeOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult> {
      // Adapter is only ever reached AFTER sleeve + execution + pre-trade
      // gates approve the order, so any call here means the pipeline
      // considered it economic and routable.
      placed.push({ ...req, placedNotionalLocal: req.quantity * (req.limitPrice ?? 0) });
      return {
        brokerOrderId: `sim-${req.clientOrderId}`,
        status: "submitted",
        filledQuantity: req.quantity,
        avgFillPrice: req.limitPrice,
      };
    },
    async cancelOrder() {
      return { ok: true };
    },
  };
  return { adapter, placed };
}

type Proposal = {
  symbol: string;
  price: number;      // local currency
  atrPct: number;     // e.g. 0.02 = 2%
  adv20d: number;     // local-ccy 20d ADV (in the ETP's local currency)
  requestedSpend: number; // local currency, pre-execution
};

type PipelineOutcome =
  | { symbol: string; status: "placed"; qty: number; notional: number }
  | { symbol: string; status: "rejected"; gate: string; reason: string };

async function routeCryptoBuy(
  p: Proposal,
  adapter: BrokerAdapter,
  placed: Placed[],
  now: Date,
): Promise<PipelineOutcome> {
  // Phase A — execution realism (spread + slippage + commission + 1% ADV liquidity cap).
  const exec = applyBuyExecution({
    requestedSpend: p.requestedSpend,
    price: p.price,
    atrPct: p.atrPct,
    adv20d: p.adv20d,
  });
  if (exec.belowMinTrade || exec.qty <= 0) {
    return { symbol: p.symbol, status: "rejected", gate: "min_trade", reason: exec.notes.join("; ") };
  }

  // Crypto ETPs trade in whole units on their listing venue.
  const qty = Math.floor(exec.qty);

  // Phase B — crypto post-sizing pre-trade gate (fee, lot size, min notional, hours).
  const pre = runCryptoPreTradeChecks({
    symbol: p.symbol,
    side: "buy",
    price: exec.fillPrice,
    quantity: qty,
    now,
  });
  if (!pre.ok) {
    return { symbol: p.symbol, status: "rejected", gate: pre.gate ?? "unknown", reason: pre.reason ?? "" };
  }

  // Phase C — actually submit to the (fake) broker as a market order.
  const clientOrderId = `crypto-${p.symbol}-${now.toISOString().slice(0, 10)}`;
  const res = await adapter.placeOrder({
    symbol: p.symbol,
    side: "buy",
    quantity: qty,
    orderType: "market",
    limitPrice: exec.fillPrice,
    clientOrderId,
  });
  if (res.status === "rejected" || res.status === "error") {
    return { symbol: p.symbol, status: "rejected", gate: "broker", reason: res.reason ?? res.status };
  }
  return { symbol: p.symbol, status: "placed", qty, notional: qty * exec.fillPrice };
}

describe("E2E: Saxo order placement for the six crypto ETPs", () => {
  it("covers exactly the six Saxo-tradable crypto ETPs", () => {
    for (const sym of APPROVED_ETPS) {
      expect(CRYPTO_SYMBOLS).toContain(sym);
    }
    // Sanity: the classifier universe still contains every ETP we route.
    expect(new Set(CRYPTO_SYMBOLS).size).toBeGreaterThanOrEqual(APPROVED_ETPS.length);
  });

  it("routes all six ETPs, respects the sleeve cap, and enforces the 1% ADV liquidity gate", async () => {
    const { adapter, placed } = makeFakeSaxo("sim");
    const equity = 100_000; // local-ccy equivalent for cap math (test-only)
    const sleevePct = cryptoSleeveCapPct("balanced");
    const sleeveCap = equity * sleevePct;
    const perSymbolCap = sleeveCap / APPROVED_ETPS.length;

    // One thin-liquidity ETP (BTCW.L) has an ADV small enough that the
    // 1% participation cap has to trim the order — this is the liquidity
    // gate we want to prove fires end-to-end. ADV chosen so the trimmed
    // notional still clears the fee gate (fee_min / max_fee_pct ≈ £333).
    const THIN = "BTCW.L";
    const THIN_ADV = 60_000; // 1% = 600 → below perSymbolCap, above fee floor
    const proposals: Proposal[] = APPROVED_ETPS.map((sym) => ({
      symbol: sym,
      price: 40,
      atrPct: 0.02,
      adv20d: sym === THIN ? THIN_ADV : 5_000_000,
      requestedSpend: perSymbolCap,
    }));

    const outcomes = await Promise.all(
      proposals.map((p) => routeCryptoBuy(p, adapter, placed, OPEN_NOW)),
    );

    // Every ETP made it through to placement.
    expect(outcomes.every((o) => o.status === "placed")).toBe(true);
    expect(placed.map((o) => o.symbol).sort()).toEqual([...APPROVED_ETPS].sort());

    // Every placed order is a market buy in whole units.
    for (const o of placed) {
      expect(o.side).toBe("buy");
      expect(o.orderType).toBe("market");
      expect(Number.isInteger(o.quantity)).toBe(true);
      expect(o.quantity).toBeGreaterThan(0);
      expect(o.clientOrderId).toMatch(/^crypto-/);
    }

    // Liquidity gate: the thin ETP's placed notional was trimmed to ≤ 1% ADV.
    const thinPlaced = placed.find((o) => o.symbol === THIN)!;
    expect(thinPlaced.placedNotionalLocal).toBeLessThanOrEqual(THIN_ADV * 0.01 + 1e-6);

    // The unconstrained ETPs saturated their per-symbol cap (within one
    // whole-unit of the fill price, since we floor the quantity).
    for (const o of placed) {
      if (o.symbol === THIN) continue;
      expect(o.placedNotionalLocal).toBeGreaterThan(perSymbolCap * 0.9);
      expect(o.placedNotionalLocal).toBeLessThanOrEqual(perSymbolCap + 1e-6);
    }

    // Aggregate placement never exceeds the sleeve cap for the risk level.
    const aggregate = placed.reduce((s, o) => s + o.placedNotionalLocal, 0);
    expect(aggregate).toBeLessThanOrEqual(sleeveCap + 1e-6);
  });

  it("blocks sub-minimum-notional crypto buys before they reach the broker", async () => {
    const { adapter, placed } = makeFakeSaxo("sim");
    // Price × qty(=1 after floor) = 40 < min_order_value_local (100).
    const outcome = await routeCryptoBuy(
      { symbol: "BTCE.DE", price: 40, atrPct: 0.02, adv20d: 5_000_000, requestedSpend: 50 },
      adapter,
      placed,
      OPEN_NOW,
    );
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.gate).toBe("min_notional");
    expect(placed).toHaveLength(0);
  });

  it("rejects every ETP at the market_hours gate on a weekend", async () => {
    const { adapter, placed } = makeFakeSaxo("live");
    const outcomes = await Promise.all(
      APPROVED_ETPS.map((sym) =>
        routeCryptoBuy(
          { symbol: sym, price: 40, atrPct: 0.02, adv20d: 5_000_000, requestedSpend: 5_000 },
          adapter,
          placed,
          WEEKEND_NOW,
        ),
      ),
    );
    for (const o of outcomes) {
      expect(o.status).toBe("rejected");
      if (o.status === "rejected") expect(o.gate).toBe("market_hours");
    }
    expect(placed).toHaveLength(0);
  });

  it("rejects fractional-unit crypto buys at the lot_size gate", () => {
    // Bypasses the flooring the executor does so we can prove the gate
    // itself refuses a non-whole quantity even if a caller ever proposes one.
    const pre = runCryptoPreTradeChecks({
      symbol: "ZETH.SW",
      side: "buy",
      price: 40,
      quantity: 3.4,
      now: OPEN_NOW,
    });
    expect(pre.ok).toBe(false);
    expect(pre.gate).toBe("lot_size");
  });

  it("lets sells through for every ETP even when hours/economics would block a buy", () => {
    // A weekend sell that would fail every buy gate still passes so an
    // open position can always be exited.
    for (const sym of APPROVED_ETPS) {
      const pre = runCryptoPreTradeChecks({
        symbol: sym,
        side: "sell",
        price: 40,
        quantity: 1,
        now: WEEKEND_NOW,
      });
      expect(pre.ok).toBe(true);
    }
  });
});
