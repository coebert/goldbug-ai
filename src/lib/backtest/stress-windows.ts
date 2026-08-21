// Named high-volatility / event-heavy windows for stress backtests.
//
// Each window is a period where the tape did something violent: a crash, a
// vol shock, a policy or geopolitical event. Running the governor + FX replay
// over these — rather than only over calm years — is what tells us whether the
// revised friction budget and FX leg still admit profitable trades when it
// matters, and whether they do so without a worse drawdown.
//
// Pure data + pure helpers: no I/O.

export type StressWindow = {
  id: string;
  label: string;
  /** First trading day of the stressed period (inclusive). */
  from: string;
  /** Last trading day of the stressed period (inclusive). */
  to: string;
  /** What actually happened, for the report. */
  note: string;
};

export const STRESS_WINDOWS: StressWindow[] = [
  {
    id: "gfc",
    label: "GFC crash",
    from: "2008-09-01",
    to: "2009-06-30",
    note: "Lehman, forced deleveraging, 55% peak-to-trough on the S&P",
  },
  {
    id: "euro-crisis",
    label: "Euro crisis / US downgrade",
    from: "2011-07-01",
    to: "2011-12-31",
    note: "S&P downgrade of the US, peripheral spreads, VIX to 48",
  },
  {
    id: "china-deval",
    label: "China devaluation",
    from: "2015-08-01",
    to: "2016-03-31",
    note: "Aug 2015 flash break, then the Jan 2016 growth scare",
  },
  {
    id: "volmageddon",
    label: "Volmageddon",
    from: "2018-01-15",
    to: "2018-04-30",
    note: "short-vol unwind, one-day VIX double",
  },
  {
    id: "q4-2018",
    label: "Q4 2018 selloff",
    from: "2018-10-01",
    to: "2019-01-31",
    note: "hiking cycle repricing into an illiquid December",
  },
  {
    id: "covid",
    label: "COVID crash + rebound",
    from: "2020-02-01",
    to: "2020-08-31",
    note: "fastest 30% drawdown on record, then a V-shaped melt-up",
  },
  {
    id: "inflation-2022",
    label: "2022 inflation bear",
    from: "2022-01-01",
    to: "2022-12-31",
    note: "stocks and bonds down together; no hedge worked",
  },
  {
    id: "gilt-crisis",
    label: "Gilt / LDI crisis",
    from: "2022-09-01",
    to: "2022-11-30",
    note: "mini-budget, sterling to 1.03, forced pension selling",
  },
  {
    id: "svb",
    label: "Banking stress",
    from: "2023-03-01",
    to: "2023-05-31",
    note: "SVB and Credit Suisse; violent sector rotation",
  },
  {
    id: "yen-carry",
    label: "Yen carry unwind",
    from: "2024-07-15",
    to: "2024-09-30",
    note: "5 Aug 2024 VIX spike to 65 on a BoJ hike",
  },
  {
    id: "tariff-2025",
    label: "Tariff shock",
    from: "2025-02-01",
    to: "2025-06-30",
    note: "tariff announcements, gap risk on headlines",
  },
];

export type VolStats = {
  /** Annualised stdev of daily log returns, in percent. */
  annualisedVolPct: number;
  /** Largest single-day drop, in percent. */
  worstDayPct: number;
  /** Share of days moving more than 2%, in percent. */
  bigMoveDaysPct: number;
  /** Peak-to-trough of the reference series, in percent. */
  drawdownPct: number;
};

/** Realised-volatility profile of a reference close series, for the report. */
export function volStats(closes: number[]): VolStats {
  const px = closes.filter((c) => Number.isFinite(c) && c > 0);
  if (px.length < 3) {
    return { annualisedVolPct: 0, worstDayPct: 0, bigMoveDaysPct: 0, drawdownPct: 0 };
  }
  const rets: number[] = [];
  for (let i = 1; i < px.length; i += 1) rets.push(Math.log(px[i]! / px[i - 1]!));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const worst = Math.min(...rets.map((r) => Math.expm1(r)));
  const big = rets.filter((r) => Math.abs(Math.expm1(r)) > 0.02).length;

  let peak = px[0]!;
  let dd = 0;
  for (const p of px) {
    peak = Math.max(peak, p);
    dd = Math.max(dd, (peak - p) / peak);
  }
  return {
    annualisedVolPct: Math.sqrt(variance) * Math.sqrt(252) * 100,
    worstDayPct: worst * 100,
    bigMoveDaysPct: (big / rets.length) * 100,
    drawdownPct: dd * 100,
  };
}

/**
 * Locate a stress window inside a full tape, prepending `warmupBars` of prior
 * history so SMA20/50/200 are primed before the window opens.
 *
 * Returns the slice plus the index within it where the window itself starts —
 * feed that to `runGovernorReplay({ tradeFromIndex })` so the calm run-up
 * neither trades nor contributes to the window's return and drawdown.
 */
export function sliceStressWindow(
  dates: string[],
  window: Pick<StressWindow, "from" | "to">,
  warmupBars = 210,
): { start: number; end: number; sliceStart: number; tradeFromIndex: number } | null {
  const start = dates.findIndex((d) => d >= window.from);
  if (start < 0) return null;
  let end = dates.length - 1;
  for (let i = dates.length - 1; i >= 0; i -= 1) {
    if (dates[i]! <= window.to) {
      end = i;
      break;
    }
  }
  if (end < start) return null;
  const sliceStart = Math.max(0, start - warmupBars);
  return { start, end, sliceStart, tradeFromIndex: start - sliceStart };
}
