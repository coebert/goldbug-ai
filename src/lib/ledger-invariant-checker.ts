/**
 * Ledger invariant checker.
 *
 * When a replay reconciliation fails, the useful question is never "did it
 * fail" — the assertion already said that. It is *where* the ledger stopped
 * describing the trades: which step, by how much, in which direction, and what
 * the smallest trade set is that still breaks it.
 *
 * This module walks an ordered list of fills, snapshots cash and holdings
 * before and after every one, and checks the invariants the app depends on:
 *
 *   - cash never goes negative (no implicit leverage);
 *   - holdings never go negative (no naked shorts — inverse ETFs are longs);
 *   - each step's cash delta equals -(notional) - fees for a buy and
 *     +(notional) - fees for a sell, to the micro-unit;
 *   - each step's holding delta equals the signed fill quantity;
 *   - the closing cash/holdings match the expected totals supplied by the
 *     caller (the replay summary), within a caller-set epsilon.
 *
 * Arithmetic is done in integer micro-units so "exact" means exact, with the
 * epsilon reserved for comparisons against float summaries.
 *
 * On failure the result carries a printable report plus `smallestViolating`,
 * a delta-debugged minimal subset of the fills that still violates the same
 * invariant — usually one or two trades out of hundreds.
 */

export type LedgerFill = {
  /** Stable identifier used in reports. */
  id: string;
  symbol: string;
  side: "buy" | "sell";
  /** Filled quantity in shares (may be fractional). */
  quantity: number;
  /** Settlement price per share, already normalised to the base currency. */
  price: number;
  /** Total costs for this fill, always a cash outflow on both sides. */
  fees?: number;
  /** Optional label surfaced in the report (venue, order id, step, ...). */
  note?: string;
};

export type LedgerStep = {
  index: number;
  fill: LedgerFill;
  cashBefore: number;
  cashAfter: number;
  cashDelta: number;
  /** Expected cash delta implied by the fill's own numbers. */
  expectedCashDelta: number;
  holdingBefore: number;
  holdingAfter: number;
  holdingDelta: number;
  expectedHoldingDelta: number;
  /** Snapshot of the whole book after this step (non-zero positions only). */
  holdings: Record<string, number>;
};

export type ViolationCode =
  | "negative_cash"
  | "negative_holding"
  | "cash_delta_mismatch"
  | "holding_delta_mismatch"
  | "final_cash_mismatch"
  | "final_holdings_mismatch"
  | "invalid_input";

export type LedgerViolation = {
  code: ViolationCode;
  message: string;
  /** Index of the offending step, or -1 for whole-run checks. */
  index: number;
  fill: LedgerFill | null;
  expected: number;
  actual: number;
  /** actual - expected, in base currency or shares. */
  delta: number;
  step: LedgerStep | null;
};

export type LedgerCheckOptions = {
  startingCash: number;
  /** Tolerance for comparisons against float summaries. Default 1e-9. */
  epsilon?: number;
  /** Opening positions, if the replay resumes mid-run. */
  startingHoldings?: Record<string, number>;
  /** Closing cash reported by the replay summary. */
  expectedFinalCash?: number;
  /** Closing book reported by the replay summary. */
  expectedFinalHoldings?: Record<string, number>;
  /** Set for cash-funded strategies that may legitimately hold no cash buffer. */
  allowNegativeCash?: boolean;
  /** Set only for engines that model true shorts. */
  allowNegativeHoldings?: boolean;
};

export type LedgerCheckResult = {
  ok: boolean;
  steps: LedgerStep[];
  violations: LedgerViolation[];
  finalCash: number;
  finalHoldings: Record<string, number>;
  /** First violation in step order, the one worth reading first. */
  first: LedgerViolation | null;
  /**
   * Minimal set of fills that still reproduces the first violation's code,
   * found by delta debugging. Empty when the run is clean.
   */
  smallestViolating: LedgerFill[];
  /** Human-readable diagnosis: snapshots around the break plus the minimum. */
  report: string;
};

const MICROS = 1_000_000;
const toMicros = (v: number) => Math.round(v * MICROS);
const fromMicros = (v: number) => v / MICROS;
/** Shares are tracked in micro-shares so fractional fills stay exact. */
const toMicroQty = (v: number) => Math.round(v * MICROS);

