// Pure arithmetic + wording behind the "why the account value moved" block of
// the daily AI report.
//
// Everything here is deterministic and free of I/O so it can be unit tested.
// The server module (daily-report-equity.server.ts) supplies the rows.

export type EquityChangeRow = {
  /** ISO date of the closing snapshot. */
  date: string;
  prevDate: string | null;
  prevEquity: number;
  equity: number;
  /** Flow-adjusted gain for the day, in the portfolio's base currency. */
  pnl: number;
  /** Deposits/withdrawals netted out of `pnl`. */
  netFlow: number;
  /** `pnl` as a percentage of the opening equity, when derivable. */
  pct: number | null;
};

export type EquityWindowTotal = {
  pnl: number;
  pct: number | null;
  days: number;
  fromDate: string | null;
  toDate: string | null;
};

export type EquityMover = {
  symbol: string;
  /** Contribution to the day's move, in base currency. */
  contribution: number;
  /** The holding's own price move over the day, in percent. */
  pricePct: number | null;
};

export type EquitySplit = {
  positions: number | null;
  fxLegs: number | null;
  fees: number | null;
};

export type PersistenceVerdict =
  | "too_early"
  | "likely_to_continue"
  | "could_continue"
  | "likely_to_fade";

export type EquityPersistence = {
  direction: "up" | "down" | "flat";
  /** Consecutive days, ending on the report date, moving the same way. */
  runLengthDays: number;
  /** Standard deviation of the daily percentage moves in the window. */
  dailyVolPct: number | null;
  /** Share of the day's gross move explained by the single biggest mover. */
  concentrationPct: number | null;
  /** Market regime the engine recorded for the day, when it recorded one. */
  regime: string | null;
  verdict: PersistenceVerdict;
  text: string;
};

export type EquityReaction = {
  drawdownPct: number | null;
  drawdownLimitPct: number | null;
  dailyLossLimitPct: number | null;
  haltActive: boolean;
  haltReason: string | null;
  /** Cash as a share of total account value, in percent. */
  cashPct: number | null;
  /** Per-name deployment target the engine sizes towards, in percent of NAV. */
  targetPerNamePct: number | null;
  /** Whole-account daily money limit, in base currency. */
  dailyNotionalLimit: number | null;
  notes: string[];
};

export type DailyReportEquity = {
  currency: string;
  hasData: boolean;
  equity: number | null;
  day: EquityWindowTotal | null;
  week: EquityWindowTotal | null;
  month: EquityWindowTotal | null;
  split: EquitySplit;
  helped: EquityMover[];
  hurt: EquityMover[];
  persistence: EquityPersistence;
  reaction: EquityReaction;
  /** Deterministic plain-English version of everything above. */
  summary: string;
};

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Rows on or before `endDate`, oldest first. */
export function rowsUpTo(rows: EquityChangeRow[], endDate: string): EquityChangeRow[] {
  return rows
    .filter((r) => r.date <= endDate)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Total flow-adjusted P&L over the last `days` calendar days ending on
 * `endDate`. The percentage is measured against the opening equity of the
 * first day in the window, so deposits never inflate it.
 */
export function windowTotal(
  rows: EquityChangeRow[],
  endDate: string,
  days: number,
): EquityWindowTotal | null {
  const from = shiftIso(endDate, -(days - 1));
  const slice = rowsUpTo(rows, endDate).filter((r) => r.date >= from);
  if (slice.length === 0) return null;
  const pnl = slice.reduce((acc, r) => acc + (Number.isFinite(r.pnl) ? r.pnl : 0), 0);
  const base = slice[0]!.prevEquity;
  return {
    pnl: round2(pnl),
    pct: base > 0 ? round2((pnl / base) * 100) : null,
    days: slice.length,
    fromDate: slice[0]!.date,
    toDate: slice[slice.length - 1]!.date,
  };
}

/** Consecutive days ending on `endDate` that moved the same way. */
export function runLength(rows: EquityChangeRow[], endDate: string): {
  direction: "up" | "down" | "flat";
  days: number;
} {
  const ordered = rowsUpTo(rows, endDate).slice().reverse();
  const last = ordered[0];
  if (!last || last.pnl === 0) return { direction: "flat", days: 0 };
  const direction = last.pnl > 0 ? "up" : "down";
  let days = 0;
  for (const r of ordered) {
    const sameWay = direction === "up" ? r.pnl > 0 : r.pnl < 0;
    if (!sameWay) break;
    days += 1;
  }
  return { direction, days };
}

/** Standard deviation of the daily percentage moves in the window. */
export function dailyVolPct(rows: EquityChangeRow[]): number | null {
  const pcts = rows.map((r) => r.pct).filter((p): p is number => p != null && Number.isFinite(p));
  if (pcts.length < 3) return null;
  const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const variance = pcts.reduce((a, b) => a + (b - mean) ** 2, 0) / (pcts.length - 1);
  return round2(Math.sqrt(variance));
}

/** Share of the day's gross movement explained by the biggest single mover. */
export function moveConcentrationPct(movers: EquityMover[]): number | null {
  const gross = movers.reduce((a, m) => a + Math.abs(m.contribution), 0);
  if (!(gross > 0)) return null;
  const biggest = Math.max(...movers.map((m) => Math.abs(m.contribution)));
  return round2((biggest / gross) * 100);
}

export function assessPersistence(input: {
  rows: EquityChangeRow[];
  endDate: string;
  movers: EquityMover[];
  regime: string | null;
}): EquityPersistence {
  const window = rowsUpTo(input.rows, input.endDate);
  const { direction, days } = runLength(input.rows, input.endDate);
  const vol = dailyVolPct(window.slice(-30));
  const concentration = moveConcentrationPct(input.movers);
  const today = window[window.length - 1] ?? null;
  const todayPct = today?.pct ?? null;

  let verdict: PersistenceVerdict = "too_early";
  const parts: string[] = [];

  if (window.length < 5) {
    parts.push(
      "There are only a few days of measured history, so there is not enough evidence to say whether this pattern holds.",
    );
  } else if (direction === "flat") {
    verdict = "too_early";
    parts.push("The account barely moved, so there is no trend to carry forward.");
  } else {
    const big = vol != null && todayPct != null && Math.abs(todayPct) > vol * 2;
    if (days >= 3 && !big) {
      verdict = "likely_to_continue";
      parts.push(
        `This is day ${days} of a steady move ${direction === "up" ? "up" : "down"}, and the size of it is in line with the account's normal daily swing, so the same pattern is more likely than not to carry on for now.`,
      );
    } else if (big) {
      verdict = "likely_to_fade";
      parts.push(
        `${direction === "up" ? "The gain" : "The loss"} is more than twice the account's usual daily swing, and one-off jumps that size usually settle back rather than repeat.`,
      );
    } else {
      verdict = "could_continue";
      parts.push(
        `The move is within the account's normal daily range, so it could go either way from here — one day on its own is not a trend.`,
      );
    }
  }

  if (vol != null) {
    parts.push(`A typical day for this account moves about ${vol.toFixed(2)}%.`);
  }
  if (concentration != null && concentration >= 60 && input.movers.length > 1) {
    const top = [...input.movers].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))[0];
    parts.push(
      `About ${Math.round(concentration)}% of the movement came from ${top?.symbol ?? "one holding"} alone, so the account's direction currently depends heavily on that one position.`,
    );
  }
  if (input.regime) {
    parts.push(`The engine read the market as ${input.regime} on the day.`);
  }
  parts.push("This is a reading of the evidence, not a promise about tomorrow.");

  return {
    direction,
    runLengthDays: days,
    dailyVolPct: vol,
    concentrationPct: concentration,
    regime: input.regime,
    verdict,
    text: parts.join(" "),
  };
}

