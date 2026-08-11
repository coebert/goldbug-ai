// Per-risk-level roll-up of risk, drawdown and diversification.
//
// Pure module: takes portfolios (each with an equity history and a holdings
// book) and groups them by risk level so the dashboard can verify at a glance
// that low / balanced / high behave differently — more risk should mean more
// volatility and deeper drawdowns, not identical numbers.
//
// Two things have to happen before any group total is meaningful:
//
//   1. FX. Portfolios are booked in their own currency (EUR sims alongside
//      GBP live books). Summing them raw and stamping "£" on the result is
//      simply a wrong number, and it also distorts which group looks larger.
//      Every portfolio therefore carries an `fxRate` multiplier into the
//      panel's display currency, applied to equity, cash and holdings.
//   2. External flows. Deposits, withdrawals and broker cash re-syncs move
//      the capital base without any trading happening. Left in, a mid-window
//      cash correction reads as a ~-46% "drawdown" and pushes annualised
//      volatility into the hundreds of percent. Each portfolio's curve is
//      restated onto its current capital base first, so the risk stats
//      describe trading only.

import {
  computeMaxDrawdown,
  computeSharpe,
  computeAnnualisedVolPct,
  dailyReturns,
  type EquityPoint,
} from "@/lib/backtest-metrics";
import {
  detectExternalFlows,
  flowAdjustedSeries,
  mergeFlows,
  type EquityPoint as FlowEquityPoint,
  type ExternalFlow,
} from "@/lib/equity-external-flows";

export type RiskLevelKey = "low" | "balanced" | "high" | "unknown";

export const RISK_LEVEL_ORDER: RiskLevelKey[] = ["low", "balanced", "high", "unknown"];

export type RiskPanelHolding = {
  symbol: string;
  quantity: number;
  /** Per-unit value used for weighting (market price, or avg cost as proxy). */
  price: number;
};

/**
 * A snapshot. `cash` / `holdingsValue` are optional but required for external
 * flow detection — without the split we cannot tell a deposit from a rally.
 */
export type RiskPanelEquityPoint = EquityPoint & {
  cash?: number;
  holdingsValue?: number;
};

export type RiskPanelPortfolio = {
  id: string;
  name: string;
  mode: string | null;
  riskLevel: string | null;
  currency: string | null;
  cash: number;
  holdings: RiskPanelHolding[];
  /** Chronological equity history (oldest → newest), in `currency`. */
  equity: RiskPanelEquityPoint[];
  /**
   * Multiplier from `currency` into the panel's display currency. Defaults to
   * 1 (same currency). `null` means the rate could not be resolved — the
   * portfolio is still counted but the group is flagged as not comparable.
   */
  fxRate?: number | null;
  /** Known deposits/withdrawals, in `currency`, if the caller has them. */
  recordedFlows?: ExternalFlow[];
};

export type RiskLevelMetrics = {
  riskLevel: RiskLevelKey;
  portfolioCount: number;
  portfolioNames: string[];
  /** Σ equity across the group's portfolios (latest snapshot each). */
  totalEquity: number;
  /** Equity-weighted period return, %. */
  returnPct: number;
  /** Worst peak→trough on the group's aggregated equity curve, %. Negative. */
  maxDrawdownPct: number;
  drawdownPeakDate: string | null;
  drawdownTroughDate: string | null;
  sharpe: number;
  annualisedVolPct: number;
  /** Distinct symbols held across the group. */
  positions: number;
  /** Herfindahl–Hirschman index of position weights, 0–1 (1 = single name). */
  concentrationHhi: number;
  /** Weight of the single largest position, % of invested capital. */
  topWeightPct: number;
  topSymbol: string | null;
  /** Effective number of independent bets = 1 / HHI. */
  effectiveNames: number;
  /** Cash as % of total equity. */
  cashPct: number;
  /** Invested capital as % of total equity. */
  investedPct: number;
  /** Data points behind the risk stats — fewer than ~5 means "not yet meaningful". */
  observations: number;
  /** Deposit/withdrawal steps netted out of the risk stats. */
  flowEvents: number;
  /** Net external flow over the window, display currency. */
  netExternalFlow: number;
  /** Distinct booking currencies rolled into this group. */
  currencies: string[];
  /** False when some portfolio's FX rate was unavailable — totals unreliable. */
  fxComplete: boolean;
};

export function normaliseRiskLevel(value: string | null | undefined): RiskLevelKey {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "low" || v === "conservative" || v === "cautious") return "low";
  if (v === "balanced" || v === "medium" || v === "moderate") return "balanced";
  if (v === "high" || v === "aggressive") return "high";
  return "unknown";
}

