// Broker adapter interface. Client-safe types only — no server imports.

export type BrokerEnv = "sim" | "live";

export interface BrokerBalance {
  cash: number;
  currency: string;
  totalValue: number;
  /** Cash immediately available for trading (settled, unencumbered). */
  cashAvailable?: number;
  /** Broker-authoritative spendable amount (Saxo SpendingPower or equivalent).
   *  Typically ≤ cashAvailable once margin haircuts / sub-account ring-fencing
   *  are applied. Prefer this over cashAvailable for pre-place gating. */
  spendingPower?: number;
  /** Transactions booked but not yet settled (e.g. T+2 unsettled proceeds). */
  transactionsNotBooked?: number;
  /** Cash reserved by open orders / margin collateral, unavailable to trade now. */
  reservedCash?: number;
  /** Unrealised P&L on open positions (informational). */
  unrealizedPnl?: number;
}

export interface BrokerPosition {
  symbol: string;
  quantity: number;
  avgPrice: number;
  marketPrice: number;
  currency: string;
  assetType: string;
}

export interface BrokerOrderRequest {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  orderType: "market" | "limit" | "stop";
  limitPrice?: number;
  /** Trigger price for `orderType: "stop"` (broker-side protective stop). */
  stopPrice?: number;
  /** Resting orders (stops) should outlive the session. Defaults to day. */
  duration?: "day" | "gtc";
  clientOrderId: string; // idempotency key
}

export interface BrokerOrderResult {
  brokerOrderId: string;
  status: "submitted" | "filled" | "rejected" | "error";
  filledQuantity?: number;
  avgFillPrice?: number;
  reason?: string;
  raw?: unknown;
}

export interface BrokerPingResult {
  ok: boolean;
  latencyMs: number;
  accountId?: string;
  tokenExpiresAt?: string; // ISO
  reason?: string;
}

/**
 * FX spot conversion request. `amountFrom` is expressed in `fromCcy`; the
 * broker chooses the fill rate. Callers must apply wallet deltas from the
 * returned `amountTo`, not from a locally-computed value.
 */
export interface BrokerFxSpotRequest {
  fromCcy: string;
  toCcy: string;
  amountFrom: number;
  clientOrderId: string;
}

export interface BrokerFxSpotResult extends BrokerOrderResult {
  fillRate?: number;
  amountTo?: number;
  /** Pair symbol the broker actually routed against (e.g. "GBPUSD"). */
  pairSymbol?: string;
}

export interface BrokerAdapter {
  readonly name: string;
  readonly env: BrokerEnv;
  ping(): Promise<BrokerPingResult>;
  getBalance(): Promise<BrokerBalance>;
  getPositions(): Promise<BrokerPosition[]>;
  placeOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult>;
  cancelOrder(brokerOrderId: string): Promise<{ ok: boolean; reason?: string }>;
  /**
   * Optional: place a real spot FX conversion. Adapters that don't implement
   * it force the executor to fall back to synthetic (wallet-only) FX legs.
   */
  placeFxSpot?(req: BrokerFxSpotRequest): Promise<BrokerFxSpotResult>;
}
