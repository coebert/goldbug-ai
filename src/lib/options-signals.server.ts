// Options-implied signals: VIX term structure + volatility-of-vol + put/call proxy.
// Uses public Yahoo Finance tickers so no extra data provider is required.
// - ^VIX     : 30-day implied vol on SPX
// - ^VIX3M   : 3-month implied vol on SPX
// - ^VIX9D   : 9-day implied vol on SPX (short-term stress)
// - ^VVIX    : vol-of-vol (uncertainty about vol itself)
// - ^SKEW    : CBOE SKEW index (tail-risk pricing, ~100-150)
// If any series is unavailable we degrade gracefully.

import { getDailyCandles, pctChange } from "./market-data.server";

export type OptionsSnapshot = {
  vix: number | null;
  vix9d: number | null;
  vix3m: number | null;
  vvix: number | null;
  skew: number | null;
  term_structure: "contango" | "flat" | "backwardation" | "unknown"; // VIX3M vs VIX
  short_term_stress: "calm" | "elevated" | "spike" | "unknown";     // VIX9D vs VIX
  vvix_regime: "low" | "normal" | "elevated" | "unknown";
  tail_risk: "muted" | "normal" | "elevated" | "extreme" | "unknown"; // SKEW bands
  vix_change_5d: number | null;
  put_call_proxy: number | null; // heuristic 0..1 (higher = more defensive positioning)
};

async function lastClose(symbol: string, days: number, asOf: string): Promise<number | null> {
  try {
    const candles = await getDailyCandles(symbol, days, asOf);
    if (!candles.length) return null;
    return candles[candles.length - 1].close;
  } catch {
    return null;
  }
}

async function series(symbol: string, days: number, asOf: string): Promise<number[] | null> {
  try {
    const candles = await getDailyCandles(symbol, days, asOf);
    if (candles.length < 5) return null;
    return candles.map((c) => c.close);
  } catch {
    return null;
  }
}

export async function getOptionsSnapshot(asOf: string): Promise<OptionsSnapshot> {
  const [vixSeries, vix9d, vix3m, vvix, skew, spy] = await Promise.all([
    series("^VIX", 30, asOf),
    lastClose("^VIX9D", 15, asOf),
    lastClose("^VIX3M", 15, asOf),
    lastClose("^VVIX", 15, asOf),
    lastClose("^SKEW", 15, asOf),
    series("SPY", 15, asOf),
  ]);

  const vix = vixSeries?.[vixSeries.length - 1] ?? null;
  const vixChange5d = vixSeries ? pctChange(vixSeries, 5) : null;

  let term: OptionsSnapshot["term_structure"] = "unknown";
  if (vix != null && vix3m != null) {
    const ratio = vix3m / vix;
    if (ratio > 1.05) term = "contango";
    else if (ratio < 0.98) term = "backwardation";
    else term = "flat";
  }

  let shortTerm: OptionsSnapshot["short_term_stress"] = "unknown";
  if (vix != null && vix9d != null) {
    if (vix9d > vix * 1.15) shortTerm = "spike";
    else if (vix9d > vix * 1.02) shortTerm = "elevated";
    else shortTerm = "calm";
  }

  let vvixRegime: OptionsSnapshot["vvix_regime"] = "unknown";
  if (vvix != null) {
    if (vvix < 85) vvixRegime = "low";
    else if (vvix < 110) vvixRegime = "normal";
    else vvixRegime = "elevated";
  }

  let tail: OptionsSnapshot["tail_risk"] = "unknown";
  if (skew != null) {
    if (skew < 120) tail = "muted";
    else if (skew < 135) tail = "normal";
    else if (skew < 145) tail = "elevated";
    else tail = "extreme";
  }

  // Put/call proxy: co-movement of VIX up while SPY down over 5d indicates
  // defensive positioning. Combined with term-structure backwardation this
  // approximates a rising put/call ratio when the true CPCE feed is unavailable.
  let putCallProxy: number | null = null;
  if (vixSeries && spy) {
    const vixRet = pctChange(vixSeries, 5) ?? 0;
    const spyRet = pctChange(spy, 5) ?? 0;
    // Map to 0..1: higher when VIX rising & SPY falling
    const raw = vixRet - spyRet; // e.g. VIX +10%, SPY -3% => 0.13
    const scaled = Math.max(0, Math.min(1, 0.5 + raw * 2));
    putCallProxy = Number(scaled.toFixed(2));
  }

  return {
    vix,
    vix9d,
    vix3m,
    vvix,
    skew,
    term_structure: term,
    short_term_stress: shortTerm,
    vvix_regime: vvixRegime,
    tail_risk: tail,
    vix_change_5d: vixChange5d,
    put_call_proxy: putCallProxy,
  };
}

export function formatOptionsBlock(x: OptionsSnapshot): string {
  const num = (v: number | null, d = 2) => (v == null ? "n/a" : v.toFixed(d));
  const pct = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  const guidance: string[] = [];
  if (x.term_structure === "backwardation")
    guidance.push("VIX curve in BACKWARDATION — near-term hedging demand; reduce net risk and tighten stops.");
  else if (x.term_structure === "contango")
    guidance.push("VIX curve in CONTANGO — market expects near-term calm; normal risk-on posture permitted.");
  if (x.short_term_stress === "spike")
    guidance.push("Very-short-dated (9d) vol spiking above 30d — an imminent catalyst is being priced; avoid fresh full-size entries.");
  if (x.vvix_regime === "elevated")
    guidance.push("VVIX elevated — uncertainty about volatility itself is high; downsize new positions.");
  if (x.tail_risk === "elevated" || x.tail_risk === "extreme")
    guidance.push(`SKEW ${x.tail_risk} — options market is pricing left-tail risk; prefer trimming crowded winners and skipping speculative names.`);
  if (x.put_call_proxy != null && x.put_call_proxy > 0.7)
    guidance.push("Defensive positioning proxy is high — treat rallies with more scepticism.");

  return `OPTIONS-IMPLIED SIGNALS (as of ${new Date().toISOString().slice(0, 10)}):
- VIX ${num(x.vix)} (5d ${pct(x.vix_change_5d)}), VIX9D ${num(x.vix9d)}, VIX3M ${num(x.vix3m)} → term structure ${x.term_structure}
- Short-term stress: ${x.short_term_stress}
- VVIX ${num(x.vvix)} (${x.vvix_regime}) — vol-of-vol
- SKEW ${num(x.skew)} → tail risk ${x.tail_risk}
- Put/call proxy: ${x.put_call_proxy == null ? "n/a" : x.put_call_proxy}
${guidance.length ? guidance.map((g) => `• ${g}`).join("\n") : "• No unusual options-market stress signals."}
Use these to gate conviction: backwardation/spike/elevated-tail = size DOWN even if trend is positive.`;
}
