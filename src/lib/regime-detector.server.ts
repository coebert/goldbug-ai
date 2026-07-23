// Macro regime detection based on broad-market proxies.
// Classifies each day into one of: bull_quiet, bull_volatile, correction,
// bear, crisis, recovery. Persists to public.market_regimes and flags
// transitions vs the previously stored day.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDailyCandles, sma, dailyVolatility, pctChange } from "./market-data.server";

export type RegimeLabel =
  | "bull_quiet"
  | "bull_volatile"
  | "correction"
  | "bear"
  | "crisis"
  | "recovery";

export type RegimeSignals = {
  spy_price: number | null;
  spy_sma50: number | null;
  spy_sma200: number | null;
  spy_drawdown_pct: number | null; // negative number: -0.12 = 12% below 1y high
  spy_return_30d: number | null;
  spy_vol_20d: number | null; // daily stdev of returns
  vix_level: number | null;
  gld_return_30d: number | null;
  tlt_return_30d: number | null;
};

export type RegimeAssessment = {
  regime: RegimeLabel;
  confidence: number; // 0..1
  signals: RegimeSignals;
  notes: string;
};

const REGIME_DESCRIPTIONS: Record<RegimeLabel, string> = {
  bull_quiet:
    "Trending bull market, low realised & implied vol. Historical priors: momentum & trend-following work; buy-the-dip is high win-rate; keep risk-on exposure.",
  bull_volatile:
    "Uptrend intact but volatility elevated. Priors: reduce position size, prefer quality/large-cap over speculative, widen stops.",
  correction:
    "10-20% pullback from highs, trend damaged but not broken. Priors: partial de-risking, favour defensives, keep dry powder, avoid catching falling knives.",
  bear:
    "Sustained downtrend, price below 200d MA. Priors: cash + bonds + gold outperform equities; oversold bounces often fail; small tactical longs only.",
  crisis:
    "Panic / dislocation (VIX > 30, >20% drawdown, or sharp shock). Priors: capital preservation first; historically strong 12-month forward returns AFTER capitulation.",
  recovery:
    "Emerging from bear/crisis, price reclaiming trend. Priors: cyclicals, small caps and beaten-down quality lead; aggressive dip-buying rewarded.",
};

export function regimeDescription(r: RegimeLabel): string {
  return REGIME_DESCRIPTIONS[r];
}

