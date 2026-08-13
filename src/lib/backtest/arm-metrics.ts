import type { ArmResult } from "@/lib/backtest/insider-nudge-replay";

export type ArmHeadlineMetrics = {
  label: string;
  /** Calendar years covered by the curve. */
  years: number;
  /** Compound annual growth rate, %. Falls back to total return under a year. */
  cagrPct: number | null;
  totalReturnPct: number;
  maxDrawdownPct: number;
  volAnnPct: number;
  sharpe: number;
  /** Share of closed positions that made money, %. Null when nothing closed. */
  winRatePct: number | null;
  wins: number;
  losses: number;
  /** True when the win rate came from daily equity moves, not closed trades. */
  winRateFromDays: boolean;
  avgWinPct: number | null;
  avgLossPct: number | null;
  /** Gross wins / gross losses on closed positions. */
  profitFactor: number | null;
  /** Closed positions in the arm (0 when the engine tracks no episodes). */
  closedTrades: number;
  /** Positions still open at the end of the tape. */
  openTrades: number;
  /** Mean calendar days held per closed position. */
  avgHoldDays: number | null;
  /** Median calendar days held — resistant to one very long hold. */
  medianHoldDays: number | null;
  /** Longest single hold, in days. */
  maxHoldDays: number | null;
  /** Longest run of consecutive losing closes, ordered by exit date. */
  maxConsecutiveLosses: number | null;
  /** Longest run of consecutive winning closes. */
  maxConsecutiveWins: number | null;
  /** Mean contribution per closed position, % — win rate and size combined. */
  expectancyPct: number | null;
};


const MS_YEAR = 365.25 * 24 * 3600 * 1000;

function spanYears(from?: string, to?: string): number {
  if (!from || !to) return 0;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return (b - a) / MS_YEAR;
}

/**
 * Headline stats for one backtest arm. CAGR and win rate are derived here
 * rather than in the engine so every replay card reports them the same way.
 */
export function armHeadlineMetrics(arm: ArmResult): ArmHeadlineMetrics {
  const curve = arm.curve ?? [];
  const years = spanYears(curve[0]?.date, curve[curve.length - 1]?.date);
  const growth = 1 + arm.totalReturnPct / 100;

  // Annualising a sub-year sample inflates it wildly; report the raw return.
  const cagrPct =
    years >= 1 && growth > 0 ? (Math.pow(growth, 1 / years) - 1) * 100 : years > 0 ? arm.totalReturnPct : null;

  const closed = (arm.episodes ?? []).filter((e) => !e.open);
  const winners = closed.filter((e) => e.contributionPct > 0);
  const losers = closed.filter((e) => e.contributionPct < 0);

  let wins = winners.length;
  let losses = losers.length;
  let winRateFromDays = false;
  let winRatePct: number | null = closed.length ? (wins / closed.length) * 100 : null;

  if (winRatePct == null && curve.length > 1) {
    // No episode tracking on this arm: fall back to up-days, and say so.
    let up = 0;
    let down = 0;
    for (let i = 1; i < curve.length; i += 1) {
      const d = curve[i]!.equity - curve[i - 1]!.equity;
      if (d > 0) up += 1;
      else if (d < 0) down += 1;
    }
    if (up + down > 0) {
      wins = up;
      losses = down;
      winRatePct = (up / (up + down)) * 100;
      winRateFromDays = true;
    }
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
  const grossWin = winners.reduce((s, e) => s + e.contributionPct, 0);
  const grossLoss = Math.abs(losers.reduce((s, e) => s + e.contributionPct, 0));

  return {
    label: arm.label,
    years,
    cagrPct,
    totalReturnPct: arm.totalReturnPct,
    maxDrawdownPct: arm.maxDrawdownPct,
    volAnnPct: arm.volAnnPct,
    sharpe: arm.sharpe,
    winRatePct,
    wins,
    losses,
    winRateFromDays,
    avgWinPct: winRateFromDays ? null : mean(winners.map((e) => e.contributionPct)),
    avgLossPct: winRateFromDays ? null : mean(losers.map((e) => e.contributionPct)),
    profitFactor: !winRateFromDays && grossLoss > 0 ? grossWin / grossLoss : null,
  };
}
