// Curated symbol universe by asset class. Uses Yahoo Finance ticker syntax
// (e.g. BTC-USD, GC=F, GBPUSD=X, VOD.L) which the price fetcher understands.
import type { Database } from "@/integrations/supabase/types";
import { parseTradingStyle, SWING_STYLE_OVERRIDES } from "./trading-style";

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
  // Continental Europe — Xetra (.DE), Euronext Paris/Amsterdam (.PA/.AS),
  // Borsa Italiana (.MI), BME Madrid (.MC) and SIX Swiss (.SW). Saxo routes
  // all of these natively from a cash account; settlement FX (GBP → EUR/CHF)
  // is planned by the FX conversion layer. Venue hours live in market-hours.ts.
  { symbol: "SAP.DE", name: "SAP (XETRA)", asset_class: "stock" },
  { symbol: "SIE.DE", name: "Siemens (XETRA)", asset_class: "stock" },
  { symbol: "ALV.DE", name: "Allianz (XETRA)", asset_class: "stock" },
  { symbol: "MBG.DE", name: "Mercedes-Benz Group (XETRA)", asset_class: "stock" },
  { symbol: "BAS.DE", name: "BASF (XETRA)", asset_class: "stock" },
  { symbol: "DTE.DE", name: "Deutsche Telekom (XETRA)", asset_class: "stock" },
  { symbol: "MC.PA", name: "LVMH (Paris)", asset_class: "stock" },
  { symbol: "OR.PA", name: "L'Oreal (Paris)", asset_class: "stock" },
  { symbol: "AIR.PA", name: "Airbus (Paris)", asset_class: "stock" },
  { symbol: "TTE.PA", name: "TotalEnergies (Paris)", asset_class: "stock" },
  { symbol: "SAN.PA", name: "Sanofi (Paris)", asset_class: "stock" },
  { symbol: "ASML.AS", name: "ASML (Amsterdam)", asset_class: "stock" },
  { symbol: "INGA.AS", name: "ING Groep (Amsterdam)", asset_class: "stock" },
  { symbol: "ENI.MI", name: "Eni (Milan)", asset_class: "stock" },
  { symbol: "ISP.MI", name: "Intesa Sanpaolo (Milan)", asset_class: "stock" },
  { symbol: "ITX.MC", name: "Inditex (Madrid)", asset_class: "stock" },
  { symbol: "NESN.SW", name: "Nestle (SIX)", asset_class: "stock" },
  { symbol: "ROG.SW", name: "Roche (SIX)", asset_class: "stock" },
  { symbol: "NOVN.SW", name: "Novartis (SIX)", asset_class: "stock" },
  // European broad-index ETFs so EUR cash can be invested without single-name risk.
  { symbol: "EXSA.DE", name: "iShares STOXX Europe 600 ETF (XETRA)", asset_class: "etf" },
  { symbol: "EXS1.DE", name: "iShares Core DAX ETF (XETRA)", asset_class: "etf" },
  { symbol: "VWCE.DE", name: "Vanguard FTSE All-World Acc ETF (XETRA)", asset_class: "etf" },
  { symbol: "MEUD.PA", name: "Amundi Stoxx Europe 600 ETF (Paris)", asset_class: "etf" },
  { symbol: "IWDA.AS", name: "iShares Core MSCI World ETF (Amsterdam)", asset_class: "etf" },
  // Short sleeve — cash-funded inverse (-1x) UCITS ETFs. Buying these is how
  // the AI expresses a bearish view without margin or borrowing; see
  // src/lib/short-sleeve.ts for the gross/sleeve caps that govern them.
  { symbol: "XUKS.L", name: "Xtrackers FTSE 100 Short Daily ETF", asset_class: "etf" },
  { symbol: "XSPS.L", name: "Xtrackers S&P 500 Inverse Daily ETF", asset_class: "etf" },
  // Japan — Tokyo Stock Exchange (Yahoo `.T` suffix → Saxo TSE_JP). Curated
  // large-cap, high-liquidity names plus a Nikkei 225 ETF so JPY exposure
  // is reachable via either single stocks or a broad index wrapper. Saxo
  // cash accounts route these natively; settlement FX (GBP/EUR → JPY) is
  // handled by the wallet layer, no separate crypto/futures pathway needed.
  { symbol: "7203.T", name: "Toyota Motor (TSE)", asset_class: "stock" },
  { symbol: "6758.T", name: "Sony Group (TSE)", asset_class: "stock" },
  { symbol: "9984.T", name: "SoftBank Group (TSE)", asset_class: "stock" },
  { symbol: "6861.T", name: "Keyence (TSE)", asset_class: "stock" },
  { symbol: "8306.T", name: "Mitsubishi UFJ Financial (TSE)", asset_class: "stock" },
  { symbol: "8035.T", name: "Tokyo Electron (TSE)", asset_class: "stock" },
  { symbol: "9432.T", name: "Nippon Telegraph & Telephone (TSE)", asset_class: "stock" },
  { symbol: "7974.T", name: "Nintendo (TSE)", asset_class: "stock" },
  { symbol: "6098.T", name: "Recruit Holdings (TSE)", asset_class: "stock" },
  { symbol: "8058.T", name: "Mitsubishi Corp (TSE)", asset_class: "stock" },
  { symbol: "1321.T", name: "Nomura Nikkei 225 ETF (TSE)", asset_class: "etf" },
  { symbol: "1306.T", name: "iShares TOPIX ETF (TSE)", asset_class: "etf" },
  // Australia — ASX (Yahoo `.AX` suffix → Saxo ASX). Curated large-cap,
  // high-liquidity names spanning banks, miners, healthcare and consumer,
  // plus an ASX 200 index ETF for broad AUD exposure. Saxo cash accounts
  // route these natively; settlement FX (GBP/EUR → AUD) is handled by the
  // wallet layer. Market hours 10:00–16:00 Australia/Sydney are already
  // wired in `market-hours-card.tsx`.
  { symbol: "BHP.AX", name: "BHP Group (ASX)", asset_class: "stock" },
  { symbol: "CBA.AX", name: "Commonwealth Bank of Australia (ASX)", asset_class: "stock" },
  { symbol: "CSL.AX", name: "CSL Ltd (ASX)", asset_class: "stock" },
  { symbol: "NAB.AX", name: "National Australia Bank (ASX)", asset_class: "stock" },
  { symbol: "WBC.AX", name: "Westpac Banking (ASX)", asset_class: "stock" },
  { symbol: "ANZ.AX", name: "ANZ Group (ASX)", asset_class: "stock" },
  { symbol: "RIO.AX", name: "Rio Tinto (ASX)", asset_class: "stock" },
  { symbol: "FMG.AX", name: "Fortescue (ASX)", asset_class: "stock" },
  { symbol: "WES.AX", name: "Wesfarmers (ASX)", asset_class: "stock" },
  { symbol: "WOW.AX", name: "Woolworths Group (ASX)", asset_class: "stock" },
  { symbol: "TLS.AX", name: "Telstra Group (ASX)", asset_class: "stock" },
  { symbol: "MQG.AX", name: "Macquarie Group (ASX)", asset_class: "stock" },
  { symbol: "STW.AX", name: "SPDR S&P/ASX 200 ETF (ASX)", asset_class: "etf" },
  { symbol: "IOZ.AX", name: "iShares Core S&P/ASX 200 ETF (ASX)", asset_class: "etf" },
  // Crypto — spot pairs (Yahoo price feed only; NOT Saxo-tradable, kept for
  // reference/backtesting where the fetchers already understand them).
  { symbol: "BTC-USD", name: "Bitcoin", asset_class: "crypto" },
  { symbol: "ETH-USD", name: "Ethereum", asset_class: "crypto" },
  { symbol: "SOL-USD", name: "Solana", asset_class: "crypto" },
  // Crypto — Saxo-tradable physically-backed ETPs/ETNs. Cash-account safe
  // (no futures, leverage or inverse products). See `crypto-groups.ts` for
  // the group map and `crypto-playbook.server.ts` for entry/exit rules.
  { symbol: "BTCE.DE", name: "BTCetc Physical Bitcoin (XETRA)", asset_class: "crypto" },
  { symbol: "ABTC.SW", name: "21Shares Bitcoin ETP (SIX)", asset_class: "crypto" },
  { symbol: "BTCW.L",  name: "WisdomTree Physical Bitcoin (LON)", asset_class: "crypto" },
  { symbol: "ZETH.SW", name: "21Shares Ethereum ETP (SIX)", asset_class: "crypto" },
  { symbol: "ZETH.DE", name: "ETC Group Physical Ethereum (XETRA)", asset_class: "crypto" },
  { symbol: "HODL.SW", name: "21Shares Crypto Basket Index ETP (SIX)", asset_class: "crypto" },
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
  // FX — reference/context symbols used by price cache warming, FX signals
  // (Yahoo `${FROM}${TO}=X`) and the AI conversion planner. Adding a pair here
  // does NOT route orders; settlement legs are driven by wallet cash_by_ccy
  // and the FX conversion planner. JPY/AUD pairs support the Tokyo (`.T`) and
  // ASX (`.AX`) instruments in the equity universe above.
  { symbol: "GBPUSD=X", name: "GBP/USD", asset_class: "fx" },
  { symbol: "EURUSD=X", name: "EUR/USD", asset_class: "fx" },
  { symbol: "GBPEUR=X", name: "GBP/EUR", asset_class: "fx" },
  { symbol: "USDJPY=X", name: "USD/JPY", asset_class: "fx" },
  { symbol: "GBPJPY=X", name: "GBP/JPY", asset_class: "fx" },
  { symbol: "EURJPY=X", name: "EUR/JPY", asset_class: "fx" },
  { symbol: "AUDUSD=X", name: "AUD/USD", asset_class: "fx" },
  { symbol: "GBPAUD=X", name: "GBP/AUD", asset_class: "fx" },
  { symbol: "EURAUD=X", name: "EUR/AUD", asset_class: "fx" },
  { symbol: "GBPCHF=X", name: "GBP/CHF", asset_class: "fx" },
  { symbol: "EURCHF=X", name: "EUR/CHF", asset_class: "fx" },
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
  min_commission: number;
  /** Optional microstructure tuning overrides merged into DEFAULT_TUNING at
   *  call time (see spread-slippage.ts). Left loosely typed so per-symbol
   *  calibration can plug in without importing engine types here. */
  microstructure?: Record<string, number>;
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
  /** Scale the hard stop by ATR (can only tighten, never widen, the fixed stop). */
  atr_scaled_stop_enabled: boolean;
  /** Lower bound for the ATR-scaled hard stop so noise can't trigger exits. */
  atr_scaled_stop_floor_pct: number;
  /** Master switch for the take-profit leg. False = let winners run. */
  take_profit_enabled: boolean;
  /** Size the profit target in ATRs rather than a flat percentage. */
  atr_take_profit_enabled: boolean;
  /** ATR multiple defining the profit target (e.g. 4 = 4×ATR). */
  take_profit_atr_mult: number;
  /** Lower bound for the ATR take-profit so targets sit outside daily noise. */
  atr_take_profit_floor_pct: number;
  /** Upper bound so a volatile name's target stays reachable. */
  atr_take_profit_cap_pct: number;
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
  // Per-venue overrides on top of the tod_* defaults. Any subset of fields
  // may be set per venue; missing fields fall back to the global defaults.
  tod_venue_overrides: import("./alpha/execution-alpha").TodVenueOverrides | null;
  // Optional override for the minimum-cash floor. When set (0..1), it replaces
  // the risk-level preset from `riskProfile()` so users can allow the AI to
  // deploy up to 100% of cash (cash_floor_pct = 0) without changing the risk
  // level. `null` means "use the preset for the current risk level".
  cash_floor_pct: number | null;
  // User setting: how aggressively to push exposure into commodities and FX
  // above the baseline risk-and-regime ranking. "off" is neutral (today's
  // behaviour); "balanced" nudges the AI to consider commodity/FX ideas when
  // current exposure sits below a moderate target; "strong" applies a firmer
  // tilt with higher target exposure and a more explicit instruction to
  // propose diversifiers whenever the guardrail room is available. Purely a
  // prompt-level bias — it never overrides hard `asset_class_limits`.
  diversification_tilt: "off" | "balanced" | "strong";
  // Prefer stamp-exempt instruments (ETFs/ETCs, non-UK listings) over UK
  // single stocks when signal strength is comparable. UK shares pay 0.5%
  // stamp duty on every buy, so the exempt instrument breaks even ~50bps
  // sooner. Ranking-only: it never overrides caps or forces a trade.
  stamp_exempt_preference: "off" | "balanced" | "strong";
  // Per-non-base-currency exposure caps (0..1) as fraction of NAV in
  // base-currency terms. Applies to any holding whose instrument currency is
  // NOT the portfolio's base currency (e.g. JPY holdings for a GBP portfolio).
  // Keys are ISO 4217 codes (uppercase). Missing/empty = no cap for that
  // currency. Cap-only: it can only shrink a proposed buy, never force one,
  // and never permits borrowing.
  fx_currency_limits: Partial<Record<string, number>>;
  // Trading style. "position" keeps the historical multi-month behaviour;
  // "swing" rebases the exit/holding-period defaults for a days-to-weeks
  // horizon (see src/lib/trading-style.ts). Explicit per-field overrides
  // stored on risk_config always win over the style base.
  trading_style: "position" | "swing";
  /** Swing only: minimum sessions to hold before a discretionary sell. */
  swing_min_hold_days: number;
  // Explicit cash-allocation policy (see src/lib/cash-allocation-policy.ts).
  // When enabled, a regime-derived TARGET invested % keeps the book from
  // drifting nearly flat in bull tapes, and caps it in defensive regimes.
  // Always subordinate to the drawdown budget and the per-symbol caps.
  cash_policy_enabled: boolean;
  /** Optional user target invested share of NAV (0..1). null = regime table. */
  target_invested_pct: number | null;
  // Short sleeve (src/lib/short-sleeve.ts). Shorts are expressed by buying
  // cash-funded inverse ETFs — never on margin. Longs + shorts may never
  // exceed NAV, and the sleeve itself is capped at short_sleeve_max_pct.
  shorts_enabled: boolean;
  /** Max share of NAV (0..1) that may sit in inverse ETFs. */
  short_sleeve_max_pct: number;

};


