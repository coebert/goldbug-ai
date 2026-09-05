/**
 * This account's own risk profile, in plain numbers the decision model can act
 * on.
 *
 * The learned weights (`fit.ts`) tell the model HOW this book's signals have
 * paid; this tells it WHAT the book actually looks like and how it has
 * behaved: realised volatility and drawdown of the equity curve, what a
 * typical winning and losing ticket did, how long positions are held, how
 * concentrated the book is right now and what dealing has really cost.
 *
 * Pure functions so the same numbers can be unit-tested and reused off the
 * server (dataset builds, research pages) without touching the database.
 */

export type EquityPoint = { date: string; value: number };

export type ClosedTrade = {
  symbol: string;
  /** Realised P&L in base currency, net of nothing (costs are reported apart). */
  pnl: number;
  /** Realised return on the closed notional, as a fraction. */
  returnPct: number;
  /** Calendar days from first buy to the closing sell. */
  heldDays: number;
  /** Value of the closed leg, base currency. */
  notional: number;
  closedOn: string;
};

export type OpenPosition = {
  symbol: string;
  value: number;
  /** Unrealised P&L in base currency, null when no live price is known. */
  unrealised: number | null;
  unrealisedPct: number | null;
  heldDays: number | null;
};

export type BookRiskProfile = {
  /** Annualised standard deviation of daily equity returns, in percent. */
  volAnnualPct: number | null;
  /** Worst peak-to-trough on the equity curve, percent (negative). */
  maxDrawdownPct: number | null;
  /** Distance below the running peak right now, percent (<= 0). */
  currentDrawdownPct: number | null;
  worstDayPct: number | null;
  bestDayPct: number | null;
  days: number;
  /** Closed-trade statistics from this account's own fills. */
  trades: {
    n: number;
    winRate: number | null;
    avgWinPct: number | null;
    avgLossPct: number | null;
    /** Average win / average loss in percent terms; > 1 means winners pay. */
    payoff: number | null;
    avgHoldDays: number | null;
    /** Median ticket size as a share of current book value. */
    medianTicketPctOfNav: number | null;
    worst: { symbol: string; returnPct: number } | null;
  };
  /** Live exposure shape. */
  book: {
    positions: number;
    investedPct: number;
    cashPct: number;
    topWeightPct: number | null;
    topSymbol: string | null;
    /** Herfindahl of position weights over NAV — 1 means a single name. */
    concentration: number | null;
    unrealisedPct: number | null;
  };
  /** Realised dealing cost over the trailing window, in bps of NAV. */
  frictionBpsOfNav: number | null;
};

function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const varc = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(varc);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Daily returns, drawdown and volatility of the account's own equity curve. */
export function equityRisk(curve: EquityPoint[]): Pick<
  BookRiskProfile,
  "volAnnualPct" | "maxDrawdownPct" | "currentDrawdownPct" | "worstDayPct" | "bestDayPct" | "days"
> {
  const points = curve
    .filter((p) => Number.isFinite(p.value) && p.value > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const rets: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const r = points[i]!.value / points[i - 1]!.value - 1;
    // A cash deposit or withdrawal is a capital-base change, not a return; a
    // single-day move past 25% on this book is always one of those.
    if (Number.isFinite(r) && Math.abs(r) < 0.25) rets.push(r);
  }
  let peak = points[0]?.value ?? 0;
  let maxDd = 0;
  for (const p of points) {
    if (p.value > peak) peak = p.value;
    if (peak > 0) maxDd = Math.min(maxDd, p.value / peak - 1);
  }
  const last = points[points.length - 1]?.value ?? 0;
  const sd = stdev(rets);
  return {
    volAnnualPct: sd == null ? null : sd * Math.sqrt(252) * 100,
    maxDrawdownPct: points.length > 1 ? maxDd * 100 : null,
    currentDrawdownPct: peak > 0 && last > 0 ? Math.min(0, last / peak - 1) * 100 : null,
    worstDayPct: rets.length ? Math.min(...rets) * 100 : null,
    bestDayPct: rets.length ? Math.max(...rets) * 100 : null,
    days: points.length,
  };
}

/** Win rate, payoff and holding period from the account's own closed trades. */
export function tradeStats(trades: ClosedTrade[], nav: number): BookRiskProfile["trades"] {
  const n = trades.length;
  if (n === 0) {
    return {
      n: 0, winRate: null, avgWinPct: null, avgLossPct: null, payoff: null,
      avgHoldDays: null, medianTicketPctOfNav: null, worst: null,
    };
  }
  const wins = trades.filter((t) => t.returnPct > 0);
  const losses = trades.filter((t) => t.returnPct <= 0);
  const avg = (xs: ClosedTrade[]) =>
    xs.length ? (xs.reduce((a, b) => a + b.returnPct, 0) / xs.length) * 100 : null;
  const avgWin = avg(wins);
  const avgLoss = avg(losses);
  const worst = trades.reduce((a, b) => (b.returnPct < a.returnPct ? b : a));
  return {
    n,
    winRate: wins.length / n,
    avgWinPct: avgWin,
    avgLossPct: avgLoss,
    payoff: avgWin != null && avgLoss != null && avgLoss < 0 ? avgWin / Math.abs(avgLoss) : null,
    avgHoldDays: trades.reduce((a, b) => a + b.heldDays, 0) / n,
    medianTicketPctOfNav:
      nav > 0 ? ((median(trades.map((t) => t.notional)) ?? 0) / nav) * 100 : null,
    worst: { symbol: worst.symbol, returnPct: worst.returnPct * 100 },
  };
}

