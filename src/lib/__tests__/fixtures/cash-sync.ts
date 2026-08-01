// Reusable CASH_SYNC broker-log fixtures for equity-sparkline regression
// tests.
//
// A CASH_SYNC row reports a change to `portfolios.starting_cash` as a
// `delta`. Only rows carrying a finite `previousStarting` describe a real
// before/after cash movement; rows without one are baseline *repairs* and
// must never be netted verbatim out of the equity series (that is the
// "-49% / -8.9% phantom deposit" bug). See src/lib/infer-cash-flow.ts.

export type CashSyncLogRow = {
  portfolio_id: string;
  created_at: string;
  status: number;
  response: {
    delta?: number | string;
    startingCashAdjusted?: boolean;
    currency?: string;
    newStarting?: number | string;
    previousStarting?: number | string | null;
  };
};

export type SeriesPoint = { date: string; value: number };

export const CASH_SYNC_PORTFOLIO = "7c825889-0000-4000-8000-000000000001";

function row(
  created_at: string,
  response: CashSyncLogRow["response"],
): CashSyncLogRow {
  return { portfolio_id: CASH_SYNC_PORTFOLIO, created_at, status: 200, response };
}

/** Flat portfolio funded on 07-24; sync noticed on 07-27. */
export const fundedThenFlatSeries: SeriesPoint[] = [
  { date: "2026-07-23", value: 1300.32 },
  { date: "2026-07-24", value: 10189.12 },
  { date: "2026-07-27", value: 10189.12 },
  { date: "2026-07-28", value: 10189.12 },
  { date: "2026-08-01", value: 10189.12 },
];

/** Money arrives in two steps, then the portfolio trades sideways. */
export const twoStepFundingSeries: SeriesPoint[] = [
  { date: "2026-07-20", value: 500 },
  { date: "2026-07-21", value: 5500 },
  { date: "2026-07-22", value: 5480 },
  { date: "2026-07-23", value: 10480 },
  { date: "2026-07-24", value: 10510 },
];

/** Genuinely losing portfolio — no inflow anywhere in the window. */
export const decliningSeries: SeriesPoint[] = [
  { date: "2026-07-20", value: 10000 },
  { date: "2026-07-21", value: 9700 },
  { date: "2026-07-22", value: 9400 },
  { date: "2026-07-23", value: 9100 },
];

/** Funding arrives on the very first stored snapshot (baseline funding). */
export const fundedAtBaselineSeries: SeriesPoint[] = [
  { date: "2026-07-24", value: 10189.12 },
  { date: "2026-07-25", value: 10201.4 },
  { date: "2026-07-26", value: 10150.0 },
];

export const cashSyncRows = {
  /** The canonical bug row: repair with no known prior baseline. */
  missingPreviousStarting: row("2026-07-27T06:12:00.000Z", {
    startingCashAdjusted: true,
    currency: "GBP",
    delta: 9890.38,
    newStarting: 10190.38,
    // previousStarting intentionally absent
  }),
  /** Same shape, but the field is present-and-null (older writer). */
  nullPreviousStarting: row("2026-07-27T06:12:00.000Z", {
    startingCashAdjusted: true,
    currency: "GBP",
    delta: 9890.38,
    newStarting: 10190.38,
    previousStarting: null,
  }),
  /** Non-numeric junk in previousStarting must be treated as untrusted. */
  junkPreviousStarting: row("2026-07-27T06:12:00.000Z", {
    startingCashAdjusted: true,
    currency: "GBP",
    delta: 9890.38,
    newStarting: 10190.38,
    previousStarting: "unknown",
  }),
  /** Untrusted repair that overstates the delta versus observed equity. */
  overstatedRepair: row("2026-07-24T06:00:00.000Z", {
    startingCashAdjusted: true,
    currency: "GBP",
    delta: 50000,
    newStarting: 60000,
  }),
  /** Untrusted repair on a portfolio that only ever fell — nothing to net. */
  repairOnDecliningPortfolio: row("2026-07-23T06:00:00.000Z", {
    startingCashAdjusted: true,
    currency: "GBP",
    delta: 1000,
    newStarting: 11000,
  }),
  /** Trusted movement: a real deposit with a known prior baseline. */
  trustedDeposit: row("2026-07-22T06:00:00.000Z", {
    startingCashAdjusted: true,
    currency: "GBP",
    delta: 5000,
    previousStarting: 500,
    newStarting: 5500,
  }),
  /** Trusted withdrawal (negative delta) — must pass through verbatim. */
  trustedWithdrawal: row("2026-07-22T06:00:00.000Z", {
    startingCashAdjusted: true,
    currency: "GBP",
    delta: -250,
    previousStarting: 10500,
    newStarting: 10250,
  }),
  /** Clamped no-op: baseline unchanged, must be ignored entirely. */
  clampedNoop: row("2026-07-27T06:00:00.000Z", {
    startingCashAdjusted: true,
    currency: "GBP",
    delta: -120,
    previousStarting: 10190.38,
    newStarting: 10190.38,
  }),
  /** Sync that did not touch starting_cash — never a flow. */
  notAdjusted: row("2026-07-27T06:00:00.000Z", {
    startingCashAdjusted: false,
    currency: "GBP",
    delta: 42,
  }),
  /** Zero / non-finite deltas. */
  zeroDelta: row("2026-07-27T06:00:00.000Z", {
    startingCashAdjusted: true,
    currency: "GBP",
    delta: 0,
    newStarting: 10190.38,
  }),
  nanDelta: row("2026-07-27T06:00:00.000Z", {
    startingCashAdjusted: true,
    currency: "GBP",
    delta: "not-a-number",
    newStarting: 10190.38,
  }),
} as const;

/**
 * Mirrors the CASH_SYNC → deposit-flow derivation in
 * src/lib/portfolios.functions.ts so fixtures exercise the same gating
 * rules the dashboard uses.
 */
export function deriveFlowsFromCashSyncs(
  rows: readonly CashSyncLogRow[],
  series: SeriesPoint[],
  reanchor: (
    reported: { date: string; amount: number },
    series: SeriesPoint[],
  ) => { date: string; amount: number } | null,
): Array<{ date: string; amount: number }> {
  const out: Array<{ date: string; amount: number }> = [];
  for (const r of rows) {
    const resp = r.response ?? {};
    if (!resp.startingCashAdjusted) continue;
    const prevStart = Number(resp.previousStarting);
    const newStart = Number(resp.newStarting);
    if (Number.isFinite(prevStart) && Number.isFinite(newStart) && prevStart === newStart) {
      continue;
    }
    const amt = Number(resp.delta);
    if (!Number.isFinite(amt) || amt === 0) continue;
    const raw = { date: String(r.created_at).slice(0, 10), amount: amt };
    const flow = Number.isFinite(prevStart) ? raw : reanchor(raw, series);
    if (!flow) continue;
    out.push(flow);
  }
  return out;
}