/**
 * Effective cash-floor fraction (0..1). Prefers the per-portfolio override on
 * `risk_config.cash_floor_pct` when set; otherwise falls back to the risk-
 * level preset. Keep this in one place so every engine (live tick, long-
 * horizon, commodity backtest, prompt) stays consistent.
 */
export function effectiveCashFloorPct(
  cfg: Pick<RiskConfig, "cash_floor_pct">,
  level: Database["public"]["Enums"]["risk_level"],
): number {
  const override = cfg.cash_floor_pct;
  if (override != null && Number.isFinite(override)) {
    return Math.max(0, Math.min(1, override));
  }
  return riskProfile(level).cashFloorPct;
}



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
  atr_scaled_stop_enabled: true,
  atr_scaled_stop_floor_pct: 0.03,
  take_profit_enabled: true,
  atr_take_profit_enabled: true,
  take_profit_atr_mult: 4,
  atr_take_profit_floor_pct: 0.06,
  atr_take_profit_cap_pct: 0.40,
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
  tod_venue_overrides: null,
  cash_floor_pct: null,
  diversification_tilt: "off",
  stamp_exempt_preference: "balanced",
  fx_currency_limits: {},
  trading_style: "position",
  swing_min_hold_days: 2,
  cash_policy_enabled: true,
  target_invested_pct: null,
  shorts_enabled: true,
  short_sleeve_max_pct: 0.5,


};



