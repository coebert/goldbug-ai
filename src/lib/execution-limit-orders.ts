// Limit-order execution model: maker/taker odds, queue fill probability, and
// the adverse selection you pay for the privilege of not crossing the spread.
//
// `execution-monte-carlo.ts` and `execution-correlated-shocks.ts` both assume
// every order is a marketable one: it crosses, it pays the (random) spread,
// and the only question is how much of the size completes. That is the honest
// model for the way the engine trades today, but it prices out the obvious
// cost lever — resting passively and letting the tape come to you.
//
// A resting order is not free, it is a *lottery with a bad prize*:
//
//   1. It only fills if the price actually reaches the limit during the bar
//      (`pTouch`, falling with the passive offset and rising with volatility).
//   2. Even when touched, it only fills if the queue ahead of it clears
//      (`pQueue`, the displayed depth ahead versus the volume that trades at
//      that level on the bar).
//   3. Conditional on both, the fill is *adversely selected*: the reason the
//      tape came to your bid is usually that it is about to keep going. That
//      shows up as `adverseBps`, which is what makes naive "just post passive,
//      save the spread" backtests lie.
//
// An order that fails the lottery either keeps working for another bar or
// crosses (`crossAfterBars`), paying the full taker spread plus the drift it
// waited through. The net of those four effects is what this module draws.
//
// Everything is pure and seeded: same seed and same inputs → same fills.

import {
  DEFAULT_EXECUTION_SIM,
  mulberry32,
  type ExecutionDraw,
  type ExecutionSimConfig,
} from "./execution-monte-carlo";

export type LimitOrderConfig = {
  /**
   * How far behind the touch the order rests, in bps of price. 0 = join the
   * near side (best odds, worst queue), higher = more passive.
   */
  limitOffsetBps: number;
  /**
   * Sensitivity of the touch probability to volatility: pTouch =
   * exp(-offsetBps / (touchBeta * barVolBps)). Higher = easier to get touched.
   */
  touchBeta: number;
  /** Displayed size ahead of us in the queue, as a multiple of our order size. */
  queueAheadRatio: number;
  /**
   * Volume that trades at our level on a touched bar, as a multiple of our
   * order size. Queue fill odds are turnover / (turnover + queueAhead).
   */
  queueTurnoverRatio: number;
  /** Bars the order rests before it gives up and crosses. 0 = cross immediately. */
  crossAfterBars: number;
  /** If false, an order that never fills passively is simply cancelled. */
  crossOnTimeout: boolean;
  /** Exchange/broker fee on passive fills, bps of notional. Negative = rebate. */
  makerFeeBps: number;
  /** Exchange/broker fee on aggressive fills, bps of notional. */
  takerFeeBps: number;
  /**
   * Spread+impact multiplier for a passive fill. We did not cross, so this is
   * well under 1 — but it is not 0, because the limit itself sits inside a
   * spread that the cost model already charges.
   */
  makerSpreadMult: number;
  /**
   * Adverse selection charged on a passive fill, as a fraction of the bar's
   * volatility in bps. 0.25 with a 100bps bar = 25bps of post-fill drift.
   */
  adverseSelectionBeta: number;
  /**
   * Drift paid per bar spent waiting before crossing, as a fraction of bar
   * volatility. This is the cost of being late, and it is why patience is not
   * free even when the eventual fill is aggressive.
   */
  waitDriftBeta: number;
  /** Probability a passive fill is partial rather than complete. */
  makerPartialProb: number;
  /** Smallest fraction of size a partial passive fill delivers. */
  minFillRatio: number;
  /** Queue turnover multiplier while the tape is stressed (volume spikes). */
  stressTurnoverMult: number;
  /** Adverse-selection multiplier while stressed — bad fills get worse. */
  stressAdverseMult: number;
};