function money(n: number | null, ccy: string): string {
  if (n == null || !Number.isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: ccy || "GBP",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${Math.round(n)} ${ccy}`;
  }
}

function signed(n: number | null, ccy: string): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : "−"}${money(Math.abs(n), ccy)}`;
}

/** Deterministic narrative for the equity block — also the AI's fallback. */
export function buildEquitySummary(e: Omit<DailyReportEquity, "summary">): string {
  if (!e.hasData || !e.day) {
    return "There is no measured account-value change for this date yet, so the report cannot explain a move it has not recorded.";
  }
  const ccy = e.currency;
  const bits: string[] = [];
  bits.push(
    `The account is worth ${money(e.equity, ccy)} and ${e.day.pnl >= 0 ? "gained" : "lost"} ${money(Math.abs(e.day.pnl), ccy)}${
      e.day.pct != null ? ` (${e.day.pct >= 0 ? "+" : "−"}${Math.abs(e.day.pct).toFixed(2)}%)` : ""
    } on the day, with any money paid in or taken out removed first.`,
  );
  if (e.week) {
    bits.push(
      `Over the last week it is ${signed(e.week.pnl, ccy)}${
        e.month ? ` and over the last month ${signed(e.month.pnl, ccy)}` : ""
      }.`,
    );
  }
  const splitBits: string[] = [];
  if (e.split.positions != null) splitBits.push(`${signed(e.split.positions, ccy)} from your holdings`);
  if (e.split.fxLegs != null && e.split.fxLegs !== 0)
    splitBits.push(`${signed(e.split.fxLegs, ccy)} from currency hedge legs`);
  if (e.split.fees != null && e.split.fees !== 0)
    splitBits.push(`${money(e.split.fees, ccy)} of broker charges`);
  if (splitBits.length) bits.push(`That breaks down as ${splitBits.join(", ")}.`);

  if (e.helped.length) {
    bits.push(
      `The biggest help came from ${e.helped
        .slice(0, 3)
        .map((m) => `${m.symbol} (${signed(m.contribution, ccy)})`)
        .join(", ")}.`,
    );
  }
  if (e.hurt.length) {
    bits.push(
      `The biggest drag came from ${e.hurt
        .slice(0, 3)
        .map((m) => `${m.symbol} (${signed(m.contribution, ccy)})`)
        .join(", ")}.`,
    );
  }
  bits.push(e.persistence.text);

  const r = e.reaction;
  const reactionBits: string[] = [];
  if (r.drawdownPct != null) {
    reactionBits.push(
      `it is ${r.drawdownPct.toFixed(2)}% below its best-ever value${
        r.drawdownLimitPct != null ? `, against a ${r.drawdownLimitPct.toFixed(1)}% level where it stops buying altogether` : ""
      }`,
    );
  }
  if (r.cashPct != null) {
    reactionBits.push(
      `${r.cashPct.toFixed(0)}% of the account is still in cash${
        r.targetPerNamePct != null ? `, and it sizes each new position towards ${r.targetPerNamePct.toFixed(0)}% of the account` : ""
      }`,
    );
  }
  if (r.dailyNotionalLimit != null) {
    reactionBits.push(`it may spend at most ${money(r.dailyNotionalLimit, ccy)} in a single day`);
  }
  if (r.haltActive) {
    reactionBits.push(`new buying is currently halted${r.haltReason ? ` — ${r.haltReason}` : ""}`);
  }
  if (reactionBits.length) {
    bits.push(`The AI is already factoring this in: ${reactionBits.join("; ")}.`);
  }
  for (const note of r.notes) bits.push(note);

  return bits.join(" ");
}
