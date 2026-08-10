import { describe, expect, it } from "vitest";
import type { SignalTrade } from "@/lib/breakout-backtest";
import { RISK_LEVELS, type RiskLevel } from "@/lib/breakout-driver-actions";
import {
  applyDriverSizing,
  baselineExecution,
  buildExecutionGrid,
} from "@/lib/breakout-driver-execution";
import {
  applySizingLimits,
  resolveSizingLimits,
  type LimitedPlan,
  type SizingLimits,
} from "@/lib/breakout-sizing-limits";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";
import { attempt, expectNoCounterexample, shrinkList, shrinkNumber } from "./fuzz-shrink";

/**
 * Property-based invariants for the full replay.
 *
 * The snapshot suite pins exact numbers for one fixture; this one asserts the
 * rules that must hold for *every* input. Each case randomises the cohort, the
 * caps, the risk level, the gap weight and the grid dimensions, then checks
 * properties that no legitimate logic change may break:
 *
 *  - No leverage: no single position exceeds the per-position ceiling, and
 *    total deployment never exceeds the aggregate budget.
 *  - No borrowing: every allowed size is finite and non-negative, and the
 *    cohort never spends more than the budget it was granted — a NaN or
 *    negative size must not create capital.
 *  - Monotonic slot accounting: the open book, recomputed from the plan alone,
 *    never exceeds the cap, never strands a closed position, and raising the
 *    cap never admits fewer signals.
 *  - Consistent caps: every reported breach corresponds to a signal that was
 *    actually reduced, and the same caps bind identically in the baseline and
 *    in every grid cell.
 *
 * Failures print a copy-pasteable replay command via the shared seed contract.
 */

const FILE = "src/lib/__tests__/breakout-replay-invariants.fuzz.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

const EPS = 1e-9;