const money = (v: number) =>
  `${v < 0 ? "-" : ""}£${Math.abs(v).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })}`;

const qty = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(6));

/** Cash delta implied by a fill: notional out on a buy, in on a sell, fees always out. */
export function expectedCashDelta(fill: LedgerFill): number {
  const notional = fill.price * fill.quantity;
  const fees = fill.fees ?? 0;
  return (fill.side === "buy" ? -notional : notional) - fees;
}

export function expectedHoldingDelta(fill: LedgerFill): number {
  return fill.side === "buy" ? fill.quantity : -fill.quantity;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

function walk(fills: readonly LedgerFill[], options: LedgerCheckOptions) {
  const eps = options.epsilon ?? 1e-9;
  const epsMicros = Math.max(1, Math.ceil(eps * MICROS));
  const violations: LedgerViolation[] = [];
  const steps: LedgerStep[] = [];

  let cashMicros = toMicros(options.startingCash);
  const bookMicros = new Map<string, number>();
  for (const [symbol, q] of Object.entries(options.startingHoldings ?? {})) {
    if (q !== 0) bookMicros.set(symbol, toMicroQty(q));
  }

  const push = (v: Omit<LedgerViolation, "delta">) =>
    violations.push({ ...v, delta: v.actual - v.expected });

  fills.forEach((fill, index) => {
    if (
      !Number.isFinite(fill.price) ||
      !Number.isFinite(fill.quantity) ||
      !Number.isFinite(fill.fees ?? 0)
    ) {
      push({
        code: "invalid_input",
        message: `fill ${fill.id} carries a non-finite price/quantity/fee — NaN poisoning would spread silently through the ledger`,
        index,
        fill,
        expected: 0,
        actual: Number.NaN,
        step: null,
      });
      return;
    }

    const cashBeforeMicros = cashMicros;
    const holdBeforeMicros = bookMicros.get(fill.symbol) ?? 0;

    const wantCashMicros =
      (fill.side === "buy" ? -1 : 1) * toMicros(fill.price * fill.quantity) -
      toMicros(fill.fees ?? 0);
    const wantQtyMicros = (fill.side === "buy" ? 1 : -1) * toMicroQty(fill.quantity);

    cashMicros = cashBeforeMicros + wantCashMicros;
    const holdAfterMicros = holdBeforeMicros + wantQtyMicros;
    if (holdAfterMicros === 0) bookMicros.delete(fill.symbol);
    else bookMicros.set(fill.symbol, holdAfterMicros);

    const holdings: Record<string, number> = {};
    for (const [symbol, q] of bookMicros) holdings[symbol] = fromMicros(q);

    const step: LedgerStep = {
      index,
      fill,
      cashBefore: fromMicros(cashBeforeMicros),
      cashAfter: fromMicros(cashMicros),
      cashDelta: fromMicros(cashMicros - cashBeforeMicros),
      expectedCashDelta: expectedCashDelta(fill),
      holdingBefore: fromMicros(holdBeforeMicros),
      holdingAfter: fromMicros(holdAfterMicros),
      holdingDelta: fromMicros(wantQtyMicros),
      expectedHoldingDelta: expectedHoldingDelta(fill),
      holdings,
    };
    steps.push(step);

    if (Math.abs(step.cashDelta - step.expectedCashDelta) > eps) {
      push({
        code: "cash_delta_mismatch",
        message: `step ${index} (${fill.id}) moved cash by ${money(step.cashDelta)} but the fill implies ${money(step.expectedCashDelta)}`,
        index,
        fill,
        expected: step.expectedCashDelta,
        actual: step.cashDelta,
        step,
      });
    }
    if (Math.abs(step.holdingDelta - step.expectedHoldingDelta) > eps) {
      push({
        code: "holding_delta_mismatch",
        message: `step ${index} (${fill.id}) moved ${fill.symbol} by ${qty(step.holdingDelta)} but the fill implies ${qty(step.expectedHoldingDelta)}`,
        index,
        fill,
        expected: step.expectedHoldingDelta,
        actual: step.holdingDelta,
        step,
      });
    }
    if (!options.allowNegativeCash && cashMicros < -epsMicros) {
      push({
        code: "negative_cash",
        message: `step ${index} (${fill.id}) drove cash to ${money(step.cashAfter)} — the account cannot fund this fill (short by ${money(-step.cashAfter)})`,
        index,
        fill,
        expected: 0,
        actual: step.cashAfter,
        step,
      });
    }
    if (!options.allowNegativeHoldings && holdAfterMicros < -epsMicros) {
      push({
        code: "negative_holding",
        message: `step ${index} (${fill.id}) sold ${qty(fill.quantity)} ${fill.symbol} against a position of ${qty(step.holdingBefore)} — holdings went to ${qty(step.holdingAfter)}`,
        index,
        fill,
        expected: 0,
        actual: step.holdingAfter,
        step,
      });
    }
  });

  const finalCash = fromMicros(cashMicros);
  const finalHoldings: Record<string, number> = {};
  for (const [symbol, q] of bookMicros) finalHoldings[symbol] = fromMicros(q);

  if (options.expectedFinalCash !== undefined) {
    const diff = finalCash - options.expectedFinalCash;
    if (Math.abs(diff) > eps) {
      push({
        code: "final_cash_mismatch",
        message: `closing cash ${money(finalCash)} disagrees with the replay summary ${money(options.expectedFinalCash)} by ${money(diff)}`,
        index: -1,
        fill: null,
        expected: options.expectedFinalCash,
        actual: finalCash,
        step: null,
      });
    }
  }

  if (options.expectedFinalHoldings) {
    const symbols = new Set([
      ...Object.keys(finalHoldings),
      ...Object.keys(options.expectedFinalHoldings),
    ]);
    for (const symbol of [...symbols].sort()) {
      const actual = finalHoldings[symbol] ?? 0;
      const expected = options.expectedFinalHoldings[symbol] ?? 0;
      if (Math.abs(actual - expected) > eps) {
        push({
          code: "final_holdings_mismatch",
          message: `closing ${symbol} position ${qty(actual)} disagrees with the replay summary ${qty(expected)} by ${qty(actual - expected)}`,
          index: -1,
          fill: null,
          expected,
          actual,
          step: null,
        });
      }
    }
  }

  return { steps, violations, finalCash, finalHoldings };
}

// ---------------------------------------------------------------------------
// Minimisation
// ---------------------------------------------------------------------------

/** Candidate sublists, biggest simplifications first (ddmin ordering). */
function candidates<T>(items: readonly T[]): T[][] {
  const n = items.length;
  if (n <= 1) return [];
  const out: T[][] = [items.slice(0, Math.floor(n / 2)), items.slice(Math.floor(n / 2))];
  for (let parts = 4; parts <= 8 && parts < n; parts *= 2) {
    const chunk = Math.ceil(n / parts);
    for (let start = 0; start < n; start += chunk) {
      out.push([...items.slice(0, start), ...items.slice(start + chunk)]);
    }
  }
  if (n <= 32) for (let i = 0; i < n; i++) out.push([...items.slice(0, i), ...items.slice(i + 1)]);
  return out.filter((c) => c.length > 0 && c.length < n);
}

/**
 * Shrink to the fewest fills that still reproduce `code`.
 *
 * Whole-run checks (closing totals) are dropped while shrinking: a subset of
 * fills cannot be expected to reach the same closing balance, so keeping them
 * would make every candidate "fail" for the wrong reason. Per-step codes are
 * matched exactly so shrinking never drifts onto a different bug.
 */
export function smallestViolatingFills(
  fills: readonly LedgerFill[],
  options: LedgerCheckOptions,
  code: ViolationCode,
): LedgerFill[] {
  const subsetOptions: LedgerCheckOptions = {
    ...options,
    expectedFinalCash: undefined,
    expectedFinalHoldings: undefined,
  };
  const reproduces = (subset: readonly LedgerFill[]) =>
    walk(subset, subsetOptions).violations.some((v) => v.code === code);

  if (code === "final_cash_mismatch" || code === "final_holdings_mismatch") return [];
  if (!reproduces(fills)) return [];

  let current = [...fills];
  let progress = true;
  let guard = 0;
  while (progress && current.length > 1 && guard++ < 200) {
    progress = false;
    for (const candidate of candidates(current)) {
      if (reproduces(candidate)) {
        current = candidate;
        progress = true;
        break;
      }
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function describeStep(step: LedgerStep): string {
  const f = step.fill;
  const book = Object.entries(step.holdings)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([s, q]) => `${s}:${qty(q)}`)
    .join(" ");
  return [
    `  #${String(step.index).padStart(4, " ")} ${f.id.padEnd(10)} ${f.side.toUpperCase().padEnd(4)} ${f.symbol.padEnd(8)}`,
    `qty ${qty(f.quantity).padStart(10)} @ ${money(f.price)}`,
    `fees ${money(f.fees ?? 0)}`,
    `cash ${money(step.cashBefore)} -> ${money(step.cashAfter)} (${money(step.cashDelta)})`,
    `pos ${qty(step.holdingBefore)} -> ${qty(step.holdingAfter)}`,
    book ? `book [${book}]` : "book []",
    f.note ? `note ${f.note}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

/** Snapshots around the break, the exact deltas, and the minimal repro. */
export function formatLedgerReport(result: Omit<LedgerCheckResult, "report">): string {
  if (result.ok) {
    return `ledger OK — ${result.steps.length} fills, closing cash ${money(result.finalCash)}`;
  }
  const lines: string[] = [];
  const first = result.first;
  lines.push(`LEDGER RECONCILIATION FAILED — ${result.violations.length} violation(s)`);
  if (first) {
    lines.push(`first: [${first.code}] ${first.message}`);
    lines.push(
      `       expected ${first.expected} / actual ${first.actual} / delta ${first.delta}`,
    );
  }

  if (first && first.index >= 0) {
    const from = Math.max(0, first.index - 2);
    const to = Math.min(result.steps.length - 1, first.index + 2);
    lines.push(`context (steps ${from}..${to}):`);
    for (let i = from; i <= to; i++) {
      const step = result.steps[i];
      if (!step) continue;
      lines.push(`${i === first.index ? ">>" : "  "}${describeStep(step).slice(2)}`);
    }
  }

  if (result.violations.length > 1) {
    lines.push("all violations:");
    for (const v of result.violations.slice(0, 12)) {
      lines.push(`  [${v.code}] step ${v.index}: delta ${v.delta}`);
    }
    if (result.violations.length > 12) {
      lines.push(`  ... and ${result.violations.length - 12} more`);
    }
  }

  if (result.smallestViolating.length > 0) {
    lines.push(
      `smallest violating trade set (${result.smallestViolating.length} of ${result.steps.length} fills):`,
    );
    const minimal = walk(result.smallestViolating, {
      startingCash: 0,
      allowNegativeCash: true,
      allowNegativeHoldings: true,
    });
    for (const step of minimal.steps) lines.push(describeStep(step));
  }

  lines.push(
    `closing: cash ${money(result.finalCash)} | book ${
      Object.entries(result.finalHoldings)
        .map(([s, q]) => `${s}:${qty(q)}`)
        .join(" ") || "[]"
    }`,
  );
  return lines.join("\n");
}

/**
 * Walk a fill list, check every ledger invariant, and diagnose any failure.
 *
 * Cheap enough to call from tests and from the reconciliation path in anger:
 * one pass for the walk, and minimisation only runs when something broke.
 */
export function checkLedgerInvariants(
  fills: readonly LedgerFill[],
  options: LedgerCheckOptions,
): LedgerCheckResult {
  const { steps, violations, finalCash, finalHoldings } = walk(fills, options);
  const first = violations[0] ?? null;
  const smallestViolating = first ? smallestViolatingFills(fills, options, first.code) : [];
  const partial: Omit<LedgerCheckResult, "report"> = {
    ok: violations.length === 0,
    steps,
    violations,
    finalCash,
    finalHoldings,
    first,
    smallestViolating,
  };
  return { ...partial, report: formatLedgerReport(partial) };
}

/** Throw with the full diagnosis when the ledger does not reconcile. */
export function assertLedgerReconciles(
  fills: readonly LedgerFill[],
  options: LedgerCheckOptions,
  context = "",
): LedgerCheckResult {
  const result = checkLedgerInvariants(fills, options);
  if (!result.ok) throw new Error(`${context ? `${context}\n` : ""}${result.report}`);
  return result;
}
