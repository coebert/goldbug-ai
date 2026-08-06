// Trading-style backtest: position vs swing on identical price tapes.
//
// Replays the same deterministic multi-asset tape (from `risk-sim-matrix`)
// through the same heuristic entry rules, but runs the *risk-config driven*
// exit engine on top: ATR-scaled hard stop, take-profit, chandelier trail,
// R-multiple scale-outs, conditional time stop, hard max-hold cap, post-exit
// re-entry lockout, and the swing min-hold churn guard.
//
// The only difference between the two arms is `parseRiskConfig({ trading_style })`,
// so any metric delta is attributable to the horizon/risk rules themselves.
//
// Pure and seeded: same inputs always produce the same table.

import { runBacktest, type BacktestBar } from "@/lib/backtest-runner";
import type { SimDecision, SimulateOptions } from "@/lib/broker-simulator";
import { buildHeuristicBuys, buildHeuristicSells } from "@/lib/heuristic-decision";
import {
  buildPriceTape,
  featuresFrom,
  DEFAULT_UNIVERSE,
  type AssetSpec,
  type RiskLevel,
} from "@/lib/risk-sim-matrix";
import {
  computeMaxDrawdown,
  computeSharpe,
  computeAnnualisedVolPct,
  dailyReturns,
  type EquityPoint,
} from "@/lib/backtest-metrics";
import {
  atrScaledStopPct,
  evaluateChandelier,
  evaluateScaleOut,
  evaluateTimeStop,
  reentryLockoutDays,
} from "@/lib/exits";
import { minHoldDays, type TradingStyle } from "@/lib/trading-style";
import type { PolicyOrder, StylePolicy } from "@/lib/style-policy";
import type { RiskConfig } from "@/lib/universe.server";

export const STYLE_HORIZONS: Array<{ label: string; bars: number }> = [
  { label: "3M", bars: 63 },
  { label: "6M", bars: 126 },
  { label: "1Y", bars: 252 },
  { label: "2Y", bars: 504 },
];

export const STYLE_SEEDS = [20260731, 771, 4242, 90210, 13337];

/**
 * Portfolio-weight sleeve per risk level. The heuristic fallback's own sleeve
 * is deliberately tiny (it exists for AI-outage ticks), which would leave the
 * book ~95% cash and make the comparison a fee-drag contest. Here we size to
 * portfolio weights so both styles run a genuinely invested book.
 */
export const ENTRY_SLEEVE: Record<RiskLevel, { maxNames: number; perNameWeight: number }> = {
  low: { maxNames: 6, perNameWeight: 0.14 },
  balanced: { maxNames: 7, perNameWeight: 0.18 },
  high: { maxNames: 8, perNameWeight: 0.22 },
};