export const DEFAULT_LIMIT_ORDER: LimitOrderConfig = {
  limitOffsetBps: 5,
  touchBeta: 0.6,
  queueAheadRatio: 3,
  queueTurnoverRatio: 2,
  crossAfterBars: 1,
  crossOnTimeout: true,
  makerFeeBps: -0.2,
  takerFeeBps: 0.5,
  makerSpreadMult: 0.15,
  adverseSelectionBeta: 0.22,
  waitDriftBeta: 0.12,
  makerPartialProb: 0.35,
  minFillRatio: DEFAULT_EXECUTION_SIM.minFillRatio,
  stressTurnoverMult: 1.6,
  stressAdverseMult: 1.8,
};

export type Liquidity = "maker" | "taker" | "none";

export type LimitOrderDraw = ExecutionDraw & {
  /** How the order ended up: resting fill, crossed, or nothing. */
  liquidity: Liquidity;
  /** Fee/rebate on the filled notional in bps. Negative = rebate earned. */
  feeBps: number;
  /**
   * Adverse selection + waiting drift in bps of the filled notional. This is
   * a real cost, it is just not a spread — keep it out of `slippageMult` so
   * the calibrated spread model is not double-counted.
   */
  driftBps: number;
  /** Bars the order rested before resolving. */
  waitedBars: number;
  /** The passive limit was reached by the tape at least once. */
  touched: boolean;
};

/** Odds an order of this shape gets touched and cleared on a single bar. */
export function limitFillOdds(
  cfg: LimitOrderConfig,
  barVolBps: number,
  stressed = false,
): { pTouch: number; pQueue: number; pFill: number } {
  const vol = Math.max(1e-6, barVolBps);
  const offset = Math.max(0, cfg.limitOffsetBps);
  const pTouch = Math.min(1, Math.exp(-offset / Math.max(1e-6, cfg.touchBeta * vol)));
  const turnover = Math.max(0, cfg.queueTurnoverRatio) * (stressed ? cfg.stressTurnoverMult : 1);
  const ahead = Math.max(0, cfg.queueAheadRatio);
  const pQueue = turnover + ahead > 0 ? turnover / (turnover + ahead) : 0;
  return { pTouch, pQueue, pFill: pTouch * pQueue };
}

export type LimitOrderRequest = {
  /** Realised volatility of the bar in bps — drives touch odds and drift. */
  barVolBps: number;
  /** Whether the bar is in the correlated stress regime. */
  stressed?: boolean;
  /**
   * Slippage multiplier from the underlying (correlated) market-order sampler,
   * used when the order ends up crossing. Defaults to 1.
   */
  takerSlippageMult?: number;
  /** Fill ratio the market-order sampler would have produced when crossing. */
  takerFillRatio?: number;
  /** Force an aggressive order (exits under a stop, liquidations). */
  forceTaker?: boolean;
};

export type LimitOrderSampler = {
  draw: (req: LimitOrderRequest) => LimitOrderDraw;
  /** Running counts, useful for reporting maker share and queue misses. */
  stats: () => LimitOrderStats;
};

export type LimitOrderStats = {
  orders: number;
  makerFills: number;
  takerFills: number;
  unfilled: number;
  /** Orders where the limit was touched but the queue never cleared. */
  queueMisses: number;
  /** Orders the tape never reached. */
  neverTouched: number;
  totalWaitBars: number;
  makerShare: number;
  fillRate: number;
  avgWaitBars: number;
};

const emptyStats = (): Omit<LimitOrderStats, "makerShare" | "fillRate" | "avgWaitBars"> => ({
  orders: 0,
  makerFills: 0,
  takerFills: 0,
  unfilled: 0,
  queueMisses: 0,
  neverTouched: 0,
  totalWaitBars: 0,
});