export function humanRegime(r: RegimeLabel): string {
  return r.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function safeCandles(sym: string, days: number, asOf: string) {
  try {
    return await getDailyCandles(sym, days, asOf);
  } catch {
    return [];
  }
}

async function computeSignals(asOf: string): Promise<RegimeSignals> {
  const [spy, vix, gld, tlt] = await Promise.all([
    safeCandles("SPY", 260, asOf),
    safeCandles("^VIX", 60, asOf),
    safeCandles("GLD", 60, asOf),
    safeCandles("TLT", 60, asOf),
  ]);

  const spyCloses = spy.map((c) => c.close);
  const spyPrice = spyCloses.length ? spyCloses[spyCloses.length - 1] : null;
  const spySma50 = sma(spyCloses, 50);
  const spySma200 = sma(spyCloses, 200);
  const spyVol = dailyVolatility(spyCloses, 20);
  const spyRet30 = pctChange(spyCloses, 30);
  // 1-year rolling high
  let dd: number | null = null;
  if (spyCloses.length >= 20 && spyPrice != null) {
    const lookback = spyCloses.slice(-252);
    const peak = Math.max(...lookback);
    if (peak > 0) dd = (spyPrice - peak) / peak;
  }

  const vixCloses = vix.map((c) => c.close);
  const vixLevel = vixCloses.length ? vixCloses[vixCloses.length - 1] : null;

  const gldCloses = gld.map((c) => c.close);
  const gldRet30 = pctChange(gldCloses, 30);
  const tltCloses = tlt.map((c) => c.close);
  const tltRet30 = pctChange(tltCloses, 30);

  return {
    spy_price: spyPrice,
    spy_sma50: spySma50,
    spy_sma200: spySma200,
    spy_drawdown_pct: dd,
    spy_return_30d: spyRet30,
    spy_vol_20d: spyVol,
    vix_level: vixLevel,
    gld_return_30d: gldRet30,
    tlt_return_30d: tltRet30,
  };
}

function classify(s: RegimeSignals): { regime: RegimeLabel; confidence: number; notes: string } {
  const price = s.spy_price;
  const s200 = s.spy_sma200;
  const s50 = s.spy_sma50;
  const dd = s.spy_drawdown_pct ?? 0;
  const vix = s.vix_level ?? 18;
  const ret30 = s.spy_return_30d ?? 0;
  const vol = s.spy_vol_20d ?? 0.01;

  const reasons: string[] = [];

  // CRISIS: extreme panic
  if (vix >= 30 || dd <= -0.2) {
    reasons.push(
      `VIX ${vix.toFixed(1)}, drawdown ${(dd * 100).toFixed(1)}% — panic thresholds breached`,
    );
    return { regime: "crisis", confidence: 0.85, notes: reasons.join("; ") };
  }

  // BEAR: price meaningfully below 200d
  if (price != null && s200 != null && price < s200 * 0.97 && dd <= -0.1) {
    reasons.push(
      `SPY ${((price / s200 - 1) * 100).toFixed(1)}% vs 200d MA, drawdown ${(dd * 100).toFixed(1)}%`,
    );
    return { regime: "bear", confidence: 0.75, notes: reasons.join("; ") };
  }

  // RECOVERY: reclaiming 200d after a deep drawdown, positive 30d
  if (price != null && s200 != null && price >= s200 && dd <= -0.1 && ret30 > 0.03) {
    reasons.push(
      `SPY back above 200d MA (${((price / s200 - 1) * 100).toFixed(1)}%) after ${(dd * 100).toFixed(1)}% drawdown, +${(ret30 * 100).toFixed(1)}% last 30d`,
    );
    return { regime: "recovery", confidence: 0.7, notes: reasons.join("; ") };
  }

  // CORRECTION: 5-15% drawdown, trend still up-ish
  if (dd <= -0.05 && dd > -0.2) {
    reasons.push(`SPY drawdown ${(dd * 100).toFixed(1)}% from 1y high`);
    if (vix >= 22) reasons.push(`VIX elevated at ${vix.toFixed(1)}`);
    return { regime: "correction", confidence: 0.7, notes: reasons.join("; ") };
  }

  // BULL variants
  const inUptrend =
    price != null && s50 != null && s200 != null && price > s200 && s50 > s200;
  if (inUptrend) {
    if (vix >= 22 || vol > 0.015) {
      reasons.push(
        `Uptrend intact, but VIX ${vix.toFixed(1)} / 20d vol ${(vol * 100).toFixed(2)}%`,
      );
      return { regime: "bull_volatile", confidence: 0.7, notes: reasons.join("; ") };
    }
    reasons.push(
      `SPY > 200d MA, VIX ${vix.toFixed(1)}, 30d return ${(ret30 * 100).toFixed(1)}%`,
    );
    return { regime: "bull_quiet", confidence: 0.8, notes: reasons.join("; ") };
  }

  // Fallback: mild pullback / choppy
  reasons.push("Mixed signals — default to correction posture");
  return { regime: "correction", confidence: 0.4, notes: reasons.join("; ") };
}

export async function assessRegime(asOf: string): Promise<RegimeAssessment> {
  const signals = await computeSignals(asOf);
  const c = classify(signals);
  return { regime: c.regime, confidence: c.confidence, signals, notes: c.notes };
}

export type PersistedRegime = {
  regime: RegimeLabel;
  previous_regime: RegimeLabel | null;
  transitioned: boolean;
  confidence: number;
  signals: RegimeSignals;
  notes: string;
  as_of: string;
};

export async function detectAndPersistRegime(asOf: string): Promise<PersistedRegime> {
  const assessment = await assessRegime(asOf);

  // Look up latest prior stored regime (strictly earlier than asOf)
  const { data: priorRow } = await supabaseAdmin
    .from("market_regimes")
    .select("regime, as_of")
    .lt("as_of", asOf)
    .order("as_of", { ascending: false })
    .limit(1)
    .maybeSingle();

  const previous = (priorRow?.regime as RegimeLabel | undefined) ?? null;
  const transitioned = previous != null && previous !== assessment.regime;

  await supabaseAdmin.from("market_regimes").upsert(
    {
      as_of: asOf,
      regime: assessment.regime,
      confidence: assessment.confidence,
      previous_regime: previous,
      transitioned,
      signals: assessment.signals as unknown as never,
      notes: assessment.notes,
    },
    { onConflict: "as_of" },
  );

  return {
    regime: assessment.regime,
    previous_regime: previous,
    transitioned,
    confidence: assessment.confidence,
    signals: assessment.signals,
    notes: assessment.notes,
    as_of: asOf,
  };
}