/** Mean absolute daily return over the last `n` closes — an ATR% proxy. */
export function atrPctFrom(series: readonly number[], n = 14): number {
  if (series.length < 3) return 0;
  const start = Math.max(1, series.length - n);
  let sum = 0;
  let count = 0;
  for (let i = start; i < series.length; i++) {
    const prev = series[i - 1];
    if (!(prev > 0)) continue;
    sum += Math.abs(series[i] - prev) / prev;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

type PositionState = {
  openedBar: number;
  entryAtrPct: number;
  highWaterMark: number;
  scaleOutsTaken: number;
};

export type StyleRunMetrics = {
  style: TradingStyle;
  riskLevel: RiskLevel;
  horizon: string;
  bars: number;
  seed: number;
  startEquity: number;
  endEquity: number;
  totalReturnPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  annualisedVolPct: number;
  calmar: number;
  trades: number;
  buys: number;
  sells: number;
  winRatePct: number;
  /** Mean bars a closed position was held. */
  avgHoldBars: number;
  /** Round-trips per 252 bars — turnover intensity. */
  tradesPerYear: number;
  /** Total commission paid as a % of starting equity. */
  feeDragPct: number;
  finalCashPct: number;
  exitMix: Record<string, number>;
  /**
   * Equity curve for the run, one point per bar. Averaged cells hold the
   * per-bar mean across seeds so charts line up with the metric table.
   */
  equityCurve: EquityPoint[];
  /** Executed fills, one row per filled order, for chart overlays. */
  tradeLog: StyleTradeRow[];
};

/** Minimal fill record used to overlay buy/sell markers on report charts. */
export type StyleTradeRow = {
  date: string;
  side: "buy" | "sell";
  symbol: string;
  quantity: number;
  price: number;
};


export type StyleBacktestOptions = {
  universe?: AssetSpec[];
  horizons?: Array<{ label: string; bars: number }>;
  riskLevels?: RiskLevel[];
  seeds?: number[];
  startingCash?: number;
  feePerTrade?: number;
  /** Decision layer per style. Defaults to the heuristic rule set. */
  policyFor?: (style: TradingStyle) => StylePolicy;
};

/**
 * Default decision layer: the deterministic heuristic rule set the engine
 * falls back to when the AI is unavailable. Consulted every bar.
 */
export const heuristicStylePolicy: StylePolicy = {
  name: "heuristic",
  cadenceBars: 1,
  decide: async (ctx) => {
    const feats = ctx.candidates.map((c) => c.feature);
    const holdings = ctx.holdings.map((h) => ({ symbol: h.symbol, quantity: h.quantity }));
    const orders: PolicyOrder[] = [];
    for (const s of buildHeuristicSells(holdings, feats)) {
      const h = ctx.holdings.find((x) => x.symbol === s.symbol);
      if (!h || !(h.quantity > 0) || !(s.quantity > 0)) continue;
      orders.push({
        symbol: s.symbol,
        side: "sell",
        weight: Math.min(1, s.quantity / h.quantity),
        reason: s.reason,
      });
    }
    for (const b of buildHeuristicBuys(holdings, feats, {
      cashValue: ctx.cash,
      riskLevel: ctx.riskLevel,
    })) {
      orders.push({
        symbol: b.symbol,
        side: "buy",
        // Sizing is owned by the harness sleeve, not the heuristic percent.
        weight: ctx.perNameWeight,
        reason: b.reason,
      });
    }
    return orders;
  },
};

/** Run one (config × tape) cell and score it. */
export async function runStyleBacktest(args: {
  cfg: RiskConfig;
  bars: BacktestBar[];
  riskLevel: RiskLevel;
  startingCash: number;
  feePerTrade: number;
  /** Decision layer. Defaults to the deterministic heuristic rule set. */
  policy?: StylePolicy;
  /**
   * Optional execution-realism knobs (commission bps, stamp duty, slippage,
   * per-unit impact) forwarded to the broker simulator. Omitted → the tape
   * is traded at the close with only `feePerTrade`.
   */
  simulator?: SimulateOptions;
  /**
   * Override the per-risk-level entry sleeve (ticket size + breadth). Used by
   * the cost sweep to test whether bigger tickets amortise fixed commissions.
   */
  sleeve?: { maxNames: number; perNameWeight: number };
}): Promise<Omit<StyleRunMetrics, "style" | "horizon" | "seed">> {
  const { cfg, bars, riskLevel, startingCash, feePerTrade } = args;
  const policy = args.policy ?? heuristicStylePolicy;

  const positions = new Map<string, PositionState>();
  const lockedUntilBar = new Map<string, number>();
  const holdBarsClosed: number[] = [];
  const exitMix: Record<string, number> = {};
  const minHold = minHoldDays(cfg);
  let buys = 0;
  let sells = 0;

  const noteExit = (kind: string) => {
    exitMix[kind] = (exitMix[kind] ?? 0) + 1;
  };

  const result = await runBacktest(
    { cash: startingCash, holdings: [] },
    bars,
    async ({ state, closes, history, barIndex, date }) => {
      if (barIndex < 31) return [];
      const decisions: SimDecision[] = [];
      const exiting = new Set<string>();
      const feats = featuresFrom(history);

      // ---------------------------------------------------- risk exits
      for (const h of state.holdings) {
        if (!(h.quantity > 0)) continue;
        const price = closes[h.symbol];
        if (!(price > 0)) continue;
        const series = history[h.symbol] ?? [];
        const atrPct = atrPctFrom(series);
        const pos = positions.get(h.symbol) ?? {
          openedBar: barIndex,
          entryAtrPct: atrPct,
          highWaterMark: price,
          scaleOutsTaken: 0,
        };
        pos.highWaterMark = Math.max(pos.highWaterMark, price);
        positions.set(h.symbol, pos);

        const held = barIndex - pos.openedBar;
        const pnlPct = (price - h.avgCost) / h.avgCost;

        const sell = (qty: number, kind: string, lockout: boolean) => {
          const q = Math.min(h.quantity, Math.floor(qty));
          if (q < 1) return false;
          decisions.push({
            id: `${barIndex}-x-${kind}-${h.symbol}`,
            symbol: h.symbol,
            side: "SELL",
            quantity: q,
            price,
          });
          sells++;
          noteExit(kind);
          if (q >= h.quantity) {
            exiting.add(h.symbol);
            holdBarsClosed.push(held);
            positions.delete(h.symbol);
            if (lockout) {
              const days = reentryLockoutDays({
                atrPct,
                baseCooldownDays: cfg.reentry_min_days,
                atrDaysMult: cfg.reentry_atr_days_mult,
                minDays: cfg.reentry_min_days,
                maxDays: cfg.reentry_max_days,
              });
              lockedUntilBar.set(h.symbol, barIndex + days);
            }
          }
          return true;
        };

        // 1. Hard stop (ATR-scaled, never wider than the fixed stop).
        const stop = atrScaledStopPct({
          fixedStopPct: cfg.stop_loss_pct,
          atrPct,
          atrMult: cfg.initial_stop_atr_mult,
          floorPct: cfg.atr_scaled_stop_floor_pct,
          enabled: cfg.atr_scaled_stop_enabled,
        });
        if (stop.effectiveStopPct > 0 && pnlPct <= -stop.effectiveStopPct) {
          if (sell(h.quantity, "stop", true)) continue;
        }

        // 2. Take-profit.
        if (cfg.take_profit_pct > 0 && pnlPct >= cfg.take_profit_pct) {
          if (sell(h.quantity, "take_profit", false)) continue;
        }

        // 3. Chandelier trailing stop.
        if (cfg.chandelier_enabled && atrPct > 0) {
          const ch = evaluateChandelier({
            avgCost: h.avgCost,
            price,
            highWaterMark: pos.highWaterMark,
            atrPct,
            initialStopAtrMult: cfg.initial_stop_atr_mult,
            kBase: cfg.chandelier_k_base,
            kTight: cfg.chandelier_k_tight,
            tightenAfterR: cfg.chandelier_tighten_after_r,
          });
          if (ch.breached) {
            if (sell(h.quantity, "trail", true)) continue;
          }
        }

        // 4. Conditional time stop (no progress within the horizon).
        if (cfg.time_stop_enabled) {
          const ts = evaluateTimeStop({
            avgCost: h.avgCost,
            price,
            atrPct: pos.entryAtrPct || atrPct,
            initialStopAtrMult: cfg.initial_stop_atr_mult,
            openedAtMs: pos.openedBar * 86_400_000,
            nowMs: barIndex * 86_400_000,
            horizonDays: cfg.time_stop_horizon_days,
            minProgressR: cfg.time_stop_min_progress_r,
          });
          if (ts.triggered) {
            if (sell(h.quantity, "time_stop", true)) continue;
          }
        }

        // 5. Hard max-hold cap.
        if (cfg.max_hold_days > 0 && held >= cfg.max_hold_days) {
          if (sell(h.quantity, "max_hold", true)) continue;
        }

        // 6. R-multiple scale-out (partial).
        if (cfg.scale_out_enabled && atrPct > 0) {
          const so = evaluateScaleOut({
            avgCost: h.avgCost,
            price,
            atrPct: pos.entryAtrPct || atrPct,
            initialStopAtrMult: cfg.initial_stop_atr_mult,
            levels: cfg.scale_out_levels.map((l) => ({
              rMultiple: l.r,
              fractionOfPosition: l.frac,
            })),
            levelsAlreadyTaken: pos.scaleOutsTaken,
          });
          if (so.fire) {
            const qty = Math.floor(h.quantity * so.sellFraction);
            if (qty >= 1) {
              pos.scaleOutsTaken += 1;
              sell(qty, "scale_out", false);
            }
          }
        }
      }

      // ------------------------------------------- discretionary decisions
      // Either the deterministic heuristic rule layer (default) or the real
      // AI decision policy. Everything above this line — the mechanical risk
      // engine — is identical either way, so the arms stay comparable.
      const holdingsValue = state.holdings.reduce(
        (sum, h) => sum + h.quantity * (closes[h.symbol] || h.avgCost),
        0,
      );
      const equityNow = state.cash + holdingsValue;
      const sleeve = args.sleeve ?? ENTRY_SLEEVE[riskLevel];
      const cashFloor = equityNow * (cfg.cash_floor_pct ?? 0.05);
      let cashAvail = Math.max(0, state.cash - cashFloor);

      const dueForDecision = barIndex % Math.max(1, policy.cadenceBars) === 0;
      const orders: PolicyOrder[] = dueForDecision
        ? await policy.decide({
            barIndex,
            date,
            cfg,
            riskLevel,
            cash: state.cash,
            equity: equityNow,
            holdings: state.holdings
              .filter((h) => h.quantity > 0 && !exiting.has(h.symbol))
              .map((h) => ({
                symbol: h.symbol,
                quantity: h.quantity,
                avgCost: h.avgCost,
                price: closes[h.symbol] || h.avgCost,
                heldBars: barIndex - (positions.get(h.symbol)?.openedBar ?? barIndex),
              })),
            candidates: Object.entries(closes)
              .filter(([, price]) => price > 0)
              .map(([symbol, price]) => ({
                symbol,
                price,
                feature: feats.find((f) => f.symbol === symbol) ?? {
                  symbol,
                  rsi14: null,
                  change5d: null,
                  change30d: null,
                  macd_hist: null,
                },
                atrPct: atrPctFrom(history[symbol] ?? []),
                locked: (lockedUntilBar.get(symbol) ?? -1) > barIndex,
              })),
            maxNames: sleeve.maxNames,
            perNameWeight: sleeve.perNameWeight,
          })
        : [];

      // ------------------------------------------------ discretionary exits
      for (const s of orders.filter((o) => o.side === "sell")) {
        const h = state.holdings.find((x) => x.symbol === s.symbol);
        if (!h || !(h.quantity > 0) || exiting.has(s.symbol)) continue;
        const pos = positions.get(s.symbol);
        // Swing churn guard: no discretionary exit inside the min-hold window.
        if (pos && minHold > 0 && barIndex - pos.openedBar < minHold) continue;
        const price = closes[s.symbol];
        if (!(price > 0)) continue;
        const qty = Math.min(h.quantity, Math.max(1, Math.floor(h.quantity * s.weight)));
        decisions.push({
          id: `${barIndex}-d-${s.symbol}`,
          symbol: s.symbol,
          side: "SELL",
          quantity: qty,
          price,
        });
        sells++;
        noteExit("discretionary");
        if (qty >= h.quantity) {
          exiting.add(s.symbol);
          holdBarsClosed.push(pos ? barIndex - pos.openedBar : 0);
          positions.delete(s.symbol);
        }
      }

      // ------------------------------------------------------------ entries
      const heldAfter = new Set(
        state.holdings
          .filter((h) => h.quantity > 0 && !exiting.has(h.symbol))
          .map((h) => h.symbol),
      );

      for (const b of orders.filter((o) => o.side === "buy")) {
        if (heldAfter.size >= sleeve.maxNames) break;
        if (heldAfter.has(b.symbol)) continue;
        const lock = lockedUntilBar.get(b.symbol);
        if (lock != null && barIndex < lock) continue;
        const price = closes[b.symbol];
        if (!(price > 0)) continue;

        // Volatility sizing: shrink the ticket when daily ATR exceeds target.
        const atrPct = atrPctFrom(history[b.symbol] ?? []);
        const volScale =
          cfg.volatility_sizing && atrPct > 0
            ? Math.max(0.35, Math.min(1, cfg.vol_target_pct / atrPct))
            : 1;
        // The policy's requested weight is honoured but never above the sleeve
        // cap, so neither arm can win by simply betting bigger.
        const weight = Math.min(b.weight, sleeve.perNameWeight);
        const budget = Math.min(cashAvail, equityNow * weight * volScale);
        const qty = Math.floor(budget / price);
        if (qty < 1) continue;
        cashAvail -= qty * price;
        heldAfter.add(b.symbol);

        decisions.push({
          id: `${barIndex}-b-${b.symbol}`,
          symbol: b.symbol,
          side: "BUY",
          quantity: qty,
          price,
        });
        buys++;
        positions.set(b.symbol, {
          openedBar: barIndex,
          entryAtrPct: atrPct,
          highWaterMark: price,
          scaleOutsTaken: 0,
        });
      }


      return decisions;
    },
    { defaultFee: feePerTrade, ...(args.simulator ? { simulator: args.simulator } : {}) },
  );

  const equity: EquityPoint[] = result.equityCurve.map((p) => ({
    snapshot_date: p.date,
    total_value: p.totalValue,
  }));
  const endEquity = equity.at(-1)?.total_value ?? startingCash;
  const rets = dailyReturns(equity);
  const dd = computeMaxDrawdown(equity);
  const years = bars.length / 252;
  const cagr = years > 0 ? (endEquity / startingCash) ** (1 / years) - 1 : 0;
  const ddAbs = Math.abs(dd.pct);
  const sellSnaps = result.snapshots.filter((s) => s.side === "SELL");
  const wins = sellSnaps.filter((s) => s.realizedPnl > 0).length;

  return {
    riskLevel,
    bars: bars.length,
    startEquity: startingCash,
    endEquity,
    totalReturnPct: (endEquity / startingCash - 1) * 100,
    cagrPct: cagr * 100,
    maxDrawdownPct: dd.pct,
    sharpe: computeSharpe(rets),
    annualisedVolPct: computeAnnualisedVolPct(rets),
    calmar: ddAbs > 1e-9 ? (cagr * 100) / ddAbs : 0,
    trades: buys + sells,
    buys,
    sells,
    winRatePct: sellSnaps.length > 0 ? (wins / sellSnaps.length) * 100 : 0,
    avgHoldBars:
      holdBarsClosed.length > 0
        ? holdBarsClosed.reduce((a, b) => a + b, 0) / holdBarsClosed.length
        : 0,
    tradesPerYear: years > 0 ? (buys + sells) / years : 0,
    feeDragPct: (result.snapshots.reduce((sum, s) => sum + (s.fee || 0), 0) / startingCash) * 100,
    finalCashPct: endEquity > 0 ? (result.finalState.cash / endEquity) * 100 : 0,
    exitMix,
    equityCurve: equity,
    tradeLog: result.snapshots
      .filter((s) => s.fillQuantity > 0)
      .map((s) => ({
        date: s.date,
        side: s.side === "BUY" ? ("buy" as const) : ("sell" as const),
        symbol: s.symbol,
        quantity: s.fillQuantity,
        price: s.fillPrice,
      })),
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Mean equity curve across seeds, bar-by-bar. Curves are truncated to the
 * shortest run so every averaged point has the same sample size; dates come
 * from the first run since all seeds share the synthetic calendar.
 */
export function averageEquityCurves(curves: readonly EquityPoint[][]): EquityPoint[] {
  const usable = curves.filter((c) => c.length > 0);
  if (usable.length === 0) return [];
  const n = Math.min(...usable.map((c) => c.length));
  const out: EquityPoint[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      snapshot_date: usable[0]![i]!.snapshot_date,
      total_value: mean(usable.map((c) => c[i]!.total_value)),
    });
  }
  return out;
}

export function averageStyleRuns(runs: StyleRunMetrics[]): StyleRunMetrics {
  const pick = (f: (m: StyleRunMetrics) => number) => mean(runs.map(f));
  const exitMix: Record<string, number> = {};
  for (const r of runs) {
    for (const [k, v] of Object.entries(r.exitMix)) exitMix[k] = (exitMix[k] ?? 0) + v / runs.length;
  }
  return {
    ...runs[0],
    seed: -1,
    endEquity: pick((m) => m.endEquity),
    totalReturnPct: pick((m) => m.totalReturnPct),
    cagrPct: pick((m) => m.cagrPct),
    maxDrawdownPct: pick((m) => m.maxDrawdownPct),
    sharpe: pick((m) => m.sharpe),
    annualisedVolPct: pick((m) => m.annualisedVolPct),
    calmar: pick((m) => m.calmar),
    trades: pick((m) => m.trades),
    buys: pick((m) => m.buys),
    sells: pick((m) => m.sells),
    winRatePct: pick((m) => m.winRatePct),
    avgHoldBars: pick((m) => m.avgHoldBars),
    tradesPerYear: pick((m) => m.tradesPerYear),
    feeDragPct: pick((m) => m.feeDragPct),
    finalCashPct: pick((m) => m.finalCashPct),
    exitMix,
    equityCurve: averageEquityCurves(runs.map((r) => r.equityCurve)),
    // Averaged cells show the first seed's fills — markers must line up with
    // real bar dates, and averaging trade timing across seeds is meaningless.
    tradeLog: runs[0]?.tradeLog ?? [],
  };
}

export type StyleComparison = {
  perSeed: StyleRunMetrics[];
  averaged: StyleRunMetrics[];
  seeds: number[];
  horizons: Array<{ label: string; bars: number }>;
  riskLevels: RiskLevel[];
};

/**
 * Run both styles across every (risk level × horizon × seed) cell.
 * `configFor` is injected so the caller owns the (server-only) config parse.
 */
export async function compareTradingStyles(
  configFor: (style: TradingStyle) => RiskConfig,
  options: StyleBacktestOptions = {},
): Promise<StyleComparison> {
  const universe = options.universe ?? DEFAULT_UNIVERSE;
  const horizons = options.horizons ?? STYLE_HORIZONS;
  const riskLevels = options.riskLevels ?? (["low", "balanced", "high"] as RiskLevel[]);
  const seeds = options.seeds ?? STYLE_SEEDS;
  const startingCash = options.startingCash ?? 10_300;
  const feePerTrade = options.feePerTrade ?? 3;
  const styles: TradingStyle[] = ["position", "swing"];
  const cfgs = { position: configFor("position"), swing: configFor("swing") };

  const perSeed: StyleRunMetrics[] = [];
  const maxBars = Math.max(...horizons.map((h) => h.bars));

  for (const seed of seeds) {
    const fullTape = buildPriceTape(universe, maxBars, seed);
    for (const h of horizons) {
      const tape = fullTape.slice(0, h.bars);
      for (const riskLevel of riskLevels) {
        for (const style of styles) {
          const m = await runStyleBacktest({
            cfg: cfgs[style],
            ...(options.policyFor ? { policy: options.policyFor(style) } : {}),
            bars: tape,
            riskLevel,
            startingCash,
            feePerTrade,
          });
          perSeed.push({ ...m, style, horizon: h.label, seed });
        }
      }
    }
  }

  const averaged: StyleRunMetrics[] = [];
  for (const h of horizons) {
    for (const riskLevel of riskLevels) {
      for (const style of styles) {
        const cell = perSeed.filter(
          (m) => m.horizon === h.label && m.riskLevel === riskLevel && m.style === style,
        );
        if (cell.length) averaged.push(averageStyleRuns(cell));
      }
    }
  }

  return { perSeed, averaged, seeds, horizons, riskLevels };
}
