// Dedicated crypto allocation & risk-management engine.
//
// Turns the narrative CRYPTO_PLAYBOOK into concrete, machine-computed
// decisions the AI (and the sizing pipeline) can act on:
//
//   1. Sleeve cap per risk level (conservative 5%, balanced 10%, aggressive 15%).
//   2. Regime gate mapping our existing RegimeLabel onto crypto-specific
//      risk-on / caution / risk-off buckets, with a HARD veto in risk-off.
//   3. Per-symbol momentum signals (SMA50/200 trend, RSI-14, 60d return
//      parabolic guard, ATR-style volatility, drawdown from 90d peak).
//   4. Decision resolver: exit / trim / hold / add / open with size in
//      units of the per-symbol cap, plus a human rationale.
//   5. Prompt block builder so the AI sees the computed state alongside
//      the playbook narrative — no drift between prose and numbers.
//
// The exit ladder (X1-X6) is deliberately enforced here as well as in the
// prompt: a risk-off regime flip or a two-day close < SMA50 must always
// downsize, regardless of what the LLM proposes.

import type { Database } from "@/integrations/supabase/types";
import type { RegimeLabel } from "./regime-detector.server";
import { CRYPTO_SYMBOLS, classifyCryptoSymbol, type CryptoGroup } from "./crypto-groups";
import {
  getDailyCandles,
  sma,
  rsi,
  pctChange,
  dailyVolatility,
} from "./market-data.server";

type RiskLevel = Database["public"]["Enums"]["risk_level"];

export type CryptoRegimeBucket = "risk_on" | "caution" | "risk_off";

export type CryptoAction = "open" | "add" | "hold" | "trim" | "exit";

export type CryptoSymbolSignal = {
  symbol: string;
  group: CryptoGroup;
  price: number | null;
  sma50: number | null;
  sma200: number | null;
  trend_up: boolean;
  rsi14: number | null;
  return_60d: number | null;
  vol_20d: number | null;
  drawdown_from_90d_peak: number | null; // negative, e.g. -0.18
  below_sma50_streak: number; // consecutive closes < SMA50 (X1)
  parabolic_veto: boolean;   // C5: > +50% over 60 sessions
  regime_veto: boolean;      // C2: risk_off / crisis
  entry_gates_passed: number; // count of C1..C4 satisfied
  action: CryptoAction;
  size_fraction_of_cap: number; // 0..1 target of per-symbol cap
  rationale: string;
};

export type CryptoSleeveDecision = {
  as_of: string;
  risk_level: RiskLevel;
  regime: RegimeLabel;
  bucket: CryptoRegimeBucket;
  sleeve_cap_pct: number;   // fraction of NAV
  sleeve_target_pct: number; // what we WANT crypto to be right now (<= cap)
  current_sleeve_pct: number; // current crypto MV / NAV
  hard_veto: boolean;
  veto_reason: string | null;
  symbols: CryptoSymbolSignal[];
  notes: string[];
};

// --- Sleeve caps by risk level ---------------------------------------------

export function cryptoSleeveCapPct(level: RiskLevel): number {
  switch (level) {
    case "conservative": return 0.05;
    case "balanced":     return 0.10;
    case "aggressive":   return 0.15;
    default:             return 0.05;
  }
}

// --- Regime bucketing -------------------------------------------------------

export function bucketRegime(r: RegimeLabel): CryptoRegimeBucket {
  switch (r) {
    case "bull_quiet":
    case "recovery":
      return "risk_on";
    case "bull_volatile":
    case "correction":
      return "caution";
    case "bear":
    case "crisis":
      return "risk_off";
    default:
      return "caution";
  }
}

// Multiplier applied to the sleeve CAP to get the sleeve TARGET.
function regimeSleeveMultiplier(bucket: CryptoRegimeBucket): number {
  switch (bucket) {
    case "risk_on":  return 1.00;
    case "caution":  return 0.40; // keep some Basket, trim BTC/ETH
    case "risk_off": return 0.00; // X6 hard cut
  }
}

// --- Per-symbol signals -----------------------------------------------------

function belowSma50Streak(closes: number[], smaPeriod = 50): number {
  if (closes.length < smaPeriod + 1) return 0;
  let streak = 0;
  for (let i = closes.length - 1; i >= smaPeriod - 1; i--) {
    const window = closes.slice(i - smaPeriod + 1, i + 1);
    const m = sma(window, smaPeriod);
    if (m == null || closes[i] >= m) break;
    streak += 1;
    if (streak >= 10) break;
  }
  return streak;
}

