// Cross-asset context: pull latest snapshots for VIX, DXY, TLT, GLD, HYG.
// Used by the trading engine to give the AI macro texture that individual-name
// technicals cannot capture (fear gauge, dollar strength, credit stress).

import { getDailyCandles, pctChange, sma } from "./market-data.server";

export type CrossAssetSnapshot = {
  vix_level: number | null;
  vix_change_5d: number | null;
  dxy_level: number | null;
  dxy_change_20d: number | null;
  tlt_change_20d: number | null;
  gld_change_20d: number | null;
  hyg_change_20d: number | null; // credit stress proxy
  vix_regime: "calm" | "elevated" | "stressed" | "unknown";
  dollar_trend: "strong" | "weak" | "flat" | "unknown";
};

async function tryLast(symbol: string, days = 60, asOf?: string) {
  try {
    const candles = await getDailyCandles(symbol, days, asOf);
    if (candles.length < 5) return null;
    return candles.map((c) => c.close);
  } catch {
    return null;
  }
}

export async function getCrossAssetSnapshot(asOf: string): Promise<CrossAssetSnapshot> {
  const [vix, dxy, tlt, gld, hyg] = await Promise.all([
    tryLast("^VIX", 60, asOf),
    tryLast("DX-Y.NYB", 60, asOf),
    tryLast("TLT", 60, asOf),
    tryLast("GLD", 60, asOf),
    tryLast("HYG", 60, asOf),
  ]);

  const vixLevel = vix?.[vix.length - 1] ?? null;
  const vixChange = vix ? pctChange(vix, 5) : null;
  const dxyLevel = dxy?.[dxy.length - 1] ?? null;
  const dxyChange = dxy ? pctChange(dxy, 20) : null;
  const dxySma50 = dxy ? sma(dxy, 50) : null;

  let vixRegime: CrossAssetSnapshot["vix_regime"] = "unknown";
  if (vixLevel != null) {
    if (vixLevel < 15) vixRegime = "calm";
    else if (vixLevel < 22) vixRegime = "elevated";
    else vixRegime = "stressed";
  }

  let dollarTrend: CrossAssetSnapshot["dollar_trend"] = "unknown";
  if (dxyLevel != null && dxySma50 != null) {
    const diff = (dxyLevel - dxySma50) / dxySma50;
    if (diff > 0.02) dollarTrend = "strong";
    else if (diff < -0.02) dollarTrend = "weak";
    else dollarTrend = "flat";
  }

  return {
    vix_level: vixLevel,
    vix_change_5d: vixChange,
    dxy_level: dxyLevel,
    dxy_change_20d: dxyChange,
    tlt_change_20d: tlt ? pctChange(tlt, 20) : null,
    gld_change_20d: gld ? pctChange(gld, 20) : null,
    hyg_change_20d: hyg ? pctChange(hyg, 20) : null,
    vix_regime: vixRegime,
    dollar_trend: dollarTrend,
  };
}

export function formatCrossAssetBlock(x: CrossAssetSnapshot): string {
  const pct = (v: number | null) => (v == null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  const num = (v: number | null, d = 2) => (v == null ? "n/a" : v.toFixed(d));
  return `CROSS-ASSET CONTEXT:
- VIX ${num(x.vix_level)} (${x.vix_regime}), 5d change ${pct(x.vix_change_5d)}
- DXY ${num(x.dxy_level)} — dollar ${x.dollar_trend} (20d ${pct(x.dxy_change_20d)})
- TLT 20d ${pct(x.tlt_change_20d)} — long bonds
- GLD 20d ${pct(x.gld_change_20d)} — gold
- HYG 20d ${pct(x.hyg_change_20d)} — high-yield credit (proxy for credit stress)
Use these to sanity-check risk-on / risk-off posture.`;
}