/**
 * Restates one portfolio into the display currency with external flows netted
 * out. Everything downstream (aggregation, weights, cash share) consumes the
 * normalised form, so no call site can accidentally mix bases again.
 */
export function normalisePortfolio(p: RiskPanelPortfolio): {
  portfolio: RiskPanelPortfolio;
  flowEvents: number;
  netFlow: number;
  fxKnown: boolean;
} {
  const fxKnown = p.fxRate == null ? (p.currency ?? "") === "" || p.fxRate === undefined : true;
  const rate = typeof p.fxRate === "number" && p.fxRate > 0 ? p.fxRate : 1;

  const hasSplit = p.equity.some(
    (e) => typeof e.cash === "number" && typeof e.holdingsValue === "number",
  );
  let flows: ExternalFlow[] = p.recordedFlows ?? [];
  if (hasSplit) {
    const flowPoints: FlowEquityPoint[] = p.equity.map((e) => ({
      date: e.snapshot_date,
      totalValue: Number(e.total_value) || 0,
      cash: Number(e.cash) || 0,
      holdingsValue: Number(e.holdingsValue) || 0,
    }));
    flows = mergeFlows(p.recordedFlows ?? [], detectExternalFlows(flowPoints));
  }

  const adjusted = flows.length
    ? flowAdjustedSeries(
        p.equity.map((e) => ({
          date: e.snapshot_date,
          totalValue: Number(e.total_value) || 0,
          cash: Number(e.cash) || 0,
          holdingsValue: Number(e.holdingsValue) || 0,
        })),
        flows,
      )
    : null;

  const equity: RiskPanelEquityPoint[] = adjusted
    ? adjusted.map((r) => ({ snapshot_date: r.date, total_value: r.adjusted * rate }))
    : p.equity.map((e) => ({
        snapshot_date: e.snapshot_date,
        total_value: (Number(e.total_value) || 0) * rate,
      }));

  return {
    portfolio: {
      ...p,
      cash: (Number(p.cash) || 0) * rate,
      holdings: p.holdings.map((h) => ({ ...h, price: (Number(h.price) || 0) * rate })),
      equity,
      fxRate: 1,
      recordedFlows: [],
    },
    flowEvents: flows.length,
    netFlow: flows.reduce((s, f) => s + f.amount, 0) * rate,
    fxKnown: p.fxRate !== null,
  };
}


/** Sum equity curves across portfolios onto a shared, sorted date axis. */
export function aggregateEquity(portfolios: RiskPanelPortfolio[]): EquityPoint[] {
  const dates = new Set<string>();
  for (const p of portfolios) for (const e of p.equity) dates.add(e.snapshot_date);
  const sorted = [...dates].sort();
  if (sorted.length === 0) return [];

  // Forward-fill each portfolio so a missing snapshot doesn't fake a crash.
  const cursors = portfolios.map((p) => ({
    points: [...p.equity].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date)),
    idx: 0,
    last: 0,
    started: false,
  }));

  const out: EquityPoint[] = [];
  for (const date of sorted) {
    let total = 0;
    for (const c of cursors) {
      while (c.idx < c.points.length && c.points[c.idx].snapshot_date <= date) {
        c.last = Number(c.points[c.idx].total_value) || 0;
        c.started = true;
        c.idx++;
      }
      if (c.started) total += c.last;
    }
    out.push({ snapshot_date: date, total_value: total });
  }
  return out;
}

function weightsFrom(portfolios: RiskPanelPortfolio[]): {
  bySymbol: Map<string, number>;
  invested: number;
} {
  const bySymbol = new Map<string, number>();
  let invested = 0;
  for (const p of portfolios) {
    for (const h of p.holdings) {
      const qty = Number(h.quantity) || 0;
      const px = Number(h.price) || 0;
      const value = qty * px;
      if (!(value > 0)) continue;
      bySymbol.set(h.symbol, (bySymbol.get(h.symbol) ?? 0) + value);
      invested += value;
    }
  }
  return { bySymbol, invested };
}