const day = (i: number) => {
  const d = new Date(Date.UTC(2024, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

type Row = { symbol: string; date: string; barsHeld: number; size: number };

/** A random cohort, occasionally poisoned with values the UI should never send. */
function randomRows(r: () => number, n: number, poison: boolean): Row[] {
  const symbols = 1 + Math.floor(r() * 12);
  const perDay = 1 + Math.floor(r() * 4);
  return Array.from({ length: n }, (_, i) => {
    let size = r() * 2.5;
    if (poison) {
      const p = r();
      if (p < 0.04) size = NaN;
      else if (p < 0.07) size = Infinity;
      else if (p < 0.09) size = -1 * r() * 5;
      else if (p < 0.11) size = 1e9;
    }
    return {
      symbol: `S${i % symbols}`,
      date: day(Math.floor(i / perDay)),
      barsHeld: 1 + Math.floor(r() * 14),
      size,
    };
  });
}

function randomLimits(r: () => number): SizingLimits {
  return resolveSizingLimits({
    maxPositionSize: 0.25 + r() * 2.5,
    maxConcurrentSignals: 1 + Math.floor(r() * 24),
    maxTotalDeployedPct: 10 + r() * 400,
  });
}


/** Random frictions, sometimes poisoned with values config should never hold. */
function randomCosts(r: () => number, poison: boolean): Costs {
  const c: Costs = {
    commissionBps: r() * 60,
    minFee: r() * 0.05,
    slippageBps: r() * 40,
  };
  if (poison) {
    const p = r();
    if (p < 0.12) c.commissionBps = NaN;
    else if (p < 0.2) c.slippageBps = Infinity;
    else if (p < 0.28) c.minFee = -r() * 5;
    else if (p < 0.34) c.minFee = 1e12;
    else if (p < 0.4) c.slippageBps = 20_000;
  }
  return c;
}

function randomTrades(r: () => number, n: number): SignalTrade[] {
  const regimes = ["bull", "bear", "sideways"] as const;
  const symbols = 2 + Math.floor(r() * 10);
  return Array.from({ length: n }, (_, i) => ({
    symbol: `S${i % symbols}`,
    date: day(Math.floor(i / 2)),
    cohort: r() < 0.72 ? "confirmed" : "failed",
    direction: r() < 0.5 ? "up" : "down",
    side: "long",
    regime: regimes[Math.floor(r() * 3)],
    realisedVol20d: r() < 0.05 ? null : 0.004 + r() * 0.04,
    atrPct: r() < 0.05 ? null : 0.008 + r() * 0.04,
    quality: r(),
    penetrationAtr: r() * 2.5,
    volumeRatio: r() < 0.05 ? null : 0.7 + r() * 1.5,
    falseBreakoutRate: r() * 0.6,
    ageBars: 1 + Math.floor(r() * 8),
    pendingLatencyBars: Math.floor(r() * 4),
    entry: 100,
    exit: 100 + (r() - 0.45) * 12,
    exitReason: r() < 0.5 ? "target" : "stop",
    barsHeld: 1 + Math.floor(r() * 12),
    returnPct: (r() - 0.45) * 12,
    maxAdversePct: -r() * 6,
    maxFavourablePct: r() * 6,
  })) as SignalTrade[];
}

/** Open-book occupancy recomputed from the plan output, never from the report. */
function occupancy(rows: readonly Row[], plan: LimitedPlan, cap: number) {
  const dates = [...new Set(rows.map((x) => x.date))].sort();
  const rank = new Map(dates.map((d, i) => [d, i]));
  const open: number[] = [];
  let peak = 0;
  let overAdmissions = 0;
  let taken = 0;
  plan.signals.forEach((s, i) => {
    const at = rank.get(s.date) ?? 0;
    for (let j = open.length - 1; j >= 0; j--) if (open[j] <= at) open.splice(j, 1);
    if (s.size > 0) {
      if (open.length >= cap) overAdmissions++;
      taken++;
      open.push(at + Math.max(1, rows[i].barsHeld));
      if (open.length > peak) peak = open.length;
    }
  });
  const stranded = open.filter((until) => until <= dates.length - 1).length;
  return { peak, stranded, overAdmissions, taken };
}

/**
 * Walk the plan as a cash ledger, step by step.
 *
 * The occupancy check counts slots; this one counts money. Model: the cohort
 * is granted `budget` units of cash (the aggregate deployment allowance).
 * Entering a position debits its allowed size from cash and credits that size
 * to the symbol's holding; the position is returned to cash when its hold
 * window closes. Sizes here are exposure multiples, so this is a purely
 * relative ledger — but the two rules it enforces are the real ones:
 *
 *  - cash never goes negative at any step (no borrowing to fund a signal),
 *  - no holding ever goes negative at any step (no implicit short or
 *    double-release of a position that was never opened).
 *
 * It also checks conservation (cash + holdings == budget at every step) and
 * that the book fully unwinds to all-cash once the last window closes, which
 * is what catches a release path that credits cash without debiting holdings.
 */
function assertLedger(rows: readonly Row[], plan: LimitedPlan, budget: number, ctx: string) {
  const dates = [...new Set(rows.map((x) => x.date))].sort();
  const rank = new Map(dates.map((d, i) => [d, i]));

  let cash = budget;
  const holdings = new Map<string, number>();
  const open: { until: number; symbol: string; size: number }[] = [];
  let minCash = cash;

  const release = (upTo: number) => {
    for (let j = open.length - 1; j >= 0; j--) {
      const pos = open[j];
      if (pos.until > upTo) continue;
      const held = holdings.get(pos.symbol) ?? 0;
      // Releasing more than is held would mean the ledger lost track of a
      // position — assert before mutating so the failure names the symbol.
      expect(held + EPS, `released more than held (${pos.symbol}): ${ctx}`).toBeGreaterThanOrEqual(pos.size);
      const next = held - pos.size;
      if (next <= EPS) holdings.delete(pos.symbol);
      else holdings.set(pos.symbol, next);
      cash += pos.size;
      open.splice(j, 1);
    }
  };

  plan.signals.forEach((s, i) => {
    const at = rank.get(s.date) ?? 0;
    release(at);

    if (s.size > 0) {
      // No borrowing: the debit must be affordable *before* it is applied.
      expect(cash + EPS, `cash would go negative funding ${s.symbol}: ${ctx}`).toBeGreaterThanOrEqual(s.size);
      cash -= s.size;
      holdings.set(s.symbol, (holdings.get(s.symbol) ?? 0) + s.size);
      open.push({ until: at + Math.max(1, rows[i].barsHeld), symbol: s.symbol, size: s.size });
    }

    if (cash < minCash) minCash = cash;

    // Step invariants: cash solvent, every holding long-only, nothing created
    // or destroyed.
    expect(cash, `negative cash at step ${i}: ${ctx}`).toBeGreaterThanOrEqual(-EPS);
    for (const [symbol, qty] of holdings) {
      expect(qty, `negative holding in ${symbol} at step ${i}: ${ctx}`).toBeGreaterThanOrEqual(-EPS);
    }
    const held = [...holdings.values()].reduce((a, b) => a + b, 0);
    expect(Math.abs(cash + held - budget), `ledger does not balance at step ${i}: ${ctx}`).toBeLessThan(1e-6);
    // No leverage: exposure on the book can never exceed the granted capital.
    expect(held, `holdings exceed capital at step ${i}: ${ctx}`).toBeLessThanOrEqual(budget + EPS);
  });

  // Unwind everything and confirm the book returns to all cash.
  release(Number.POSITIVE_INFINITY);
  expect(holdings.size, `holdings left open after unwind: ${ctx}`).toBe(0);
  expect(Math.abs(cash - budget), `cash did not return to capital: ${ctx}`).toBeLessThan(1e-6);

  return { minCash };
}

// ---------------------------------------------------------------------------
// Costed ledger: the same solvency rules once fees and slippage are charged
// ---------------------------------------------------------------------------

/**
 * Frictions charged on every fill. Deliberately crude — the point is not to
 * reproduce Saxo's fee schedule (that is tested in `saxo-fees`), it is that no
 * plausible cost model can push the replay into borrowing or a short holding.
 */
type Costs = {
  /** Proportional commission on notional, in basis points, per side. */
  commissionBps: number;
  /** Fixed ticket charge per side, in the ledger's exposure units. */
  minFee: number;
  /** Adverse price move on execution, in basis points, per side. */
  slippageBps: number;
};

/**
 * Costs arrive from config and backtest sweeps, so they get the same treatment
 * as sizes: a NaN or negative fee must degrade to "no cost", never to a credit.
 */
function sanitiseCosts(c: Costs): Costs {
  const clean = (v: number, max: number) =>
    !Number.isFinite(v) || v <= 0 ? 0 : Math.min(v, max);
  return {
    commissionBps: clean(c.commissionBps, 5_000),
    minFee: clean(c.minFee, 1e6),
    slippageBps: clean(c.slippageBps, 5_000),
  };
}

/** Cash needed to open `size`: the notional plus entry frictions. */
function entryCost(size: number, c: Costs) {
  const slip = (size * c.slippageBps) / 10_000;
  const commission = (size * c.commissionBps) / 10_000;
  return { slip, fee: commission + c.minFee, total: size + slip + commission + c.minFee };
}

/** Cash returned when `size` is closed: the notional less exit frictions. */
function exitProceeds(size: number, c: Costs) {
  const slip = (size * c.slippageBps) / 10_000;
  const commission = (size * c.commissionBps) / 10_000;
  const friction = Math.min(size, slip + commission + c.minFee);
  return { friction, proceeds: size - friction };
}

/**
 * Walk the plan as a cash ledger *with frictions charged at every step*.
 *
 * The uncosted ledger proves the sizing engine never spends more capital than
 * it was granted. This one proves the stronger, real-money version: once every
 * fill pays commission, a minimum ticket and slippage, the book still never
 * borrows and never goes short.
 *
 * Because `applySizingLimits` sizes positions without fee headroom, a cohort
 * that deploys its full budget genuinely cannot also pay the tickets. That is
 * not an engine bug, so the ledger models what a fee-aware executor must do:
 * scale the fill down to what cash can actually fund, and refuse it outright if
 * even the minimum ticket is unaffordable. The invariants then assert that this
 * fee-aware path is always well behaved:
 *
 *  - cash is never negative at any step, including the step that pays fees,
 *  - no holding is ever negative, and a close never releases more than is held,
 *  - the funded size never exceeds the size the sizing engine allowed, so costs
 *    can only shrink exposure, never manufacture it,
 *  - nothing is created or destroyed: cash + holdings + frictions paid always
 *    equals the granted capital,
 *  - the book fully unwinds, ending in cash equal to capital less total costs,
 *    and total costs never exceed capital.
 */
function assertCostedLedger(
  rows: readonly Row[],
  plan: LimitedPlan,
  budget: number,
  rawCosts: Costs,
  ctx: string,
) {
  const costs = sanitiseCosts(rawCosts);
  const dates = [...new Set(rows.map((x) => x.date))].sort();
  const rank = new Map(dates.map((d, i) => [d, i]));

  let cash = budget;
  let paid = 0;
  let funded = 0;
  let refused = 0;
  let minCash = cash;
  const holdings = new Map<string, number>();
  const open: { until: number; symbol: string; size: number }[] = [];

  const charge = (amount: number, what: string, step: number) => {
    expect(amount, `negative ${what} charge at step ${step}: ${ctx}`).toBeGreaterThanOrEqual(0);
    expect(cash + EPS, `cash would go negative paying ${what} at step ${step}: ${ctx}`).toBeGreaterThanOrEqual(
      amount,
    );
    cash -= amount;
    paid += amount;
  };

  const release = (upTo: number, step: number) => {
    for (let j = open.length - 1; j >= 0; j--) {
      const pos = open[j];
      if (pos.until > upTo) continue;
      const held = holdings.get(pos.symbol) ?? 0;
      expect(held + EPS, `released more than held (${pos.symbol}) at step ${step}: ${ctx}`).toBeGreaterThanOrEqual(
        pos.size,
      );
      const next = held - pos.size;
      if (next <= EPS) holdings.delete(pos.symbol);
      else holdings.set(pos.symbol, next);
      // Exit frictions come out of the proceeds, never out of thin air: the
      // position returns its notional to cash and immediately pays the cost.
      const { friction, proceeds } = exitProceeds(pos.size, costs);
      cash += pos.size;
      open.splice(j, 1);
      expect(proceeds, `exit proceeds went negative (${pos.symbol}) at step ${step}: ${ctx}`).toBeGreaterThanOrEqual(
        -EPS,
      );
      charge(friction, `exit friction on ${pos.symbol}`, step);
    }
  };

  plan.signals.forEach((s, i) => {
    const at = rank.get(s.date) ?? 0;
    release(at, i);

    if (s.size > 0) {
      // Fee-aware fill: shrink to what cash can fund, including entry costs.
      const perUnit = 1 + (costs.slippageBps + costs.commissionBps) / 10_000;
      const affordable = Math.max(0, (cash - costs.minFee) / perUnit);
      const size = Math.min(s.size, affordable);

      // Costs may only reduce the engine-allowed size.
      expect(size, `costed fill exceeds the allowed size at step ${i}: ${ctx}`).toBeLessThanOrEqual(
        s.size + EPS,
      );

      if (size > EPS) {
        const { slip, fee, total } = entryCost(size, costs);
        expect(cash + 1e-6, `entry unaffordable after sizing at step ${i}: ${ctx}`).toBeGreaterThanOrEqual(
          total,
        );
        cash -= size;
        holdings.set(s.symbol, (holdings.get(s.symbol) ?? 0) + size);
        charge(slip + fee, `entry friction on ${s.symbol}`, i);
        open.push({ until: at + Math.max(1, rows[i].barsHeld), symbol: s.symbol, size });
        funded++;
      } else {
        // Refused for want of cash — must leave the book untouched.
        refused++;
      }
    }

    if (cash < minCash) minCash = cash;

    expect(cash, `negative cash at step ${i}: ${ctx}`).toBeGreaterThanOrEqual(-EPS);
    for (const [symbol, qty] of holdings) {
      expect(qty, `negative holding in ${symbol} at step ${i}: ${ctx}`).toBeGreaterThanOrEqual(-EPS);
    }
    const held = [...holdings.values()].reduce((a, b) => a + b, 0);
    expect(held, `holdings exceed capital at step ${i}: ${ctx}`).toBeLessThanOrEqual(budget + EPS);
    // Conservation with costs: capital is either in cash, on the book, or spent.
    expect(
      Math.abs(cash + held + paid - budget),
      `costed ledger does not balance at step ${i}: ${ctx}`,
    ).toBeLessThan(1e-6);
  });

  release(Number.POSITIVE_INFINITY, plan.signals.length);
  expect(holdings.size, `holdings left open after unwind: ${ctx}`).toBe(0);
  expect(cash, `terminal cash negative: ${ctx}`).toBeGreaterThanOrEqual(-EPS);
  expect(paid, `costs exceed capital: ${ctx}`).toBeLessThanOrEqual(budget + 1e-6);
  expect(Math.abs(cash + paid - budget), `capital lost after unwind: ${ctx}`).toBeLessThan(1e-6);
  // Frictions are a pure drag: terminal cash can never beat the starting bank.
  expect(cash, `costs increased terminal cash: ${ctx}`).toBeLessThanOrEqual(budget + EPS);

  return { minCash, paid, funded, refused, terminalCash: cash, costs };
}




/** Every invariant that must hold for a single limited plan. */
function assertPlanInvariants(rows: readonly Row[], limits: SizingLimits, ctx: string) {
  const plan = applySizingLimits(rows, limits);
  const cap = limits.maxConcurrentSignals;

  expect(plan.signals.length, `plan dropped signals: ${ctx}`).toBe(rows.length);

  let spent = 0;
  for (const s of plan.signals) {
    // No borrowing: a size must be a real, non-negative number even when the
    // request was NaN, -Infinity or absurd.
    expect(Number.isFinite(s.size), `non-finite size: ${ctx}`).toBe(true);
    expect(s.size, `negative size: ${ctx}`).toBeGreaterThanOrEqual(0);
    // No leverage: the per-position ceiling is absolute.
    expect(s.size, `position above ceiling: ${ctx}`).toBeLessThanOrEqual(limits.maxPositionSize + EPS);
    // A size may only shrink relative to the (sanitised) request.
    if (Number.isFinite(s.requestedSize)) {
      expect(s.size, `allowed more than requested: ${ctx}`).toBeLessThanOrEqual(s.requestedSize + EPS);
    }
    // Consistent caps: a clamp label means the size actually moved (or was
    // refused outright), never a cosmetic annotation.
    if (s.clamped.length > 0) {
      expect(s.size, `clamp label without reduction: ${ctx}`).toBeLessThan(s.requestedSize + EPS);
    }
    spent += s.size;
  }

  // No borrowing in aggregate: the cohort's budget is a hard ceiling.
  const budget = (rows.length * limits.maxTotalDeployedPct) / 100;
  expect(spent, `spent past the budget: ${ctx}`).toBeLessThanOrEqual(budget + EPS);
  expect(plan.report.deployedPct, `deployment above budget: ${ctx}`).toBeLessThanOrEqual(
    limits.maxTotalDeployedPct + 1e-6,
  );

  // Slot accounting, recomputed independently.
  const occ = occupancy(rows, plan, cap);
  expect(occ.overAdmissions, `admitted past a full book: ${ctx}`).toBe(0);
  expect(occ.stranded, `stranded slots: ${ctx}`).toBe(0);
  expect(occ.peak, `peak over cap: ${ctx}`).toBeLessThanOrEqual(cap);
  expect(plan.report.peakConcurrent, `report disagrees with plan: ${ctx}`).toBe(occ.peak);
  expect(plan.report.peakPositionSize, `peak size over ceiling: ${ctx}`).toBeLessThanOrEqual(
    limits.maxPositionSize + EPS,
  );

  // Breach counts must equal the labels actually attached to signals.
  for (const reason of ["position", "concurrency", "budget"] as const) {
    const labelled = plan.signals.filter((s) => s.clamped.includes(reason)).length;
    expect(plan.report.breaches[reason], `${reason} breach count mismatch: ${ctx}`).toBe(labelled);
  }

  // Cash and holdings, walked step by step.
  const ledger = assertLedger(rows, plan, budget, ctx);

  return { plan, taken: occ.taken, minCash: ledger.minCash, budget };
}

// ---------------------------------------------------------------------------
// Counterexample minimization
// ---------------------------------------------------------------------------

type Case = { rows: Row[]; limits: SizingLimits };

/** Simpler versions of a failing case, cheapest structural wins first. */
function shrinkCase(c: Case): Case[] {
  const out: Case[] = [];

  // 1. Fewer signals — by far the biggest readability win.
  for (const rows of shrinkList(c.rows)) out.push({ ...c, rows });

  // 2. Plainer caps.
  for (const v of shrinkNumber(c.limits.maxPositionSize, { min: 0.01 })) {
    out.push({ ...c, limits: resolveSizingLimits({ ...c.limits, maxPositionSize: v }) });
  }
  for (const v of shrinkNumber(c.limits.maxConcurrentSignals, { min: 1, integer: true })) {
    out.push({ ...c, limits: resolveSizingLimits({ ...c.limits, maxConcurrentSignals: v }) });
  }
  for (const v of shrinkNumber(c.limits.maxTotalDeployedPct, { min: 1 })) {
    out.push({ ...c, limits: resolveSizingLimits({ ...c.limits, maxTotalDeployedPct: v }) });
  }

  // 3. Plainer rows: flatten hold windows, round sizes, collapse symbols.
  if (c.rows.some((x) => x.barsHeld !== 1)) {
    out.push({ ...c, rows: c.rows.map((x) => ({ ...x, barsHeld: 1 })) });
  }
  if (c.rows.some((x) => Number.isFinite(x.size) && x.size !== Number(x.size.toFixed(2)))) {
    out.push({
      ...c,
      rows: c.rows.map((x) => ({ ...x, size: Number.isFinite(x.size) ? Number(x.size.toFixed(2)) : x.size })),
    });
  }
  if (new Set(c.rows.map((x) => x.symbol)).size > 1) {
    out.push({ ...c, rows: c.rows.map((x) => ({ ...x, symbol: "S0" })) });
  }

  // 4. Per-row size simplification, only once the cohort is small enough to read.
  if (c.rows.length <= 12) {
    c.rows.forEach((row, i) => {
      const swap = (size: number) => ({
        ...c,
        rows: c.rows.map((x, j) => (j === i ? { ...x, size } : x)),
      });
      if (!Number.isFinite(row.size)) out.push(swap(1));
      else for (const v of shrinkNumber(row.size, { min: 0 })) out.push(swap(v));
    });
  }

  return out;
}

function describeCase(c: Case): string {
  const rows =
    c.rows.length <= 10
      ? c.rows.map((x) => `  { ${x.symbol} ${x.date} bars=${x.barsHeld} size=${x.size} }`).join("\n")
      : `  …${c.rows.length} rows (first 6)\n` +
        c.rows
          .slice(0, 6)
          .map((x) => `  { ${x.symbol} ${x.date} bars=${x.barsHeld} size=${x.size} }`)
          .join("\n");
  return [
    `rows: ${c.rows.length}`,
    rows,
    `limits: position<=${c.limits.maxPositionSize}, concurrent<=${c.limits.maxConcurrentSignals}, deployed<=${c.limits.maxTotalDeployedPct}%`,
  ].join("\n");
}

/**
 * Run every plan invariant; on failure, shrink the cohort and caps down to the
 * smallest case that still breaks the *same* invariant, and report that instead
 * of the random haystack. The seed line still reproduces the original run.
 */
function verifyPlan(rows: readonly Row[], limits: SizingLimits, ctx: string) {
  try {
    // Happy path stays single-pass: minimization only costs anything on failure.
    return assertPlanInvariants(rows, limits, ctx);
  } catch {
    const check = (c: Case) => attempt(() => assertPlanInvariants(c.rows, c.limits, ctx));
    expectNoCounterexample({ rows: [...rows], limits }, check, shrinkCase, describeCase, ctx);
    // Unreachable: the case failed above, so the minimizer always fails too.
    throw new Error(`non-deterministic invariant failure: ${ctx}`);
  }
}

const CASES = 400;


describe("replay invariants (property-based)", () => {
  it(`holds across ${CASES} random cohorts and cap sets`, () => {
    for (let i = 0; i < CASES; i++) {
      const r = rng(caseSeed(BASE_SEED, "plan", i));
      const rows = randomRows(r, 1 + Math.floor(r() * 300), r() < 0.4);
      const limits = randomLimits(r);
      verifyPlan(rows, limits, `case ${i} — ${REPRO}`);
    }
  });

  it("cash stays solvent and holdings stay long-only under starved budgets", () => {
    // The stress shape for the ledger: a tiny budget against oversized,
    // partly poisoned requests and long overlapping holds, so partial fills
    // and refusals happen constantly and any off-by-one in the release path
    // shows up as negative cash or a negative holding.
    for (let i = 0; i < 120; i++) {
      const r = rng(caseSeed(BASE_SEED, "ledger", i));
      const rows = randomRows(r, 20 + Math.floor(r() * 220), true).map((row) => ({
        ...row,
        barsHeld: 3 + Math.floor(r() * 25),
      }));
      const limits = resolveSizingLimits({
        maxPositionSize: 0.5 + r() * 2,
        maxConcurrentSignals: 1 + Math.floor(r() * 8),
        // Deliberately starved: often far less capital than the cohort asks for.
        maxTotalDeployedPct: 1 + r() * 40,
      });
      const { minCash, budget } = verifyPlan(rows, limits, `ledger case ${i} — ${REPRO}`);
      expect(minCash, `cash dipped below zero (case ${i}) — ${REPRO}`).toBeGreaterThanOrEqual(-EPS);
      expect(minCash, `cash exceeded capital (case ${i}) — ${REPRO}`).toBeLessThanOrEqual(budget + EPS);
    }
  });



  it("slot admission is monotonic in the concurrency cap", () => {
    for (let i = 0; i < 60; i++) {
      const r = rng(caseSeed(BASE_SEED, "monotone", i));
      const rows = randomRows(r, 40 + Math.floor(r() * 200), r() < 0.3);
      // Budget out of the way so concurrency is the only binding constraint.
      const base = { maxPositionSize: 1 + r(), maxTotalDeployedPct: 100_000 };
      let previous = -1;
      for (const cap of [1, 2, 3, 5, 8, 13, 21, 34]) {
        const limits = resolveSizingLimits({ ...base, maxConcurrentSignals: cap });
        const { taken } = verifyPlan(rows, limits, `case ${i} cap ${cap} — ${REPRO}`);
        expect(taken, `cap ${cap} admitted fewer than a tighter cap (case ${i}) — ${REPRO}`).toBeGreaterThanOrEqual(
          previous,
        );
        previous = taken;
      }
    }
  });

  it("deployment is monotonic in the budget and the position ceiling", () => {
    for (let i = 0; i < 60; i++) {
      const r = rng(caseSeed(BASE_SEED, "budget", i));
      const rows = randomRows(r, 40 + Math.floor(r() * 160), false);
      const cap = 4 + Math.floor(r() * 12);

      let prevBudget = -1;
      for (const pct of [10, 25, 50, 100, 200, 400]) {
        const limits = resolveSizingLimits({
          maxPositionSize: 1.5,
          maxConcurrentSignals: cap,
          maxTotalDeployedPct: pct,
        });
        const { plan } = verifyPlan(rows, limits, `case ${i} budget ${pct} — ${REPRO}`);
        expect(plan.report.deployedPct, `budget ${pct} deployed less than a tighter one — ${REPRO}`).toBeGreaterThanOrEqual(
          prevBudget - 1e-6,
        );
        prevBudget = plan.report.deployedPct;
      }

      let prevCeiling = -1;
      for (const ceiling of [0.25, 0.5, 1, 1.5, 2.5]) {
        const limits = resolveSizingLimits({
          maxPositionSize: ceiling,
          maxConcurrentSignals: cap,
          maxTotalDeployedPct: 100_000,
        });
        const { plan } = verifyPlan(rows, limits, `case ${i} ceiling ${ceiling} — ${REPRO}`);
        expect(plan.report.deployedPct, `ceiling ${ceiling} deployed less than a tighter one — ${REPRO}`).toBeGreaterThanOrEqual(
          prevCeiling - 1e-6,
        );
        prevCeiling = plan.report.deployedPct;
      }
    }
  });

  it("driver replay respects the same caps at every risk and gap weight", () => {
    for (let i = 0; i < 40; i++) {
      const r = rng(caseSeed(BASE_SEED, "driver", i));
      const trades = randomTrades(r, 30 + Math.floor(r() * 200));
      const limits = randomLimits(r);
      const risk = RISK_LEVELS[Math.floor(r() * RISK_LEVELS.length)] as RiskLevel;
      const gapWeight = Math.round(r() * 6);
      const ctx = `case ${i} ${risk}@${gapWeight} — ${REPRO}`;

      const s = applyDriverSizing(trades, { risk, gapWeight, limits });
      expect(s.taken, `took more than the cohort: ${ctx}`).toBeLessThanOrEqual(s.signals);
      expect(s.taken + s.skipped, `taken+skipped != signals: ${ctx}`).toBe(s.signals);
      expect(s.limits.peakConcurrent, `peak concurrency over cap: ${ctx}`).toBeLessThanOrEqual(
        limits.maxConcurrentSignals,
      );
      expect(s.limits.peakPositionSize, `position over ceiling: ${ctx}`).toBeLessThanOrEqual(
        limits.maxPositionSize + EPS,
      );
      expect(s.deployedPct, `deployment over budget: ${ctx}`).toBeLessThanOrEqual(
        limits.maxTotalDeployedPct + 1e-6,
      );
      expect(s.avgSize, `negative average size: ${ctx}`).toBeGreaterThanOrEqual(0);
      for (const v of [s.cumulativeReturnPct, s.maxDrawdownPct, s.avgReturnPct, s.expectancyPct]) {
        expect(Number.isFinite(v), `non-finite metric: ${ctx}`).toBe(true);
      }
      // Drawdown is a loss measure: never positive.
      expect(s.maxDrawdownPct, `positive drawdown: ${ctx}`).toBeLessThanOrEqual(EPS);
      // A fully skipped cohort must be flat, never profitable by omission.
      if (s.taken === 0) expect(s.cumulativeReturnPct, `return without trades: ${ctx}`).toBe(0);
    }
  });

  it("every grid cell obeys the caps across random grid sizes", () => {
    for (let i = 0; i < 20; i++) {
      const r = rng(caseSeed(BASE_SEED, "grid", i));
      const trades = randomTrades(r, 40 + Math.floor(r() * 160));
      const limits = randomLimits(r);
      const risks = [...RISK_LEVELS].slice(0, 1 + Math.floor(r() * RISK_LEVELS.length)) as RiskLevel[];
      const gapWeights = Array.from({ length: 1 + Math.floor(r() * 6) }, (_, k) => k);
      const grid = buildExecutionGrid(trades, { risks, gapWeights, limits });
      const baseline = baselineExecution(trades, limits);

      expect(grid.cells.length, `grid size mismatch (case ${i}) — ${REPRO}`).toBe(
        risks.length * gapWeights.length,
      );
      for (const cell of grid.cells) {
        const ctx = `case ${i} ${cell.risk}@${cell.gapWeight} — ${REPRO}`;
        expect(cell.limits.peakConcurrent, `peak concurrency over cap: ${ctx}`).toBeLessThanOrEqual(
          limits.maxConcurrentSignals,
        );
        expect(cell.limits.peakPositionSize, `position over ceiling: ${ctx}`).toBeLessThanOrEqual(
          limits.maxPositionSize + EPS,
        );
        expect(cell.deployedPct, `deployment over budget: ${ctx}`).toBeLessThanOrEqual(
          limits.maxTotalDeployedPct + 1e-6,
        );
        // The baseline is the shared control: it must feel the same caps.
        expect(cell.signals, `cell/baseline cohort mismatch: ${ctx}`).toBe(baseline.signals);
        expect(
          Math.abs(cell.vsBaseline.cumulativeReturnPp - (cell.cumulativeReturnPct - baseline.cumulativeReturnPct)),
          `baseline delta inconsistent: ${ctx}`,
        ).toBeLessThan(1e-6);
      }
      if (grid.best) {
        const best = Math.max(...grid.cells.filter((c) => c.taken > 0).map((c) => c.cumulativeReturnPct));
        expect(grid.best.cumulativeReturnPct, `best cell is not the best (case ${i}) — ${REPRO}`).toBe(best);
      }
    }
  });

  it("keeps cash and holdings non-negative once fees and slippage are charged", () => {
    // Same solvency properties as the uncosted ledger, but every fill now pays
    // commission, a fixed ticket and slippage on entry *and* exit.
    for (let i = 0; i < 200; i++) {
      const r = rng(caseSeed(BASE_SEED, "costed", i));
      const rows = randomRows(r, 5 + Math.floor(r() * 200), r() < 0.35);
      const limits = randomLimits(r);
      const costs = randomCosts(r, r() < 0.3);
      const ctx = `costed case ${i} — ${REPRO}`;

      const plan = applySizingLimits(rows, limits);
      const budget = (rows.length * limits.maxTotalDeployedPct) / 100;
      const led = assertCostedLedger(rows, plan, budget, costs, ctx);

      expect(led.minCash, `cash dipped below zero: ${ctx}`).toBeGreaterThanOrEqual(-EPS);
      expect(led.paid, `frictions went negative: ${ctx}`).toBeGreaterThanOrEqual(0);
      expect(led.funded + led.refused, `fills unaccounted for: ${ctx}`).toBe(
        plan.signals.filter((s) => s.size > 0).length,
      );
    }
  });

  it("stays solvent when frictions dominate the budget", () => {
    // The stress shape for costs: a starved budget against a large minimum
    // ticket and punitive slippage, so most fills are shrunk or refused and any
    // path that charges a fee it cannot fund shows up as negative cash.
    for (let i = 0; i < 120; i++) {
      const r = rng(caseSeed(BASE_SEED, "costed-starved", i));
      const rows = randomRows(r, 20 + Math.floor(r() * 180), true).map((row) => ({
        ...row,
        barsHeld: 3 + Math.floor(r() * 20),
      }));
      const limits = resolveSizingLimits({
        maxPositionSize: 0.5 + r() * 2,
        maxConcurrentSignals: 1 + Math.floor(r() * 8),
        maxTotalDeployedPct: 1 + r() * 30,
      });
      const budget = (rows.length * limits.maxTotalDeployedPct) / 100;
      const costs: Costs = {
        commissionBps: 50 + r() * 400,
        // A ticket charge that is a meaningful fraction of the whole bank.
        minFee: (budget / (2 + r() * 8)) * (r() < 0.5 ? 1 : 0.25),
        slippageBps: 100 + r() * 900,
      };
      const ctx = `friction-dominated case ${i} — ${REPRO}`;

      const plan = applySizingLimits(rows, limits);
      const led = assertCostedLedger(rows, plan, budget, costs, ctx);

      expect(led.minCash, `cash dipped below zero: ${ctx}`).toBeGreaterThanOrEqual(-EPS);
      // Costs are a drag, never a windfall.
      expect(led.terminalCash, `terminal cash above capital: ${ctx}`).toBeLessThanOrEqual(budget + EPS);
      expect(led.paid, `costs exceeded capital: ${ctx}`).toBeLessThanOrEqual(budget + 1e-6);
    }
  });

  it("charges more and funds no more as frictions rise", () => {
    // Monotonicity: raising costs can only make the book smaller and poorer.
    for (let i = 0; i < 40; i++) {
      const r = rng(caseSeed(BASE_SEED, "costed-monotone", i));
      const rows = randomRows(r, 40 + Math.floor(r() * 120), false);
      const limits = randomLimits(r);
      const plan = applySizingLimits(rows, limits);
      const budget = (rows.length * limits.maxTotalDeployedPct) / 100;

      let prevFunded = Number.POSITIVE_INFINITY;
      let prevTerminal = Number.POSITIVE_INFINITY;
      for (const bps of [0, 5, 25, 100, 400, 1500]) {
        const ctx = `monotone case ${i} @ ${bps}bps — ${REPRO}`;
        const led = assertCostedLedger(
          rows,
          plan,
          budget,
          { commissionBps: bps, minFee: 0, slippageBps: bps },
          ctx,
        );
        expect(led.funded, `higher costs funded more fills: ${ctx}`).toBeLessThanOrEqual(prevFunded);
        expect(led.terminalCash, `higher costs left more cash: ${ctx}`).toBeLessThanOrEqual(
          prevTerminal + 1e-6,
        );
        prevFunded = led.funded;
        prevTerminal = led.terminalCash;
      }
    }
  });

  it("treats poisoned cost inputs as zero cost, never as a credit", () => {
    const r = rng(caseSeed(BASE_SEED, "costed-poison", 0));
    const rows = randomRows(r, 80, false);
    const limits = randomLimits(r);
    const plan = applySizingLimits(rows, limits);
    const budget = (rows.length * limits.maxTotalDeployedPct) / 100;

    const free = assertCostedLedger(
      rows,
      plan,
      budget,
      { commissionBps: 0, minFee: 0, slippageBps: 0 },
      `free — ${REPRO}`,
    );
    expect(free.paid, `zero-cost run charged something — ${REPRO}`).toBeLessThan(1e-9);

    for (const bad of [
      { commissionBps: NaN, minFee: NaN, slippageBps: NaN },
      { commissionBps: -100, minFee: -5, slippageBps: -100 },
      { commissionBps: Number.NEGATIVE_INFINITY, minFee: -0, slippageBps: -0 },
    ] as Costs[]) {
      const led = assertCostedLedger(rows, plan, budget, bad, `poisoned ${JSON.stringify(bad)} — ${REPRO}`);
      expect(led.paid, `poisoned costs charged something — ${REPRO}`).toBeLessThan(1e-9);
      expect(led.funded, `poisoned costs changed funding — ${REPRO}`).toBe(free.funded);
      expect(led.terminalCash, `poisoned costs created cash — ${REPRO}`).toBeLessThanOrEqual(budget + EPS);
    }
  });

  it("is deterministic for a fixed seed", () => {
    const build = () => {
      const r = rng(caseSeed(BASE_SEED, "determinism", 0));
      const rows = randomRows(r, 250, true);
      const limits = randomLimits(r);
      return applySizingLimits(rows, limits);
    };
    expect(JSON.stringify(build()), `replay is not deterministic — ${REPRO}`).toBe(JSON.stringify(build()));
  });
});
