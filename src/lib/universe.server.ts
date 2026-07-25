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
  // UK/EU — includes low-priced LSE stocks & ETFs so small GBP accounts can trade
  { symbol: "VOD.L", name: "Vodafone (LON)", asset_class: "stock" },
  { symbol: "HSBA.L", name: "HSBC (LON)", asset_class: "stock" },
  { symbol: "BP.L", name: "BP (LON)", asset_class: "stock" },
  { symbol: "AZN.L", name: "AstraZeneca (LON)", asset_class: "stock" },
  { symbol: "ULVR.L", name: "Unilever (LON)", asset_class: "stock" },
  { symbol: "LLOY.L", name: "Lloyds Banking Group (LON)", asset_class: "stock" },
  { symbol: "ITV.L", name: "ITV (LON)", asset_class: "stock" },
  { symbol: "TSCO.L", name: "Tesco (LON)", asset_class: "stock" },
  { symbol: "SGE.L", name: "Sage Group (LON)", asset_class: "stock" },
  { symbol: "GLEN.L", name: "Glencore (LON)", asset_class: "stock" },
  { symbol: "RR.L", name: "Rolls-Royce (LON)", asset_class: "stock" },
  { symbol: "BARC.L", name: "Barclays (LON)", asset_class: "stock" },
  { symbol: "NWG.L", name: "NatWest Group (LON)", asset_class: "stock" },
  { symbol: "MKS.L", name: "Marks & Spencer (LON)", asset_class: "stock" },
  { symbol: "ISF.L", name: "iShares FTSE 100 ETF", asset_class: "etf" },
  { symbol: "VUKE.L", name: "Vanguard FTSE 100 ETF", asset_class: "etf" },
  { symbol: "VMID.L", name: "Vanguard FTSE 250 ETF", asset_class: "etf" },
  { symbol: "VWRL.L", name: "Vanguard FTSE All-World ETF", asset_class: "etf" },
  { symbol: "VUSA.L", name: "Vanguard S&P 500 ETF (LON)", asset_class: "etf" },
  // Crypto
  { symbol: "BTC-USD", name: "Bitcoin", asset_class: "crypto" },
  { symbol: "ETH-USD", name: "Ethereum", asset_class: "crypto" },
  { symbol: "SOL-USD", name: "Solana", asset_class: "crypto" },
  // Commodities — LSE-listed physically-backed ETCs/ETFs (Saxo-tradable
  // AssetType=Etc/Etf). Futures pseudo-symbols like GC=F/SI=F/CL=F are
  // intentionally excluded because Saxo cash accounts cannot route them.
  { symbol: "SGLN.L", name: "iShares Physical Gold ETC (LON)", asset_class: "commodity" },
  { symbol: "SGLD.L", name: "Invesco Physical Gold ETC (LON)", asset_class: "commodity" },
  { symbol: "PHAU.L", name: "WisdomTree Physical Gold (LON)", asset_class: "commodity" },
  { symbol: "SSLN.L", name: "iShares Physical Silver ETC (LON)", asset_class: "commodity" },
  { symbol: "PHAG.L", name: "WisdomTree Physical Silver (LON)", asset_class: "commodity" },
  { symbol: "SPLT.L", name: "WisdomTree Physical Platinum (LON)", asset_class: "commodity" },
  { symbol: "CRUD.L", name: "WisdomTree WTI Crude Oil (LON)", asset_class: "commodity" },
  { symbol: "BRNT.L", name: "WisdomTree Brent Crude Oil (LON)", asset_class: "commodity" },
  { symbol: "NGAS.L", name: "WisdomTree Natural Gas (LON)", asset_class: "commodity" },
  { symbol: "COPA.L", name: "WisdomTree Copper (LON)", asset_class: "commodity" },
  { symbol: "AGCP.L", name: "WisdomTree Agriculture (LON)", asset_class: "commodity" },
  { symbol: "AIGB.L", name: "WisdomTree Broad Commodities (LON)", asset_class: "commodity" },
  // US-listed commodity ETFs (USD) so USD-funded portfolios can also gain
  // commodity exposure via Saxo cash.
  { symbol: "GLD", name: "SPDR Gold Shares (NYSE)", asset_class: "commodity" },
  { symbol: "IAU", name: "iShares Gold Trust (NYSE)", asset_class: "commodity" },
  { symbol: "SLV", name: "iShares Silver Trust (NYSE)", asset_class: "commodity" },
  { symbol: "USO", name: "United States Oil Fund (NYSE)", asset_class: "commodity" },
  { symbol: "DBC", name: "Invesco DB Commodity Index (NYSE)", asset_class: "commodity" },
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