/** Metrics for one risk-level group. */
export function computeRiskLevelMetrics(
  riskLevel: RiskLevelKey,
  portfolios: RiskPanelPortfolio[],
): RiskLevelMetrics {
  const curve = aggregateEquity(portfolios);
  const rets = dailyReturns(curve);
  const dd = computeMaxDrawdown(curve);
  const first = curve[0]?.total_value ?? 0;
  const last = curve.at(-1)?.total_value ?? 0;

  const { bySymbol, invested } = weightsFrom(portfolios);
  const cash = portfolios.reduce((sum, p) => sum + (Number(p.cash) || 0), 0);
  const totalEquity = last > 0 ? last : cash + invested;

  let hhi = 0;
  let topWeight = 0;
  let topSymbol: string | null = null;
  if (invested > 0) {
    for (const [symbol, value] of bySymbol) {
      const w = value / invested;
      hhi += w * w;
      if (w > topWeight) {
        topWeight = w;
        topSymbol = symbol;
      }
    }
  }

  return {
    riskLevel,
    portfolioCount: portfolios.length,
    portfolioNames: portfolios.map((p) => p.name),
    totalEquity,
    returnPct: first > 0 ? (last / first - 1) * 100 : 0,
    maxDrawdownPct: dd.pct,
    drawdownPeakDate: dd.peakDate,
    drawdownTroughDate: dd.troughDate,
    sharpe: computeSharpe(rets),
    annualisedVolPct: computeAnnualisedVolPct(rets),
    positions: bySymbol.size,
    concentrationHhi: hhi,
    topWeightPct: topWeight * 100,
    topSymbol,
    effectiveNames: hhi > 0 ? 1 / hhi : 0,
    cashPct: totalEquity > 0 ? (cash / totalEquity) * 100 : 0,
    investedPct: totalEquity > 0 ? (invested / totalEquity) * 100 : 0,
    observations: curve.length,
  };
}

/** Group portfolios by risk level and score each group. */
export function computeRiskLevelPanel(
  portfolios: RiskPanelPortfolio[],
): RiskLevelMetrics[] {
  const groups = new Map<RiskLevelKey, RiskPanelPortfolio[]>();
  for (const p of portfolios) {
    const key = normaliseRiskLevel(p.riskLevel);
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  return RISK_LEVEL_ORDER.filter((k) => groups.has(k)).map((k) =>
    computeRiskLevelMetrics(k, groups.get(k) as RiskPanelPortfolio[]),
  );
}

export type RiskLadderWarning = {
  kind: "drawdown-inversion" | "vol-inversion" | "identical-metrics" | "thin-diversification";
  message: string;
};

/**
 * Sanity checks over the ladder — surfaced in the panel so an operator can
 * verify at a glance that the risk levels are actually behaving differently.
 */
export function checkRiskLadder(rows: RiskLevelMetrics[]): RiskLadderWarning[] {
  const warnings: RiskLadderWarning[] = [];
  const by = new Map(rows.map((r) => [r.riskLevel, r] as const));
  // Compare each adjacent rung; if a rung is missing, compare across the gap
  // so a low/high-only setup is still verified.
  const ladder: RiskLevelKey[] = (["low", "balanced", "high"] as RiskLevelKey[]).filter((k) =>
    by.has(k),
  );
  const pairs: Array<[RiskLevelKey, RiskLevelKey]> = [];
  for (let i = 0; i < ladder.length - 1; i++) pairs.push([ladder[i], ladder[i + 1]]);

  for (const [lower, upper] of pairs) {
    const a = by.get(lower);
    const b = by.get(upper);
    if (!a || !b) continue;
    if (a.observations < 3 || b.observations < 3) continue;

    if (Math.abs(a.maxDrawdownPct) > Math.abs(b.maxDrawdownPct) + 0.01) {
      warnings.push({
        kind: "drawdown-inversion",
        message: `${lower} risk has a deeper drawdown (${a.maxDrawdownPct.toFixed(2)}%) than ${upper} risk (${b.maxDrawdownPct.toFixed(2)}%).`,
      });
    }
    if (a.annualisedVolPct > b.annualisedVolPct + 0.01) {
      warnings.push({
        kind: "vol-inversion",
        message: `${lower} risk is more volatile (${a.annualisedVolPct.toFixed(2)}%) than ${upper} risk (${b.annualisedVolPct.toFixed(2)}%).`,
      });
    }
    const sameEquity = Math.abs(a.totalEquity - b.totalEquity) < 0.01;
    const sameDd = Math.abs(a.maxDrawdownPct - b.maxDrawdownPct) < 1e-6;
    const samePositions = a.positions === b.positions && a.topSymbol === b.topSymbol;
    if (sameEquity && sameDd && samePositions && a.positions > 0) {
      warnings.push({
        kind: "identical-metrics",
        message: `${lower} and ${upper} risk show identical equity, drawdown and holdings — check broker account linking.`,
      });
    }
  }

  for (const r of rows) {
    if (r.positions > 0 && r.topWeightPct >= 60) {
      warnings.push({
        kind: "thin-diversification",
        message: `${r.riskLevel} risk is ${r.topWeightPct.toFixed(0)}% concentrated in ${r.topSymbol}.`,
      });
    }
  }

  return warnings;
}