function drawdownFromPeak(closes: number[], lookback = 90): number | null {
  if (closes.length === 0) return null;
  const slice = closes.slice(-lookback);
  const peak = Math.max(...slice);
  const now = slice[slice.length - 1];
  if (!(peak > 0)) return null;
  return (now - peak) / peak; // <= 0
}

export async function computeCryptoSymbolSignal(
  symbol: string,
  asOf: string,
  ctx: { bucket: CryptoRegimeBucket },
): Promise<CryptoSymbolSignal | null> {
  const group = classifyCryptoSymbol(symbol);
  if (!group) return null;

  let candles: Awaited<ReturnType<typeof getDailyCandles>> = [];
  try {
    candles = await getDailyCandles(symbol, 220, asOf);
  } catch {
    candles = [];
  }
  const closes = candles.map((c) => c.close).filter((n) => Number.isFinite(n) && n > 0);
  const price = closes.length ? closes[closes.length - 1] : null;
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const r14 = rsi(closes, 14);
  const ret60 = pctChange(closes, 60);
  const vol20 = dailyVolatility(closes, 20);
  const dd = drawdownFromPeak(closes, 90);
  const belowStreak = belowSma50Streak(closes, 50);

  const trendUp = price != null && s50 != null && s200 != null && price > s50 && s50 > s200;
  const parabolic = ret60 != null && ret60 > 0.5;
  const regimeVeto = ctx.bucket === "risk_off";

  // Entry gates C1..C4 (C5 is a veto, handled separately).
  //   C1: trendUp AND RSI in 45..70
  //   C2: bucket !== risk_off
  //   C3: (not directly observable here → treat as satisfied if bucket=risk_on
  //        and price momentum is positive; otherwise unknown → not counted)
  //   C4: (cross-asset — approximated: bucket=risk_on AND ret60 > 0)
  const c1 = trendUp && r14 != null && r14 >= 45 && r14 <= 70;
  const c2 = !regimeVeto;
  const c3 = ctx.bucket === "risk_on" && (ret60 ?? 0) > 0;
  const c4 = ctx.bucket === "risk_on" && (ret60 ?? 0) > 0;
  const gates = (c1 ? 1 : 0) + (c2 ? 1 : 0) + (c3 ? 1 : 0) + (c4 ? 1 : 0);

  // --- Decision resolver ---------------------------------------------------
  let action: CryptoAction = "hold";
  let size = 0;
  const reasons: string[] = [];

  if (regimeVeto) {
    action = "exit"; size = 0;
    reasons.push("X6: regime is risk_off — cut sleeve to zero within one tick");
  } else if (price != null && s200 != null && price < s200) {
    action = "exit"; size = 0;
    reasons.push("X2: close below SMA200 — full exit, trend break");
  } else if (belowStreak >= 2) {
    action = "trim"; size = 0.5;
    reasons.push("X1: two+ consecutive closes below SMA50 — trim 50%");
  } else if (parabolic) {
    action = "trim"; size = 0.6;
    reasons.push("X5/C5: +50% over 60 sessions — take partial profits, no new buys");
  } else if (ctx.bucket === "caution") {
    action = "hold"; size = 0.4;
    reasons.push("Caution regime — hold reduced exposure, no fresh adds");
  } else if (gates >= 2 && c1 && c2) {
    // Fresh add or open — start at 1/3 of cap (playbook sizing rule),
    // scale toward full cap as more gates satisfy.
    action = "open";
    size = gates >= 4 ? 0.66 : gates === 3 ? 0.5 : 0.33;
    reasons.push(`Entry gates passed: ${gates}/4 — size to ${(size * 100).toFixed(0)}% of per-symbol cap`);
  } else {
    action = "hold"; size = 0.33;
    reasons.push(`Only ${gates}/4 entry gates — hold, no new buys`);
  }

  return {
    symbol, group,
    price, sma50: s50, sma200: s200,
    trend_up: trendUp,
    rsi14: r14, return_60d: ret60, vol_20d: vol20,
    drawdown_from_90d_peak: dd,
    below_sma50_streak: belowStreak,
    parabolic_veto: parabolic,
    regime_veto: regimeVeto,
    entry_gates_passed: gates,
    action, size_fraction_of_cap: size,
    rationale: reasons.join("; "),
  };
}

// --- Sleeve-level plan ------------------------------------------------------

export type CryptoHoldingRef = {
  symbol: string;
  market_value_base: number; // in portfolio base currency
};