export function parseRiskConfig(raw: unknown): RiskConfig {
  const style = parseTradingStyle((raw as Record<string, unknown> | null)?.trading_style);
  // The style rebases the exit/holding defaults; explicit fields below still win.
  const base: RiskConfig =
    style === "swing"
      ? { ...DEFAULT_RISK_CONFIG, ...SWING_STYLE_OVERRIDES, trading_style: "swing" }
      : { ...DEFAULT_RISK_CONFIG };
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
    type NumericParamKey = Exclude<keyof ExecutionParamsConfig, "microstructure">;
    const num = (k: NumericParamKey, min: number, max: number) => {
      const n = Number(e[k]);
      if (Number.isFinite(n)) ep[k] = Math.max(min, Math.min(max, n));
    };

    num("slippage_bps", 0, 500);
    num("commission_bps", 0, 500);
    num("spread_atr_frac", 0, 2);
    num("adv_participation", 0, 0.5);
    num("min_trade_value", 0, 10_000);
    num("min_commission", 0, 10_000);
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
  bool("atr_scaled_stop_enabled");
  num("atr_scaled_stop_floor_pct", 0, 0.5);
  bool("take_profit_enabled");
  bool("atr_take_profit_enabled");
  num("take_profit_atr_mult", 0, 20);
  num("atr_take_profit_floor_pct", 0, 2);
  num("atr_take_profit_cap_pct", 0, 5);
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
  out.trading_style = style;
  num("swing_min_hold_days", 0, 30);
  bool("alpha_bonus_enabled");
  bool("cash_policy_enabled");
  bool("shorts_enabled");
  if (Number.isFinite(Number(r.short_sleeve_max_pct))) {
    out.short_sleeve_max_pct = Math.max(0, Math.min(1, Number(r.short_sleeve_max_pct)));
  }
  // Explicit `null` clears the user target and reverts to the regime table.
  if (r.target_invested_pct === null) {
    out.target_invested_pct = null;
  } else if (r.target_invested_pct !== undefined) {
    const n = Number(r.target_invested_pct);
    out.target_invested_pct = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
  }

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
  // Optional per-portfolio cash-floor override. Explicit `null` clears it.
  if (r.cash_floor_pct === null) {
    out.cash_floor_pct = null;
  } else if (r.cash_floor_pct !== undefined) {
    const n = Number(r.cash_floor_pct);
    out.cash_floor_pct = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
  }

  // Diversification-tilt user setting. Unknown / missing values fall back to
  // the neutral default so upgrades don't silently change AI behaviour.
  if (r.diversification_tilt === "off" || r.diversification_tilt === "balanced" || r.diversification_tilt === "strong") {
    out.diversification_tilt = r.diversification_tilt;
  }

  // Stamp-exempt instrument preference. Same tri-state shape as the tilt.
  if (
    r.stamp_exempt_preference === "off" ||
    r.stamp_exempt_preference === "balanced" ||
    r.stamp_exempt_preference === "strong"
  ) {
    out.stamp_exempt_preference = r.stamp_exempt_preference;
  }


  // Per-venue TOD overrides.
  if (r.tod_venue_overrides && typeof r.tod_venue_overrides === "object") {
    const allowedVenues = new Set(["LSE", "NYSE", "NASDAQ", "CRYPTO", "OTHER"]);
    const clamp = (v: unknown, lo: number, hi: number): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : undefined;
    };
    const parsed: Record<string, Record<string, number>> = {};
    for (const [venue, raw] of Object.entries(r.tod_venue_overrides as Record<string, unknown>)) {
      if (!allowedVenues.has(venue) || !raw || typeof raw !== "object") continue;
      const src = raw as Record<string, unknown>;
      const entry: Record<string, number> = {};
      const setIf = (k: string, lo: number, hi: number) => {
        const n = clamp(src[k], lo, hi);
        if (n !== undefined) entry[k] = n;
      };
      setIf("avoidOpenMin", 0, 120);
      setIf("avoidCloseMin", 0, 120);
      setIf("openHaircut", 0, 1);
      setIf("closeHaircut", 0, 1);
      setIf("hardBlockOpenMin", 0, 120);
      setIf("hardBlockCloseMin", 0, 120);
      // Session bounds are minutes-since-midnight local venue time (0..1440).
      setIf("sessionOpenMin", 0, 24 * 60);
      setIf("sessionCloseMin", 0, 24 * 60);
      if (Object.keys(entry).length > 0) parsed[venue] = entry;
    }
    out.tod_venue_overrides = Object.keys(parsed).length > 0 ? (parsed as RiskConfig["tod_venue_overrides"]) : null;
  }
  // Per-currency exposure caps for non-base holdings (e.g. { JPY: 0.15 }).
  if (r.fx_currency_limits && typeof r.fx_currency_limits === "object") {
    const limits: Partial<Record<string, number>> = {};
    for (const [k, v] of Object.entries(r.fx_currency_limits as Record<string, unknown>)) {
      const code = String(k || "").toUpperCase().trim();
      if (!/^[A-Z]{3}$/.test(code)) continue;
      if (v == null || v === "") continue;
      const n = Number(v);
      if (Number.isFinite(n)) limits[code] = Math.max(0, Math.min(1, n));
    }
    out.fx_currency_limits = limits;
  }
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
  /**
   * Symbols that must stay visible when the candidate window is narrower than
   * the universe — e.g. the cash-funded inverse ETFs the AI uses for shorts.
   * They still have to pass the same affordability checks; this only reserves
   * space in the final slice.
   */
  prioritySymbols?: string[];
}): AffordabilityResult {
  const {
    fullUniverse, priceMap, heldSymbols, cash, totalValue,
    perSymbolCapPct, minTradeValue, currency,
  } = args;
  const maxCandidates = args.maxCandidates ?? 22;
  const priority = new Set((args.prioritySymbols ?? []).map((s) => s.toUpperCase()));
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
    // Stable partition: priority symbols keep their original relative order,
    // then everything else does. Without this the inverse ETFs near the end of
    // the curated universe silently fall outside the model's 22-name window.
    const orderedAffordable = priority.size
      ? [
          ...affordable.filter((u) => priority.has(u.symbol.toUpperCase())),
          ...affordable.filter((u) => !priority.has(u.symbol.toUpperCase())),
        ]
      : affordable;
    candidates = orderedAffordable.slice(0, maxCandidates);
    if (dropped.length > 0) {
      notes.push(
        `Cash-aware filter kept ${candidates.length}/${fullUniverse.length} instruments; dropped ${dropped.length} priced above per-symbol budget ${perSymbolBudget.toFixed(2)} ${currency}.`,
      );
    }
  }
  return { candidates, dropped, perSymbolBudget, minTradeValue, notes, fellBackToCheapest };
}


