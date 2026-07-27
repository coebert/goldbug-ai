// Pure integrity checker for portfolios.starting_cash.
//
// A portfolio's `starting_cash` should equal the initial seed (the cash the
// portfolio was created with) plus every recorded deposit since creation:
//
//     starting_cash == seed + Σ deposits
//
// For sim/paper portfolios, deposits are `sim_fund_events`.
// For live_prod / live_sim portfolios, deposits are the unexplained-delta
// CASH_SYNC entries in `live_broker_log` (`response.startingCashAdjusted`).
//
// We don't persist the seed as its own column, so this module infers it two
// independent ways and cross-checks them:
//   1. `impliedSeed = starting_cash − Σ deposits`
//   2. `snapshotSeed = earliestSnapshot.total_value` (before any deposits)
//
// If the two disagree by more than TOLERANCE, or if `impliedSeed` is
// negative, or if the sim_fund_events `balance_after` chain drifts, we
// emit a structured violation. Zero I/O — safe to unit test in isolation.

export type DepositRecord = {
  date: string;
  amount: number;
  /** Optional running balance recorded at the time of the deposit
   *  (sim_fund_events.balance_after). Used to detect chain drift. */
  balanceAfter?: number | null;
};

export type StartingCashIntegrityInput = {
  portfolioId: string;
  portfolioName: string;
  currency: string;
  mode: string;
  startingCash: number;
  currentCash: number;
  deposits: DepositRecord[];
  /** First equity_snapshot on/after portfolio creation, if any. */
  earliestSnapshot?: {
    date: string;
    totalValue: number;
  } | null;
};

export type StartingCashViolationCode =
  | "non_finite"
  | "starting_cash_negative"
  | "implied_seed_negative"
  | "snapshot_seed_mismatch"
  | "deposit_chain_drift"
  | "current_cash_below_zero";

export type StartingCashViolation = {
  code: StartingCashViolationCode;
  severity: "warn" | "error";
  message: string;
  context: Record<string, number | string | null>;
};

export type StartingCashIntegrityResult = {
  portfolioId: string;
  portfolioName: string;
  currency: string;
  mode: string;
  startingCash: number;
  totalDeposits: number;
  impliedSeed: number;
  snapshotSeed: number | null;
  ok: boolean;
  violations: StartingCashViolation[];
};

export type StartingCashIntegrityOptions = {
  /** Absolute tolerance in base-currency units. Default 0.5. */
  tolerance?: number;
};

const DEFAULT_TOLERANCE = 0.5;