export async function computeCryptoSleeveDecision(args: {
  asOf: string;
  riskLevel: RiskLevel;
  regime: RegimeLabel;
  nav: number;
  holdings: CryptoHoldingRef[];
  /** Optional narrower list; defaults to full CRYPTO_SYMBOLS universe. */
  symbols?: string[];
}): Promise<CryptoSleeveDecision> {
  const bucket = bucketRegime(args.regime);
  const cap = cryptoSleeveCapPct(args.riskLevel);
  const target = cap * regimeSleeveMultiplier(bucket);

  const cryptoHeld = args.holdings.filter((h) => classifyCryptoSymbol(h.symbol) != null);
  const heldMv = cryptoHeld.reduce((s, h) => s + Math.max(0, h.market_value_base ?? 0), 0);
  const currentPct = args.nav > 0 ? heldMv / args.nav : 0;

  const symbols = args.symbols ?? CRYPTO_SYMBOLS;
  const signals = await Promise.all(
    symbols.map((s) => computeCryptoSymbolSignal(s, args.asOf, { bucket })),
  );
  const symbolSignals = signals.filter((s): s is CryptoSymbolSignal => s !== null);

  const hardVeto = bucket === "risk_off";
  const vetoReason = hardVeto
    ? `Regime ${args.regime} → risk_off bucket; sleeve target 0% and all crypto positions must exit (X6).`
    : null;

  const notes: string[] = [];
  notes.push(`Sleeve cap ${(cap * 100).toFixed(0)}% for ${args.riskLevel} risk`);
  notes.push(`Regime ${args.regime} → ${bucket} bucket → target ${(target * 100).toFixed(1)}% of NAV`);
  if (currentPct > target + 0.01) {
    notes.push(`Current sleeve ${(currentPct * 100).toFixed(1)}% exceeds target — sells prioritised over buys`);
  }
  const btcEth = cryptoHeld
    .filter((h) => {
      const g = classifyCryptoSymbol(h.symbol);
      return g === "BTC" || g === "ETH";
    })
    .reduce((s, h) => s + Math.max(0, h.market_value_base ?? 0), 0);
  if (heldMv > 0 && btcEth / heldMv > 0.8 && currentPct > 0.05) {
    notes.push("BTC+ETH concentration > 80% of sleeve — rotate part into Basket (HODL.SW)");
  }

  return {
    as_of: args.asOf,
    risk_level: args.riskLevel,
    regime: args.regime,
    bucket,
    sleeve_cap_pct: cap,
    sleeve_target_pct: target,
    current_sleeve_pct: currentPct,
    hard_veto: hardVeto,
    veto_reason: vetoReason,
    symbols: symbolSignals,
    notes,
  };
}

// --- Prompt block -----------------------------------------------------------

export function formatCryptoSignalsBlock(d: CryptoSleeveDecision): string {
  const pct = (x: number | null | undefined, digits = 1) =>
    x == null || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(digits)}%`;
  const num = (x: number | null | undefined, digits = 2) =>
    x == null || !Number.isFinite(x) ? "n/a" : x.toFixed(digits);

  const header = `=== CRYPTO SLEEVE — COMPUTED SIGNALS ===
As of ${d.as_of} | risk ${d.risk_level} | regime ${d.regime} (${d.bucket})
Sleeve cap ${pct(d.sleeve_cap_pct, 0)} of NAV | target ${pct(d.sleeve_target_pct)} | current ${pct(d.current_sleeve_pct)}
${d.hard_veto ? `HARD VETO: ${d.veto_reason}` : "No hard veto."}
Notes: ${d.notes.join(" | ")}`;

  const rows = d.symbols.map((s) => {
    return [
      `- ${s.symbol} (${s.group})`,
      `action=${s.action}`,
      `size=${(s.size_fraction_of_cap * 100).toFixed(0)}% of per-symbol cap`,
      `price=${num(s.price)}`,
      `sma50=${num(s.sma50)} sma200=${num(s.sma200)}`,
      `trend_up=${s.trend_up}`,
      `rsi14=${num(s.rsi14, 1)}`,
      `ret60=${pct(s.return_60d)}`,
      `vol20=${pct(s.vol_20d, 2)}`,
      `dd90=${pct(s.drawdown_from_90d_peak)}`,
      `below_sma50_streak=${s.below_sma50_streak}`,
      s.parabolic_veto ? "PARABOLIC" : "",
      s.regime_veto ? "REGIME_VETO" : "",
      `gates=${s.entry_gates_passed}/4`,
      `— ${s.rationale}`,
    ].filter(Boolean).join(" | ");
  }).join("\n");

  return `${header}\n${rows}\n=== END CRYPTO SLEEVE ===`;
}