// ---------------------------------------------------------------------------
// Diversification tilt: prompt-level nudge toward commodities / FX.
//
// Purely a soft bias layered on top of the ranker. It NEVER raises the hard
// `asset_class_limits` caps and NEVER forces a trade — the buy-side guardrails
// downstream still reject anything that would breach the cap or affordability
// checks. The block simply tells the AI "you currently hold X% commodities vs
// an Y% target for this tilt; consider proposing diversifiers if the setup is
// there". Baseline ("off") emits no block, so behaviour is unchanged for
// users who don't opt in.
// ---------------------------------------------------------------------------

export type DiversificationTilt = "off" | "balanced" | "strong";

type TiltTargets = { commodity: number; fx: number; label: string; instruction: string };

export function tiltTargets(
  tilt: DiversificationTilt,
  cfg: Pick<RiskConfig, "asset_class_limits">,
): TiltTargets | null {
  if (tilt === "off") return null;
  const commodityCap = cfg.asset_class_limits.commodity ?? 0;
  const fxCap = cfg.asset_class_limits.fx ?? 0;
  // Target is a fraction of the user's own cap: "balanced" aims for ~40% of
  // the cap, "strong" aims for ~70%. This keeps the tilt proportional to the
  // risk-preset caps the user already chose.
  const frac = tilt === "balanced" ? 0.4 : 0.7;
  return {
    commodity: Math.max(0, Math.min(commodityCap, commodityCap * frac)),
    fx: Math.max(0, Math.min(fxCap, fxCap * frac)),
    label: tilt === "balanced" ? "Balanced diversification tilt" : "Strong diversification tilt",
    instruction:
      tilt === "balanced"
        ? "When the setup supports it, prefer adding a commodity or FX name over doubling up on an existing stock/ETF exposure."
        : "Actively look for the best commodity and FX ideas each cycle. Propose them ahead of marginal stock/ETF adds whenever the risk/technical picture is at least neutral.",
  };
}