export function checkStartingCashIntegrity(
  input: StartingCashIntegrityInput,
  options: StartingCashIntegrityOptions = {},
): StartingCashIntegrityResult {
  const tol = options.tolerance ?? DEFAULT_TOLERANCE;
  const startingCash = Number(input.startingCash);
  const currentCash = Number(input.currentCash);

  const violations: StartingCashViolation[] = [];
  const ctxBase = {
    portfolio_id: input.portfolioId,
    portfolio_name: input.portfolioName,
    currency: input.currency,
    mode: input.mode,
  };

  let totalDeposits = 0;
  for (const d of input.deposits) {
    const amt = Number(d.amount);
    if (Number.isFinite(amt)) totalDeposits += amt;
  }
  const impliedSeed = startingCash - totalDeposits;
  const snapshotSeed = input.earliestSnapshot
    ? Number(input.earliestSnapshot.totalValue)
    : null;

  if (!Number.isFinite(startingCash)) {
    violations.push({
      code: "non_finite",
      severity: "error",
      message: `starting_cash is not a finite number (got ${String(startingCash)})`,
      context: { ...ctxBase, field: "starting_cash", value: String(startingCash) },
    });
  }
  if (!Number.isFinite(currentCash)) {
    violations.push({
      code: "non_finite",
      severity: "error",
      message: `current_cash is not a finite number (got ${String(currentCash)})`,
      context: { ...ctxBase, field: "current_cash", value: String(currentCash) },
    });
  }

  if (violations.some((v) => v.code === "non_finite")) {
    return {
      portfolioId: input.portfolioId,
      portfolioName: input.portfolioName,
      currency: input.currency,
      mode: input.mode,
      startingCash,
      totalDeposits,
      impliedSeed,
      snapshotSeed,
      ok: false,
      violations,
    };
  }

  if (startingCash < -tol) {
    violations.push({
      code: "starting_cash_negative",
      severity: "error",
      message: `starting_cash is negative (${startingCash})`,
      context: { ...ctxBase, starting_cash: startingCash },
    });
  }

  if (currentCash < -tol) {
    violations.push({
      code: "current_cash_below_zero",
      severity: "error",
      message: `current_cash is negative (${currentCash}); margin is not supported`,
      context: { ...ctxBase, current_cash: currentCash },
    });
  }

  if (impliedSeed < -tol) {
    violations.push({
      code: "implied_seed_negative",
      severity: "error",
      message: `Recorded deposits (${totalDeposits.toFixed(2)}) exceed starting_cash (${startingCash.toFixed(2)}); implied seed = ${impliedSeed.toFixed(2)}`,
      context: {
        ...ctxBase,
        starting_cash: startingCash,
        total_deposits: Number(totalDeposits.toFixed(4)),
        implied_seed: Number(impliedSeed.toFixed(4)),
      },
    });
  }

  if (snapshotSeed != null && Number.isFinite(snapshotSeed)) {
    const diff = Math.abs(impliedSeed - snapshotSeed);
    if (diff > tol) {
      violations.push({
        code: "snapshot_seed_mismatch",
        severity: "warn",
        message: `Implied seed ${impliedSeed.toFixed(2)} disagrees with earliest snapshot ${snapshotSeed.toFixed(2)} by ${diff.toFixed(2)} — starting_cash may be miscalibrated.`,
        context: {
          ...ctxBase,
          implied_seed: Number(impliedSeed.toFixed(4)),
          snapshot_seed: Number(snapshotSeed.toFixed(4)),
          diff: Number(diff.toFixed(4)),
          earliest_snapshot_date: input.earliestSnapshot?.date ?? null,
        },
      });
    }
  }

  // Detect deposit chain drift: for each deposit that carries a
  // balance_after, the previous balance_after + amount should ≈ current
  // balance_after (allowing for trading PnL between events is out of
  // scope; we only flag when the row itself is internally inconsistent,
  // e.g. amount + prev == balance_after off by more than tol AND no
  // trades exist between them — approximated by checking consecutive
  // events on the same date).
  const chained = input.deposits
    .filter((d) => d.balanceAfter != null && Number.isFinite(Number(d.balanceAfter)))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < chained.length; i++) {
    const prev = chained[i - 1];
    const cur = chained[i];
    if (prev.date !== cur.date) continue;
    const expected = Number(prev.balanceAfter) + Number(cur.amount);
    const actual = Number(cur.balanceAfter);
    if (Math.abs(expected - actual) > tol) {
      violations.push({
        code: "deposit_chain_drift",
        severity: "warn",
        message: `sim_fund_events chain drift on ${cur.date}: previous balance ${prev.balanceAfter} + amount ${cur.amount} ≠ ${cur.balanceAfter}`,
        context: {
          ...ctxBase,
          date: cur.date,
          prev_balance_after: Number(prev.balanceAfter),
          amount: Number(cur.amount),
          balance_after: Number(cur.balanceAfter),
        },
      });
    }
  }

  const ok = violations.length === 0;
  return {
    portfolioId: input.portfolioId,
    portfolioName: input.portfolioName,
    currency: input.currency,
    mode: input.mode,
    startingCash,
    totalDeposits,
    impliedSeed,
    snapshotSeed,
    ok,
    violations,
  };
}

export type StartingCashIntegrityReport = {
  generatedAt: string;
  totalPortfolios: number;
  flaggedPortfolios: number;
  results: StartingCashIntegrityResult[];
};

export function buildStartingCashIntegrityReport(
  inputs: StartingCashIntegrityInput[],
  options: StartingCashIntegrityOptions = {},
): StartingCashIntegrityReport {
  const results = inputs.map((i) => checkStartingCashIntegrity(i, options));
  return {
    generatedAt: new Date().toISOString(),
    totalPortfolios: results.length,
    flaggedPortfolios: results.filter((r) => !r.ok).length,
    results,
  };
}
