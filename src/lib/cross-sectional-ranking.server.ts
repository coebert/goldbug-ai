// Cross-sectional ranking across the daily candidate universe.
// Composite = momentum + quality + low-vol + trend confirmation.
// Standardises each sub-score to a z-score across TODAY'S universe so we
// only buy the strongest names relative to their peers (top decile),
// rather than buying anything with a positive absolute signal.

type FeatureLike = {
  symbol: string;
  change5d: number | null;
  change30d: number | null;
  vol20d: number | null;
  bb_width: number | null;
  sma20: number | null;
  sma50: number | null;
  rsi14: number | null;
  weekly_trend_up: boolean;
  macd_hist: number | null;
  vw_momentum_10d: number | null;
};

export type RankInfo = {
  composite_score: number;   // z-summed composite
  percentile: number;        // 0..1
  rank: number;              // 1 = best
  universe_size: number;
  top_decile: boolean;
  top_quartile: boolean;
  momentum_z: number;
  quality_z: number;
  low_vol_z: number;
  trend_z: number;
};

function zscoresOf(values: Array<number | null>): number[] {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length < 2) return values.map(() => 0);
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance =
    nums.reduce((a, b) => a + (b - mean) * (b - mean), 0) / nums.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return values.map(() => 0);
  return values.map((v) => (v == null || !Number.isFinite(v) ? 0 : (v - mean) / sd));
}

export function computeCrossSectionalRanks<T extends FeatureLike>(
  features: T[],
): Map<string, RankInfo> {
  const n = features.length;
  if (n === 0) return new Map();

  // Sub-scores per symbol
  const momentum = features.map((f) => {
    // Combined 30d change + volume-weighted 10d momentum
    const a = f.change30d ?? 0;
    const b = f.vw_momentum_10d ?? 0;
    return a + b * 0.5;
  });
  const quality = features.map((f) => {
    // Lower Bollinger width relative to peers = steadier price action = higher quality
    const bw = f.bb_width;
    return bw == null ? 0 : -bw;
  });
  const lowVol = features.map((f) => {
    const v = f.vol20d;
    return v == null || v <= 0 ? 0 : -v;
  });
  const trend = features.map((f) => {
    let score = 0;
    if (f.sma20 != null && f.sma50 != null && f.sma20 > f.sma50) score += 1;
    if (f.weekly_trend_up) score += 1;
    if (f.macd_hist != null && f.macd_hist > 0) score += 0.5;
    if (f.rsi14 != null && f.rsi14 > 50 && f.rsi14 < 70) score += 0.5;
    return score;
  });

  const zMom = zscoresOf(momentum);
  const zQual = zscoresOf(quality);
  const zLV = zscoresOf(lowVol);
  const zTr = zscoresOf(trend);

  // Composite weights: momentum & trend dominate, quality/low-vol tie-break.
  const composite = features.map((_, i) =>
    zMom[i] * 0.4 + zTr[i] * 0.3 + zQual[i] * 0.15 + zLV[i] * 0.15,
  );

  // Rank descending by composite
  const order = features
    .map((f, i) => ({ symbol: f.symbol, i, score: composite[i] }))
    .sort((a, b) => b.score - a.score);

  const decileCutoff = Math.max(1, Math.ceil(n * 0.1));
  const quartileCutoff = Math.max(1, Math.ceil(n * 0.25));

  const map = new Map<string, RankInfo>();
  order.forEach((row, rankIdx) => {
    const rank = rankIdx + 1;
    map.set(row.symbol, {
      composite_score: Number(composite[row.i].toFixed(3)),
      percentile: Number(((n - rank) / Math.max(1, n - 1)).toFixed(3)),
      rank,
      universe_size: n,
      top_decile: rank <= decileCutoff,
      top_quartile: rank <= quartileCutoff,
      momentum_z: Number(zMom[row.i].toFixed(2)),
      quality_z: Number(zQual[row.i].toFixed(2)),
      low_vol_z: Number(zLV[row.i].toFixed(2)),
      trend_z: Number(zTr[row.i].toFixed(2)),
    });
  });
  return map;
}

export function formatCrossSectionalBlock(ranks: Map<string, RankInfo>): string {
  if (ranks.size === 0) return "CROSS-SECTIONAL RANK: unavailable.";
  const rows = Array.from(ranks.entries())
    .map(([symbol, r]) => ({ symbol, ...r }))
    .sort((a, b) => a.rank - b.rank);
  const top = rows.slice(0, Math.min(8, rows.length));
  const bottom = rows.slice(-Math.min(4, rows.length));
  const line = (r: (typeof rows)[number]) =>
    `  #${r.rank}/${r.universe_size} ${r.symbol} — composite ${r.composite_score} (mom ${r.momentum_z}, trend ${r.trend_z}, qual ${r.quality_z}, lv ${r.low_vol_z})`;
  return `CROSS-SECTIONAL RANK (relative strength across today's universe):
Top of pack (buy-eligible — top decile marked *):
${top.map((r) => `${r.top_decile ? "*" : " "}${line(r)}`).join("\n")}
Bottom of pack (avoid fresh longs; consider trims if held):
${bottom.map(line).join("\n")}
HARD PREFERENCE: New BUYs should come from the top decile (*). Symbols outside the top quartile get their conviction auto-halved by guardrails.`;
}