/** Concentration and unrealised P&L of the live book. */
export function exposureStats(
  positions: OpenPosition[],
  nav: number,
  cash: number,
): BookRiskProfile["book"] {
  const live = positions.filter((p) => Number.isFinite(p.value) && p.value > 0);
  const invested = live.reduce((a, b) => a + b.value, 0);
  const top = live.reduce<OpenPosition | null>((a, b) => (a == null || b.value > a.value ? b : a), null);
  const unreal = live.reduce((a, b) => a + (b.unrealised ?? 0), 0);
  return {
    positions: live.length,
    investedPct: nav > 0 ? (invested / nav) * 100 : 0,
    cashPct: nav > 0 ? (cash / nav) * 100 : 0,
    topWeightPct: top && nav > 0 ? (top.value / nav) * 100 : null,
    topSymbol: top?.symbol ?? null,
    concentration:
      nav > 0 && live.length > 0 ? live.reduce((a, b) => a + (b.value / nav) ** 2, 0) : null,
    unrealisedPct: nav > 0 && live.length > 0 ? (unreal / nav) * 100 : null,
  };
}

function pct(v: number | null | undefined, digits = 2): string {
  return v == null || !Number.isFinite(v) ? "n/a" : `${v.toFixed(digits)}%`;
}

/**
 * Prompt block. Deliberately concrete: every number comes from this account's
 * own fills and equity history, so the model sizes to the risk this book has
 * actually run rather than a generic prior.
 */
export function formatRiskProfileBlock(
  profile: BookRiskProfile,
  opts: { currency: string; windowDays: number; positions: OpenPosition[]; nav: number },
): string {
  const t = profile.trades;
  const b = profile.book;
  const nav = opts.nav > 0 ? opts.nav : 0;
  const holdings = opts.positions
    .filter((p) => p.value > 0)
    .sort((a, b2) => b2.value - a.value)
    .slice(0, 12)
    .map((p) => {
      const weight = nav > 0 ? pct((p.value / nav) * 100, 1) : "n/a";
      const unreal = p.unrealisedPct != null ? `${pct(p.unrealisedPct)} unrealised` : "unrealised n/a";
      const age = p.heldDays != null ? `${p.heldDays}d held` : "age n/a";
      return `  - ${p.symbol}: ${weight} of NAV, ${unreal}, ${age}, ${opts.currency} ${p.value.toFixed(0)}`;
    })
    .join("\n");


  return `THIS BOOK'S OWN RISK PROFILE (measured from your real fills, holdings and equity curve — not a generic prior):
- Equity curve, last ${profile.days} sessions: realised volatility ${pct(profile.volAnnualPct, 1)} annualised, max drawdown ${pct(profile.maxDrawdownPct)}, currently ${pct(profile.currentDrawdownPct)} below the peak. Worst day ${pct(profile.worstDayPct)}, best day ${pct(profile.bestDayPct)}.
- Closed trades in the last ${opts.windowDays} days: ${t.n}${
    t.n > 0
      ? ` — win rate ${t.winRate != null ? `${(t.winRate * 100).toFixed(0)}%` : "n/a"}, average winner ${pct(t.avgWinPct)}, average loser ${pct(t.avgLossPct)}, payoff ratio ${t.payoff != null ? t.payoff.toFixed(2) : "n/a"}, average hold ${t.avgHoldDays != null ? `${t.avgHoldDays.toFixed(1)}d` : "n/a"}, median ticket ${pct(t.medianTicketPctOfNav, 1)} of NAV. Worst single trade: ${t.worst ? `${t.worst.symbol} ${pct(t.worst.returnPct)}` : "n/a"}.`
      : " — no closed round trips yet, so treat sizing priors as untested."
  }
- Realised dealing cost over that window: ${profile.frictionBpsOfNav != null ? `${profile.frictionBpsOfNav.toFixed(1)}bps of NAV` : "not yet measured"}.
- Live book: ${b.positions} positions, ${pct(b.investedPct, 1)} invested / ${pct(b.cashPct, 1)} cash, largest name ${b.topSymbol ?? "n/a"} at ${pct(b.topWeightPct, 1)} of NAV, concentration index ${b.concentration != null ? b.concentration.toFixed(3) : "n/a"}, open unrealised ${pct(b.unrealisedPct)} of NAV.
${holdings ? `- Open positions (largest first):\n${holdings}` : "- Open positions: none."}

Use these numbers as the sizing and risk constraint, in this order:
1. Never let a new position push the concentration index or the largest weight above where this book has historically survived its drawdowns.
2. If the payoff ratio is below 1, the losers are bigger than the winners: cut size and demand stronger evidence rather than trading more often.
3. If realised dealing cost is a material share of the average winner, only trade when the expected move clearly clears it.
4. If the book is already in drawdown, prioritise reducing the largest loss-making weights over opening new risk.
State explicitly in your rationale which of these four constraints bound today's decision.`;
}
