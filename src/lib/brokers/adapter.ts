// Broker adapter interface. Client-safe types only — no server imports.

export type BrokerEnv = "sim" | "live";

export interface BrokerBalance {
  cash: number;
  currency: string;
  totalValue: number;
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
  orderType: "market" | "limit";
  limitPrice?: number;
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

export interface BrokerAdapter {
  readonly name: string;
  readonly env: BrokerEnv;
  ping(): Promise<BrokerPingResult>;
  getBalance(): Promise<BrokerBalance>;
  getPositions(): Promise<BrokerPosition[]>;
  placeOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult>;
  cancelOrder(brokerOrderId: string): Promise<{ ok: boolean; reason?: string }>;
}
