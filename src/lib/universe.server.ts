// Curated symbol universe by asset class. Uses Yahoo Finance ticker syntax
// (e.g. BTC-USD, GC=F, GBPUSD=X, VOD.L) which the price fetcher understands.
import type { Database } from "@/integrations/supabase/types";

export type AssetClass = Database["public"]["Enums"]["asset_class"];

export type UniverseSymbol = {
  symbol: string;
  name: string;
  asset_class: AssetClass;
};

export const UNIVERSE: UniverseSymbol[] = [
  // US stocks & ETFs
  { symbol: "SPY", name: "S&P 500 ETF", asset_class: "etf" },
  { symbol: "QQQ", name: "Nasdaq 100 ETF", asset_class: "etf" },
  { symbol: "VTI", name: "Total US Market ETF", asset_class: "etf" },
  { symbol: "AAPL", name: "Apple", asset_class: "stock" },
  { symbol: "MSFT", name: "Microsoft", asset_class: "stock" },
  { symbol: "GOOGL", name: "Alphabet", asset_class: "stock" },
  { symbol: "AMZN", name: "Amazon", asset_class: "stock" },
  { symbol: "NVDA", name: "NVIDIA", asset_class: "stock" },
  { symbol: "META", name: "Meta", asset_class: "stock" },
  { symbol: "TSLA", name: "Tesla", asset_class: "stock" },
  { symbol: "JPM", name: "JPMorgan", asset_class: "stock" },
  { symbol: "V", name: "Visa", asset_class: "stock" },
  { symbol: "JNJ", name: "Johnson & Johnson", asset_class: "stock" },
  // UK/EU
  { symbol: "VOD.L", name: "Vodafone (LON)", asset_class: "stock" },
  { symbol: "HSBA.L", name: "HSBC (LON)", asset_class: "stock" },
  { symbol: "BP.L", name: "BP (LON)", asset_class: "stock" },
  { symbol: "AZN.L", name: "AstraZeneca (LON)", asset_class: "stock" },
  { symbol: "ULVR.L", name: "Unilever (LON)", asset_class: "stock" },
  { symbol: "ISF.L", name: "iShares FTSE 100 ETF", asset_class: "etf" },
  // Crypto
  { symbol: "BTC-USD", name: "Bitcoin", asset_class: "crypto" },
  { symbol: "ETH-USD", name: "Ethereum", asset_class: "crypto" },
  { symbol: "SOL-USD", name: "Solana", asset_class: "crypto" },
  // Commodities
  { symbol: "GC=F", name: "Gold Futures", asset_class: "commodity" },
  { symbol: "SI=F", name: "Silver Futures", asset_class: "commodity" },
  { symbol: "CL=F", name: "Crude Oil Futures", asset_class: "commodity" },
  // FX
  { symbol: "GBPUSD=X", name: "GBP/USD", asset_class: "fx" },
  { symbol: "EURUSD=X", name: "EUR/USD", asset_class: "fx" },
  { symbol: "GBPEUR=X", name: "GBP/EUR", asset_class: "fx" },
];

export function filterUniverse(classes: AssetClass[]): UniverseSymbol[] {
  const allowed = new Set(classes);
  return UNIVERSE.filter((u) => allowed.has(u.asset_class));
}

export function findSymbol(sym: string): UniverseSymbol | undefined {
  return UNIVERSE.find((u) => u.symbol.toUpperCase() === sym.toUpperCase());
}

export type RiskProfile = {
  maxPositionPct: number; // max % of portfolio in any one asset
  cashFloorPct: number; // min % kept in cash
  maxNewPositionsPerDay: number;
};

export function riskProfile(level: Database["public"]["Enums"]["risk_level"]): RiskProfile {
  switch (level) {
    case "conservative":
      return { maxPositionPct: 0.1, cashFloorPct: 0.2, maxNewPositionsPerDay: 2 };
    case "aggressive":
      return { maxPositionPct: 0.25, cashFloorPct: 0.0, maxNewPositionsPerDay: 5 };
    case "balanced":
    default:
      return { maxPositionPct: 0.15, cashFloorPct: 0.1, maxNewPositionsPerDay: 3 };
  }
}

// Advanced, user-configurable risk knobs stored on portfolios.risk_config
export type ExecutionParamsConfig = {
  slippage_bps: number;
  commission_bps: number;
  spread_atr_frac: number;
  adv_participation: number;
  min_trade_value: number;
};

