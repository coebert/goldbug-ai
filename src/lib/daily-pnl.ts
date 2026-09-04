// Pure arithmetic behind the daily P&L summary.
//
// Contract, per day:
//   netPnl = positions + fxLegs - fees
// `positions` is derived as the remainder so a row always adds up on
// screen: it is "everything that was not an FX leg or a booked charge",
// i.e. equity lines plus any spread/timing slop.

export type DailyPnlDay = {
  /** ISO date (YYYY-MM-DD) of the closing snapshot. */
  date: string;
  /** ISO date of the snapshot this day is measured against. */
  prevDate: string | null;
  /** Flow-adjusted net gain for the day, in base currency. */
  netPnl: number;
  /** Contribution of open FX hedge legs. */
  fxLegs: number;
  /** Broker charges booked that day (positive = money out). */
  fees: number;
  /** Derived remainder: equity positions plus unattributed slop. */
  positions: number;
  /** Deposits/withdrawals netted out of netPnl. */
  netFlow: number;
  /** Closing equity. */
  equity: number;
  /** netPnl as a share of the opening equity, in percent. */
  pct: number | null;
};

export type WeeklyPnl = {
  /** Monday of the ISO week. */
  weekStart: string;
  /** Last day present in the data for that week. */
  weekEnd: string;
  dayCount: number;
  netPnl: number;
  positions: number;
  fxLegs: number;
  fees: number;
};

export type DailyPnlInput = {
  date: string;
  prevDate: string | null;
  prevEquity: number;
  equity: number;
  netPnl: number;
  netFlow: number;
  fxLegs: number;
  fees: number;
};

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function buildDailyPnl(inputs: DailyPnlInput[]): DailyPnlDay[] {
  return inputs
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map((i) => {
      const netPnl = round2(i.netPnl);
      const fxLegs = round2(i.fxLegs);
      const fees = round2(i.fees);
      return {
        date: i.date,
        prevDate: i.prevDate,
        netPnl,
        fxLegs,
        fees,
        positions: round2(netPnl - fxLegs + fees),
        netFlow: round2(i.netFlow),
        equity: round2(i.equity),
        pct:
          Number.isFinite(i.prevEquity) && i.prevEquity > 0
            ? (netPnl / i.prevEquity) * 100
            : null,
      };
    });
}

/** Monday of the ISO week containing `date` (YYYY-MM-DD). */
export function weekStartOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function groupByWeek(days: DailyPnlDay[]): WeeklyPnl[] {
  const byWeek = new Map<string, DailyPnlDay[]>();
  for (const d of days) {
    const k = weekStartOf(d.date);
    const list = byWeek.get(k);
    if (list) list.push(d);
    else byWeek.set(k, [d]);
  }
  return [...byWeek.entries()]
    .map(([weekStart, list]) => {
      const dates = list.map((d) => d.date).sort();
      return {
        weekStart,
        weekEnd: dates[dates.length - 1] ?? weekStart,
        dayCount: list.length,
        netPnl: round2(list.reduce((s, d) => s + d.netPnl, 0)),
        positions: round2(list.reduce((s, d) => s + d.positions, 0)),
        fxLegs: round2(list.reduce((s, d) => s + d.fxLegs, 0)),
        fees: round2(list.reduce((s, d) => s + d.fees, 0)),
      };
    })
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));
}