import type { CommodityGroup } from "./commodity-groups";

export type RiskConfig = {
  asset_class_limits: Partial<Record<AssetClass, number>>;
  per_symbol_limit_pct: number | null;
  stop_loss_pct: number;
  take_profit_pct: number;
  atr_trailing_mult: number;
  max_hold_days: number;
  volatility_sizing: boolean;
  vol_target_pct: number;
  max_daily_loss_pct: number;
  max_drawdown_halt_pct: number;
  execution_params: Partial<ExecutionParamsConfig> | null;
  execution_calibration: ExecutionCalibrationMeta | null;
  commodity_group_limits: Partial<Record<CommodityGroup, number>>;
  commodity_min_adv_usd: number;
  commodity_max_atr_pct: number;
  // Phase 3 — multi-layer exits (all optional, defaults preserve existing behaviour when disabled).
  chandelier_enabled: boolean;
  chandelier_k_base: number;
  chandelier_k_tight: number;
  chandelier_tighten_after_r: number;
  initial_stop_atr_mult: number;
  scale_out_enabled: boolean;
  scale_out_levels: Array<{ r: number; frac: number }>;
  time_stop_enabled: boolean;
  time_stop_horizon_days: number;
  time_stop_min_progress_r: number;
  event_blackout_enabled: boolean;
  event_blackout_pct_nav: number;
  event_blackout_target_pct_nav: number;
  event_blackout_window_days: number;
  reentry_lockout_enabled: boolean;
  reentry_atr_days_mult: number;
  reentry_min_days: number;
  reentry_max_days: number;
  // Phase 2 + 5 — sizing bonuses & risk-parity target construction.
  alpha_bonus_enabled: boolean;
  alpha_bonus_cap: number;
  risk_parity_enabled: boolean;
  risk_parity_nav_cap: number;
  // Phase 6 — execution alpha (slicing + time-of-day filter).
  execution_slicing_enabled: boolean;
  execution_max_child_notional: number;
  execution_participation_cap: number; // fraction of 20d ADV per child
  tod_filter_enabled: boolean;
  tod_avoid_open_min: number;
  tod_avoid_close_min: number;
  tod_open_haircut: number; // 0..1 multiplier inside soft open window
  tod_close_haircut: number;
  tod_hard_block_open_min: number;
  tod_hard_block_close_min: number;
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
  max_daily_loss_pct: 0.05,
  max_drawdown_halt_pct: 0.20,
  execution_params: null,
  execution_calibration: null,
  commodity_group_limits: { Gold: 0.2, Basket: 0.15 },
  commodity_min_adv_usd: 250_000,
  commodity_max_atr_pct: 0.06,
  chandelier_enabled: true,
  chandelier_k_base: 3.0,
  chandelier_k_tight: 1.5,
  chandelier_tighten_after_r: 2.0,
  initial_stop_atr_mult: 2.5,
  scale_out_enabled: true,
  scale_out_levels: [{ r: 1, frac: 0.25 }, { r: 2, frac: 0.25 }],
  time_stop_enabled: true,
  time_stop_horizon_days: 30,
  time_stop_min_progress_r: 0.5,
  event_blackout_enabled: true,
  event_blackout_pct_nav: 0.06,
  event_blackout_target_pct_nav: 0.03,
  event_blackout_window_days: 3,
  reentry_lockout_enabled: true,
  reentry_atr_days_mult: 0.05,
  reentry_min_days: 5,
  reentry_max_days: 30,
  alpha_bonus_enabled: true,
  alpha_bonus_cap: 1.5,
  risk_parity_enabled: false,
  risk_parity_nav_cap: 0.2,
  execution_slicing_enabled: true,
  execution_max_child_notional: 5_000,
  execution_participation_cap: 0.05,
  tod_filter_enabled: true,
  tod_avoid_open_min: 15,
  tod_avoid_close_min: 15,
  tod_open_haircut: 0.5,
  tod_close_haircut: 0.5,
  tod_hard_block_open_min: 0,
  tod_hard_block_close_min: 0,
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
  if (Number.isFinite(Number(r.max_daily_loss_pct))) out.max_daily_loss_pct = Math.max(0, Math.min(0.9, Number(r.max_daily_loss_pct)));
  if (Number.isFinite(Number(r.max_drawdown_halt_pct))) out.max_drawdown_halt_pct = Math.max(0, Math.min(0.9, Number(r.max_drawdown_halt_pct)));
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
  if (r.commodity_group_limits && typeof r.commodity_group_limits === "object") {
    const src = r.commodity_group_limits as Record<string, unknown>;
    const groups = ["Gold", "Silver", "Platinum", "Oil", "Gas", "Copper", "Agriculture", "Basket"] as const;
    const limits: Partial<Record<CommodityGroup, number>> = {};
    for (const g of groups) {
      const v = src[g];
      if (v == null || v === "") continue;
      const n = Number(v);
      if (Number.isFinite(n)) limits[g] = Math.max(0, Math.min(1, n));
    }
    out.commodity_group_limits = limits;
  }
  if (Number.isFinite(Number(r.commodity_min_adv_usd))) {
    out.commodity_min_adv_usd = Math.max(0, Math.min(1e9, Number(r.commodity_min_adv_usd)));
  }
  if (Number.isFinite(Number(r.commodity_max_atr_pct))) {
    out.commodity_max_atr_pct = Math.max(0, Math.min(1, Number(r.commodity_max_atr_pct)));
  }
  // Phase 3 — multi-layer exits.
  const num = (k: keyof RiskConfig, min: number, max: number) => {
    const n = Number((r as Record<string, unknown>)[k as string]);
    if (Number.isFinite(n)) (out as unknown as Record<string, number>)[k as string] = Math.max(min, Math.min(max, n));
  };
  const bool = (k: keyof RiskConfig) => {
    const v = (r as Record<string, unknown>)[k as string];
    if (typeof v === "boolean") (out as unknown as Record<string, boolean>)[k as string] = v;
  };
  bool("chandelier_enabled");
  num("chandelier_k_base", 0.5, 10);
  num("chandelier_k_tight", 0.25, 10);
  num("chandelier_tighten_after_r", 0.1, 20);
  num("initial_stop_atr_mult", 0.25, 10);
  bool("scale_out_enabled");
  if (Array.isArray(r.scale_out_levels)) {
    const lvls = (r.scale_out_levels as unknown[])
      .map((v) => {
        const o = (v ?? {}) as Record<string, unknown>;
        const rv = Number(o.r), fv = Number(o.frac);
        return { r: rv, frac: fv };
      })
      .filter((l) => Number.isFinite(l.r) && Number.isFinite(l.frac) && l.r > 0 && l.frac > 0 && l.frac <= 1)
      .slice(0, 5);
    if (lvls.length) out.scale_out_levels = lvls;
  }
  bool("time_stop_enabled");
  num("time_stop_horizon_days", 0, 365);
  num("time_stop_min_progress_r", -5, 10);
  bool("event_blackout_enabled");
  num("event_blackout_pct_nav", 0, 1);
  num("event_blackout_target_pct_nav", 0, 1);
  num("event_blackout_window_days", 0, 30);
  bool("reentry_lockout_enabled");
  num("reentry_atr_days_mult", 0, 5);
  num("reentry_min_days", 0, 365);
  num("reentry_max_days", 0, 365);
  bool("alpha_bonus_enabled");
  num("alpha_bonus_cap", 1, 3);
  bool("risk_parity_enabled");
  num("risk_parity_nav_cap", 0.01, 1);
  bool("execution_slicing_enabled");
  num("execution_max_child_notional", 100, 1_000_000);
  num("execution_participation_cap", 0.001, 0.5);
  bool("tod_filter_enabled");
  num("tod_avoid_open_min", 0, 120);
  num("tod_avoid_close_min", 0, 120);
  num("tod_open_haircut", 0, 1);
  num("tod_close_haircut", 0, 1);
  num("tod_hard_block_open_min", 0, 120);
  num("tod_hard_block_close_min", 0, 120);
  return out;
}