export function buildDiversificationTiltBlock(args: {
  tilt: DiversificationTilt;
  cfg: Pick<RiskConfig, "asset_class_limits">;
  currentExposure?: { commodity: number; fx: number };
}): string {
  const t = tiltTargets(args.tilt, args.cfg);
  if (!t) return "";
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  const lines = [
    `DIVERSIFICATION TILT — ${t.label}`,
    `Soft targets (fraction of your asset-class caps): commodity ${pct(t.commodity)}, FX ${pct(t.fx)}.`,
  ];
  if (args.currentExposure) {
    const gapC = Math.max(0, t.commodity - args.currentExposure.commodity);
    const gapF = Math.max(0, t.fx - args.currentExposure.fx);
    lines.push(
      `Current exposure: commodity ${pct(args.currentExposure.commodity)}, FX ${pct(args.currentExposure.fx)}.`,
      gapC + gapF <= 0.005
        ? "Current commodity/FX exposure already meets or exceeds the tilt target — no extra nudge needed this cycle."
        : `Room to tilt: commodities +${pct(gapC)}, FX +${pct(gapF)} (soft — hard caps still apply).`,
    );
  }
  lines.push(t.instruction);
  lines.push("This is a soft bias only — it never overrides asset-class caps, per-symbol caps, or affordability checks.");
  return lines.join("\n");
}