export function makeLimitOrderSampler(
  cfg: Partial<LimitOrderConfig>,
  seed: number,
): LimitOrderSampler {
  const c = { ...DEFAULT_LIMIT_ORDER, ...cfg };
  const rng = mulberry32(seed);
  const s = emptyStats();

  const draw = (req: LimitOrderRequest): LimitOrderDraw => {
    s.orders++;
    const vol = Math.max(0, req.barVolBps);
    const stressed = req.stressed === true;
    const takerMult = req.takerSlippageMult ?? 1;
    const takerFill = req.takerFillRatio ?? 1;
    const { pTouch, pQueue } = limitFillOdds(c, vol, stressed);

    const cross = (waitedBars: number, touched: boolean): LimitOrderDraw => {
      if (takerFill <= 0) {
        s.unfilled++;
        s.totalWaitBars += waitedBars;
        return {
          liquidity: "none", slippageMult: takerMult, fillRatio: 0,
          feeBps: 0, driftBps: 0, waitedBars, touched,
        };
      }
      s.takerFills++;
      s.totalWaitBars += waitedBars;
      return {
        liquidity: "taker",
        slippageMult: takerMult,
        fillRatio: takerFill,
        feeBps: c.takerFeeBps,
        // Crossing late means you also ate the drift you waited through.
        driftBps: vol * c.waitDriftBeta * waitedBars,
        waitedBars,
        touched,
      };
    };

    if (req.forceTaker || c.crossAfterBars <= 0) return cross(0, false);

    let touched = false;
    for (let bar = 0; bar < c.crossAfterBars; bar++) {
      const touchedNow = rng() < pTouch;
      if (touchedNow) {
        touched = true;
        if (rng() < pQueue) {
          // Passive fill: we saved the spread, and the tape is about to tell
          // us why it was available.
          const partial = rng() < c.makerPartialProb;
          const fillRatio = partial ? c.minFillRatio + rng() * (1 - c.minFillRatio) : 1;
          s.makerFills++;
          s.totalWaitBars += bar;
          return {
            liquidity: "maker",
            slippageMult: c.makerSpreadMult,
            fillRatio,
            feeBps: c.makerFeeBps,
            driftBps:
              vol * c.adverseSelectionBeta * (stressed ? c.stressAdverseMult : 1)
              + vol * c.waitDriftBeta * bar,
            waitedBars: bar,
            touched: true,
          };
        }
      }
    }

    if (touched) s.queueMisses++;
    else s.neverTouched++;
    if (c.crossOnTimeout) return cross(c.crossAfterBars, touched);
    s.unfilled++;
    s.totalWaitBars += c.crossAfterBars;
    return {
      liquidity: "none", slippageMult: takerMult, fillRatio: 0,
      feeBps: 0, driftBps: 0, waitedBars: c.crossAfterBars, touched,
    };
  };

  return {
    draw,
    stats: () => ({
      ...s,
      makerShare: s.orders ? s.makerFills / s.orders : 0,
      fillRate: s.orders ? (s.makerFills + s.takerFills) / s.orders : 0,
      avgWaitBars: s.orders ? s.totalWaitBars / s.orders : 0,
    }),
  };
}

// ------------------------------------------------------------ bar volatility

/**
 * Per-bar realised volatility in bps for a price series (trailing `window`
 * close-to-close stdev). Feeds `barVolBps` so touch odds and adverse selection
 * scale with how much the name actually moves, rather than a global constant.
 */
export function barVolBpsSeries(closes: readonly number[], window = 20): number[] {
  const out = new Array<number>(closes.length).fill(0);
  const rets: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i]!;
    if (i > 0 && prev && prev > 0 && Number.isFinite(cur)) rets.push(cur / prev - 1);
    else if (i > 0) rets.push(0);
    const start = Math.max(0, rets.length - window);
    const slice = rets.slice(start);
    if (slice.length < 3) {
      out[i] = 0;
      continue;
    }
    const m = slice.reduce((a, b) => a + b, 0) / slice.length;
    const v = slice.reduce((a, b) => a + (b - m) ** 2, 0) / (slice.length - 1);
    out[i] = Math.sqrt(v) * 10000;
  }
  return out;
}

/** Convenience: the extra bps a draw costs on top of the spread model. */
export function drawExtraBps(d: LimitOrderDraw): number {
  return d.feeBps + d.driftBps;
}

export type { ExecutionSimConfig };