// ---------------------------------------------------------------------------
// Cash-aware universe filter (pure). Extracted so it can be unit-tested and
// reused. Given the asset-class-filtered universe, a price map, portfolio cash
// and total value, plus the effective per-symbol cap % and min trade value,
// returns the buy-eligible candidate list, drop reasons, and metadata that
// gets written to decisions.raw.guardrails.affordability.
export type AffordabilityDrop = { symbol: string; price: number; reason: string };
export type AffordabilityResult = {
  candidates: UniverseSymbol[];
  dropped: AffordabilityDrop[];
  perSymbolBudget: number;
  minTradeValue: number;
  notes: string[];
  fellBackToCheapest: boolean;
};

export function filterUniverseByAffordability(args: {
  fullUniverse: UniverseSymbol[];
  priceMap: Map<string, number>;
  heldSymbols: string[];
  cash: number;
  totalValue: number;
  perSymbolCapPct: number;
  minTradeValue: number;
  currency: string;
  maxCandidates?: number;
}): AffordabilityResult {
  const {
    fullUniverse, priceMap, heldSymbols, cash, totalValue,
    perSymbolCapPct, minTradeValue, currency,
  } = args;
  const maxCandidates = args.maxCandidates ?? 22;
  const perSymbolBudget = Math.min(totalValue * perSymbolCapPct, cash);
  const affordable: UniverseSymbol[] = [];
  const dropped: AffordabilityDrop[] = [];
  for (const u of fullUniverse) {
    const price = priceMap.get(u.symbol);
    if (price == null || price <= 0) { affordable.push(u); continue; }
    if (price > perSymbolBudget) {
      dropped.push({ symbol: u.symbol, price,
        reason: `1 share (${price.toFixed(2)}) > per-symbol budget ${perSymbolBudget.toFixed(2)}` });
      continue;
    }
    if (perSymbolBudget < minTradeValue) {
      dropped.push({ symbol: u.symbol, price,
        reason: `per-symbol budget ${perSymbolBudget.toFixed(2)} < min trade value ${minTradeValue}` });
      continue;
    }
    affordable.push(u);
  }
  const heldSet = new Set(heldSymbols);
  const alreadyAffordable = new Set(affordable.map((a) => a.symbol));
  for (const u of fullUniverse) {
    if (heldSet.has(u.symbol) && !alreadyAffordable.has(u.symbol)) affordable.push(u);
  }

  const notes: string[] = [];
  let candidates: UniverseSymbol[];
  let fellBackToCheapest = false;
  if (affordable.length === 0) {
    fellBackToCheapest = true;
    candidates = fullUniverse
      .map((u) => ({ u, p: priceMap.get(u.symbol) ?? Infinity }))
      .sort((a, b) => a.p - b.p)
      .slice(0, 6)
      .map((x) => x.u);
    notes.push(
      `No instruments affordable within per-symbol budget ${perSymbolBudget.toFixed(2)} ${currency}; showing 6 cheapest for reference. Add funds or widen the per-symbol cap to enable buys.`,
    );
  } else {
    candidates = affordable.slice(0, maxCandidates);
    if (dropped.length > 0) {
      notes.push(
        `Cash-aware filter kept ${candidates.length}/${fullUniverse.length} instruments; dropped ${dropped.length} priced above per-symbol budget ${perSymbolBudget.toFixed(2)} ${currency}.`,
      );
    }
  }
  return { candidates, dropped, perSymbolBudget, minTradeValue, notes, fellBackToCheapest };
}