export type ExecutionCalibrationMeta = {
  as_of: string;
  window_days: number;
  n_symbols: number;
  notes: string[];
};

export type RiskConfig = {
  asset_class_limits: Partial<Record<AssetClass, number>>; // max % of portfolio value per class
  per_symbol_limit_pct: number | null; // if set, overrides base maxPositionPct
  stop_loss_pct: number; // 0 disables. Positive number, e.g. 0.10 = -10% from avg cost
  take_profit_pct: number; // 0 disables. e.g. 0.25 = +25% from avg cost
  atr_trailing_mult: number; // 0 disables. e.g. 3 = trail stop 3×ATR below high-water mark
  max_hold_days: number; // 0 disables. Force-exit positions held longer than N days
  volatility_sizing: boolean;
  vol_target_pct: number; // target daily volatility contribution per position (e.g. 0.015 = 1.5%)
  execution_params: Partial<ExecutionParamsConfig> | null;
  execution_calibration: ExecutionCalibrationMeta | null;
};

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  asset_class_limits: { stock: 0.6, etf: 0.8, crypto: 0.2, commodity: 0.3, fx: 0.3 },
  per_symbol_limit_pct: null,
  stop_loss_pct: 0.10,
  take_profit_pct: 0.25,
  atr_trailing_mult: 3,
  max_hold_days: 0,
  volatility_sizing: true,
  vol_target_pct: 0.015,
  execution_params: null,
  execution_calibration: null,
};

export function parseRiskConfig(raw: unknown): RiskConfig {
  const base = { ...DEFAULT_RISK_CONFIG };
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const out: RiskConfig = { ...base };
  if (r.asset_class_limits && typeof r.asset_class_limits === "object") {
    const limits: Partial<Record<AssetClass, number>> = {};
    for (const [k, v] of Object.entries(r.asset_class_limits as Record<string, unknown>)) {
      const n = Number(v);
      if (["stock", "etf", "crypto", "commodity", "fx"].includes(k) && Number.isFinite(n)) {
        limits[k as AssetClass] = Math.max(0, Math.min(1, n));
      }
    }
    out.asset_class_limits = { ...base.asset_class_limits, ...limits };
  }
  if (r.per_symbol_limit_pct === null || r.per_symbol_limit_pct === undefined) {
    out.per_symbol_limit_pct = null;
  } else {
    const n = Number(r.per_symbol_limit_pct);
    out.per_symbol_limit_pct = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
  }
  if (Number.isFinite(Number(r.stop_loss_pct))) out.stop_loss_pct = Math.max(0, Math.min(0.9, Number(r.stop_loss_pct)));
  if (Number.isFinite(Number(r.take_profit_pct))) out.take_profit_pct = Math.max(0, Math.min(5, Number(r.take_profit_pct)));
  if (Number.isFinite(Number(r.atr_trailing_mult))) out.atr_trailing_mult = Math.max(0, Math.min(10, Number(r.atr_trailing_mult)));
  if (Number.isFinite(Number(r.max_hold_days))) out.max_hold_days = Math.max(0, Math.min(3650, Math.floor(Number(r.max_hold_days))));
  if (typeof r.volatility_sizing === "boolean") out.volatility_sizing = r.volatility_sizing;
  if (Number.isFinite(Number(r.vol_target_pct))) out.vol_target_pct = Math.max(0.001, Math.min(0.1, Number(r.vol_target_pct)));
  if (r.execution_params && typeof r.execution_params === "object") {
    const e = r.execution_params as Record<string, unknown>;
    const ep: Partial<ExecutionParamsConfig> = {};
    const num = (k: keyof ExecutionParamsConfig, min: number, max: number) => {
      const n = Number(e[k]);
      if (Number.isFinite(n)) ep[k] = Math.max(min, Math.min(max, n));
    };
    num("slippage_bps", 0, 500);
    num("commission_bps", 0, 500);
    num("spread_atr_frac", 0, 2);
    num("adv_participation", 0, 0.5);
    num("min_trade_value", 0, 10_000);
    out.execution_params = ep;
  }
  if (r.execution_calibration && typeof r.execution_calibration === "object") {
    const c = r.execution_calibration as Record<string, unknown>;
    const notes = Array.isArray(c.notes) ? (c.notes as unknown[]).filter((x): x is string => typeof x === "string") : [];
    out.execution_calibration = {
      as_of: String(c.as_of ?? ""),
      window_days: Number(c.window_days ?? 0),
      n_symbols: Number(c.n_symbols ?? 0),
      notes,
    };
  }
  return out;
}


