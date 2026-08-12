// RSI divergence detection.
//
// A divergence is a disagreement between price and momentum at two adjacent
// swing points:
//   - Bullish: price makes a LOWER low while RSI makes a HIGHER low (selling
//     pressure fading into the new low) — a potential bottom.
//   - Bearish: price makes a HIGHER high while RSI makes a LOWER high (buying
//     pressure fading into the new high) — a potential top.
//
// Swings are found with a symmetric fractal window: a bar is a pivot low when
// no bar within `lookaround` on either side closed lower (and vice versa for
// highs). Only confirmed pivots are used, so the newest `lookaround` bars can
// never produce a signal that later disappears.

import type { HistoryPoint } from "./market-symbol-history";

export type DivergenceKind = "bullish" | "bearish";

export interface DivergencePoint {
  index: number;
  date: string;
  price: number;
  rsi: number;
}

export interface RsiDivergence {
  kind: DivergenceKind;
  from: DivergencePoint;
  to: DivergencePoint;
  /** Bars between the two pivots. */
  bars: number;
  /** Price move between pivots, in %. */
  pricePct: number;
  /** RSI move between pivots, in points. */
  rsiDelta: number;
}

export interface DivergenceOptions {
  /** Bars either side of a pivot that must not exceed it. */
  lookaround?: number;
  /** Minimum bars between paired pivots (filters noise). */
  minGap?: number;
  /** Maximum bars between paired pivots (stale pairings are meaningless). */
  maxGap?: number;
  /** Bullish pivots must start below this RSI; bearish above 100 - this. */
  rsiExtreme?: number;
  /** Minimum |RSI| disagreement in points. */
  minRsiDelta?: number;
  /** Minimum |price| disagreement in %. */
  minPricePct?: number;
}

const DEFAULTS: Required<DivergenceOptions> = {
  lookaround: 3,
  minGap: 5,
  maxGap: 60,
  rsiExtreme: 45,
  minRsiDelta: 2,
  minPricePct: 0.5,
};

interface Pivot {
  index: number;
  kind: "low" | "high";
}

/** Confirmed fractal pivots over the close series. */
export function findPivots(closes: number[], lookaround: number): Pivot[] {
  const out: Pivot[] = [];
  for (let i = lookaround; i < closes.length - lookaround; i++) {
    let low = true;
    let high = true;
    for (let j = i - lookaround; j <= i + lookaround; j++) {
      if (j === i) continue;
      if (closes[j] <= closes[i]) low = false;
      if (closes[j] >= closes[i]) high = false;
    }
    if (low) out.push({ index: i, kind: "low" });
    else if (high) out.push({ index: i, kind: "high" });
  }
  return out;
}

/**
 * Detect bullish/bearish RSI divergences over a chart window. Points without
 * a warm RSI value are ignored.
 */
export function detectRsiDivergences(
  points: HistoryPoint[],
  options: DivergenceOptions = {},
): RsiDivergence[] {
  const o = { ...DEFAULTS, ...options };
  if (points.length < o.lookaround * 2 + 2) return [];

  const closes = points.map((p) => p.close);
  const rsi = points.map((p) => (typeof p.rsi14 === "number" ? p.rsi14 : null));
  const pivots = findPivots(closes, o.lookaround).filter((p) => rsi[p.index] != null);

  const at = (index: number): DivergencePoint => ({
    index,
    date: points[index].date,
    price: closes[index],
    rsi: rsi[index] as number,
  });

  const out: RsiDivergence[] = [];
  for (const kind of ["low", "high"] as const) {
    const seq = pivots.filter((p) => p.kind === kind);
    for (let i = 1; i < seq.length; i++) {
      const a = at(seq[i - 1].index);
      const b = at(seq[i].index);
      const bars = b.index - a.index;
      if (bars < o.minGap || bars > o.maxGap) continue;

      const pricePct = ((b.price - a.price) / a.price) * 100;
      const rsiDelta = b.rsi - a.rsi;
      if (Math.abs(pricePct) < o.minPricePct || Math.abs(rsiDelta) < o.minRsiDelta) continue;

      if (kind === "low") {
        // Lower low in price, higher low in RSI, starting from weak momentum.
        if (pricePct < 0 && rsiDelta > 0 && a.rsi <= o.rsiExtreme) {
          out.push({ kind: "bullish", from: a, to: b, bars, pricePct, rsiDelta });
        }
      } else if (pricePct > 0 && rsiDelta < 0 && a.rsi >= 100 - o.rsiExtreme) {
        // Higher high in price, lower high in RSI, from stretched momentum.
        out.push({ kind: "bearish", from: a, to: b, bars, pricePct, rsiDelta });
      }
    }
  }

  return out.sort((x, y) => x.to.index - y.to.index);
}

export function divergenceSummary(d: RsiDivergence): string {
  return d.kind === "bullish"
    ? `Bullish: price ${d.pricePct.toFixed(1)}% lower, RSI +${d.rsiDelta.toFixed(1)}`
    : `Bearish: price +${d.pricePct.toFixed(1)}%, RSI ${d.rsiDelta.toFixed(1)}`;
}
