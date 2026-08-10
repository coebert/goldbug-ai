import { describe, expect, it } from "vitest";
import {
  applySizingLimits,
  resolveSizingLimits,
  type LimitedPlan,
  type SizingLimits,
} from "@/lib/breakout-sizing-limits";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Cost *timing* reconciliation: when frictions are deducted vs what the
 * summary says was paid.
 *
 * The existing ledger suites prove the grand totals tie out. Totals alone are
 * blind to a whole class of real bugs, because a fee booked on the wrong step
 * still sums to the same number at the end:
 *
 *   • an exit fee deferred to the next signal — cash reads high for a step,
 *     so the next fill is sized against money that has already been spent;
 *   • an entry fee pre-charged on the previous step — cash reads low, so a
 *     fundable order is refused;
 *   • entry and exit frictions netted into one booking at close — the whole
 *     holding period misreports available cash;
 *   • slippage folded into the commission line — the totals match but the
 *     fee/slippage split reported in the summary is wrong.
 *
 * So this file asserts three things beyond the totals:
 *
 *   1. Every friction in the per-step journal is booked on exactly the step
 *      of the fill that incurred it (entry at its own signal, exit on the
 *      step that releases the position), derived independently of the engine.
 *   2. Cash after every step equals capital − open notional − frictions
 *      booked *up to and including* that step. This is what makes timing
 *      observable: a one-step shift changes this identity even though the
 *      final total is untouched.
 *   3. The summary's costed-fill amounts — total fees, total slippage, their
 *      sum, and the per-side breakdown — equal the journal reconstruction
 *      exactly, in integer micro-units, with no tolerance window.
 *
 * Each property carries a negative control that shifts a booking in time
 * while preserving the total, proving the check has teeth.
 */

const FILE = "src/lib/__tests__/breakout-cost-timing-reconciliation.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

// The costed replay engine, the money quantisation and the fuzz generators
// live in the shared harness so every ledger suite reconciles the same engine.


// ---------------------------------------------------------------------------
// Independent reconstructions (never read from `summary`)
// ---------------------------------------------------------------------------

function totalsFromJournal(journal: readonly CostLeg[]) {
  return journal.reduce(
    (a, l) => ({
      fee: a.fee + l.feeMicros,
      slip: a.slip + l.slipMicros,
      total: a.total + l.feeMicros + l.slipMicros,
      entryFee: a.entryFee + (l.side === "entry" ? l.feeMicros : 0),
      entrySlip: a.entrySlip + (l.side === "entry" ? l.slipMicros : 0),
      exitFee: a.exitFee + (l.side === "exit" ? l.feeMicros : 0),
      exitSlip: a.exitSlip + (l.side === "exit" ? l.slipMicros : 0),
    }),
    { fee: 0, slip: 0, total: 0, entryFee: 0, entrySlip: 0, exitFee: 0, exitSlip: 0 },
  );
}

/**
 * The step each open position must be released on, derived from the plan
 * alone: the first later step whose date rank reaches the release rank, or
 * the terminal unwind step if none does.
 */
function expectedExitStep(replay: Replay, plan: LimitedPlan, fill: Replay["fills"][number]): number {
  for (let i = fill.fillStep + 1; i < plan.signals.length; i++) {
    const rank = replay.dateRank.get(plan.signals[i].date) ?? 0;
    if (rank >= fill.releaseRank) return i;
  }
  return plan.signals.length;
}

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

/** (3) Summary cost fields equal the journal reconstruction, exactly. */
function assertSummaryMatchesJournal(replay: Replay, ctx: string) {
  const j = totalsFromJournal(replay.journal);
  const s = replay.summary;
  expect(s.totalFeeMicros, `total fee mismatch: ${ctx}`).toBe(j.fee);
  expect(s.totalSlipMicros, `total slippage mismatch: ${ctx}`).toBe(j.slip);
  expect(s.totalCostMicros, `total cost mismatch: ${ctx}`).toBe(j.total);
  expect(s.entryFeeMicros, `entry fee mismatch: ${ctx}`).toBe(j.entryFee);
  expect(s.entrySlipMicros, `entry slippage mismatch: ${ctx}`).toBe(j.entrySlip);
  expect(s.exitFeeMicros, `exit fee mismatch: ${ctx}`).toBe(j.exitFee);
  expect(s.exitSlipMicros, `exit slippage mismatch: ${ctx}`).toBe(j.exitSlip);
  // The split must partition the whole, so slippage cannot hide in the fee line.
  expect(j.entryFee + j.exitFee, `fee split does not partition: ${ctx}`).toBe(j.fee);
  expect(j.entrySlip + j.exitSlip, `slippage split does not partition: ${ctx}`).toBe(j.slip);
}

/** (2) Cash identity at every step — this is what detects a shifted booking. */
function assertStepCashIdentity(replay: Replay, ctx: string) {
  for (const t of replay.trace) {
    // Cumulative cost is derived from the journal legs themselves, not read
    // off the trace, so a charge that slides to a neighbouring step shows up
    // here even if the trace's own running total slid with it.
    const bookedByNow = replay.journal
      .filter((l) => l.step <= t.step)
      .reduce((a, l) => a + l.feeMicros + l.slipMicros, 0);
    expect(t.cumulativeCostMicros, `running cost total drifted from the journal at step ${t.step}: ${ctx}`).toBe(
      bookedByNow,
    );
    expect(
      t.cashMicros,
      `cash at step ${t.step} does not equal capital − open notional − costs booked so far: ${ctx}`,
    ).toBe(replay.capitalMicros - t.openNotionalMicros - bookedByNow);
    expect(t.cashMicros, `negative cash at step ${t.step}: ${ctx}`).toBeGreaterThanOrEqual(0);
  }
}


/** (1) Every leg sits on the step of the fill that incurred it. */
function assertBookingTiming(replay: Replay, plan: LimitedPlan, ctx: string) {
  const entries = replay.journal.filter((l) => l.side === "entry");
  const exits = replay.journal.filter((l) => l.side === "exit");

  for (const leg of entries) {
    expect(leg.step, `entry friction booked away from its fill: ${ctx}`).toBe(leg.fillStep);
  }
  // Exactly one entry leg and one exit leg per funded fill, in fill order.
  expect(entries.length, `entry legs != funded fills: ${ctx}`).toBe(replay.fills.length);
  expect(exits.length, `exit legs != funded fills: ${ctx}`).toBe(replay.fills.length);
  expect(entries.map((l) => l.fillStep), `entry legs out of fill order: ${ctx}`).toEqual(
    replay.fills.map((f) => f.fillStep),
  );

  const exitByFill = new Map(exits.map((l) => [l.fillStep, l]));
  for (const fill of replay.fills) {
    const leg = exitByFill.get(fill.fillStep);
    expect(leg, `no exit friction booked for fill ${fill.fillStep}: ${ctx}`).toBeDefined();
    expect(leg!.step, `exit friction booked on the wrong step: ${ctx}`).toBe(
      expectedExitStep(replay, plan, fill),
    );
    expect(leg!.step, `exit friction booked before its entry: ${ctx}`).toBeGreaterThan(fill.fillStep);
  }

  // A step with no fill can never move the cost total.
  const active = new Set<number>(replay.journal.map((l) => l.step));
  let prev = 0;
  for (const t of replay.trace) {
    if (!active.has(t.step)) {
      expect(
        t.cumulativeCostMicros,
        `costs moved on step ${t.step} which had no fill: ${ctx}`,
      ).toBe(prev);
    }
    expect(t.cumulativeCostMicros, `costs went backwards at step ${t.step}: ${ctx}`).toBeGreaterThanOrEqual(prev);
    prev = t.cumulativeCostMicros;
  }
  expect(prev, `final cumulative cost != summary total: ${ctx}`).toBe(replay.summary.totalCostMicros);
}

/** Conservation, stated in cost terms: nothing is created by the fee model. */
function assertCostConservation(replay: Replay, ctx: string) {
  expect(
    replay.summary.terminalCashMicros + replay.summary.totalCostMicros,
    `capital not conserved after unwind: ${ctx}`,
  ).toBe(replay.capitalMicros);
  expect(replay.summary.totalCostMicros, `costs exceed capital: ${ctx}`).toBeLessThanOrEqual(
    replay.capitalMicros,
  );
  expect(replay.summary.terminalCashMicros, `costs increased terminal cash: ${ctx}`).toBeLessThanOrEqual(
    replay.capitalMicros,
  );
}

function buildCase(seed: number) {
  const r = rng(seed);
  const rows = randomRows(r, 25 + Math.floor(r() * 55));
  const limits = randomLimits(r);
  const costs = randomCosts(r);
  const capital = 1 + r() * 40;
  const plan = applySizingLimits(rows, limits);
  return { rows, plan, costs, capital, replay: runCostedReplay(rows, plan, capital, costs) };
}

// ---------------------------------------------------------------------------

describe("fee/slippage deduction timing vs replay summary totals", () => {
  it("books every friction on the step of the fill that incurred it", () => {
    for (let c = 0; c < 120; c++) {
      const seed = caseSeed(BASE_SEED, "timing", c);
      const { plan, replay } = buildCase(seed);
      assertBookingTiming(replay, plan, `seed=${seed} · ${REPRO}`);
    }
  });

  it("keeps cash equal to capital minus open notional minus costs booked so far", () => {
    for (let c = 0; c < 120; c++) {
      const seed = caseSeed(BASE_SEED, "cash-identity", c);
      const { replay } = buildCase(seed);
      assertStepCashIdentity(replay, `seed=${seed} · ${REPRO}`);
    }
  });

  it("reports summary cost totals exactly equal to the journal legs", () => {
    for (let c = 0; c < 150; c++) {
      const seed = caseSeed(BASE_SEED, "summary-totals", c);
      const { replay } = buildCase(seed);
      const ctx = `seed=${seed} · ${REPRO}`;
      assertSummaryMatchesJournal(replay, ctx);
      assertCostConservation(replay, ctx);
    }
  });

  it("matches the summary when costs are charged on one side only, or not at all", () => {
    const variants: Array<[string, Costs]> = [
      ["zero cost", { commissionBps: 0, minFee: 0, slippageBps: 0 }],
      ["slippage only", { commissionBps: 0, minFee: 0, slippageBps: 25 }],
      ["commission only", { commissionBps: 12, minFee: 0, slippageBps: 0 }],
      ["ticket only", { commissionBps: 0, minFee: 0.05, slippageBps: 0 }],
      ["punitive", { commissionBps: 400, minFee: 0.5, slippageBps: 350 }],
    ];
    for (const [label, costs] of variants) {
      for (let c = 0; c < 25; c++) {
        const seed = caseSeed(BASE_SEED, "cost-variants", c);
        const r = rng(seed);
        const rows = randomRows(r, 30 + Math.floor(r() * 30));
        const plan = applySizingLimits(rows, randomLimits(r));
        const capital = 2 + r() * 30;
        const replay = runCostedReplay(rows, plan, capital, costs);
        const ctx = `${label} · seed=${seed} · ${REPRO}`;
        assertBookingTiming(replay, plan, ctx);
        assertStepCashIdentity(replay, ctx);
        assertSummaryMatchesJournal(replay, ctx);
        assertCostConservation(replay, ctx);
        if (label === "zero cost") {
          expect(replay.summary.totalCostMicros, `zero-cost run charged something: ${ctx}`).toBe(0);
          expect(replay.summary.terminalCashMicros, `zero-cost run lost capital: ${ctx}`).toBe(
            replay.capitalMicros,
          );
        }
        if (label === "slippage only") {
          expect(replay.summary.totalFeeMicros, `slippage leaked into fees: ${ctx}`).toBe(0);
        }
        if (label === "commission only" || label === "ticket only") {
          expect(replay.summary.totalSlipMicros, `fees leaked into slippage: ${ctx}`).toBe(0);
        }
      }
    }
  });

  it("charges exactly two legs per funded fill and none per refused signal", () => {
    for (let c = 0; c < 80; c++) {
      const seed = caseSeed(BASE_SEED, "leg-count", c);
      const { replay } = buildCase(seed);
      const ctx = `seed=${seed} · ${REPRO}`;
      expect(replay.journal.length, `leg count != 2 per fill: ${ctx}`).toBe(replay.summary.filledCount * 2);
      const perFill = new Map<number, number>();
      for (const l of replay.journal) perFill.set(l.fillStep, (perFill.get(l.fillStep) ?? 0) + 1);
      for (const [fillStep, n] of perFill) {
        expect(n, `fill ${fillStep} charged ${n} legs: ${ctx}`).toBe(2);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Negative controls: same grand total, wrong timing. Each must be caught.
  // -------------------------------------------------------------------------

  const findMutableCase = () => {
    for (let c = 0; c < 400; c++) {
      const seed = caseSeed(BASE_SEED, "controls", c);
      const built = buildCase(seed);
      const hasCost = built.replay.journal.some((l) => l.feeMicros + l.slipMicros > 0);
      const hasExit = built.replay.journal.some(
        (l) => l.side === "exit" && l.step < built.plan.signals.length,
      );
      if (hasCost && hasExit && built.replay.trace.length > 3) return { ...built, seed };
    }
    throw new Error(`no mutable case found · ${REPRO}`);
  };

  it("catches a friction deferred to the next step even though the total is unchanged", () => {
    const { replay, plan, seed } = findMutableCase();
    const idx = replay.journal.findIndex(
      (l) => l.feeMicros + l.slipMicros > 0 && l.step < replay.trace.length - 2,
    );
    expect(idx, `no shiftable leg · seed=${seed}`).toBeGreaterThanOrEqual(0);
    const leg = replay.journal[idx];
    const amount = leg.feeMicros + leg.slipMicros;

    // (a) Settlement slid one step late, with the running total sliding too.
    // Internally self-consistent and the grand total is identical — only the
    // fill-anchored timing check knows the charge belongs a step earlier.
    const deferred: Replay = {
      ...replay,
      journal: replay.journal.map((l, i) => (i === idx ? { ...l, step: l.step + 1 } : l)),
      trace: replay.trace.map((t) =>
        t.step === leg.step
          ? { ...t, cashMicros: t.cashMicros + amount, cumulativeCostMicros: t.cumulativeCostMicros - amount }
          : t,
      ),
    };
    assertSummaryMatchesJournal(deferred, `deferral control · seed=${seed}`);
    expect(() => assertBookingTiming(deferred, plan, `deferral control · seed=${seed}`)).toThrow();

    // (b) The more insidious variant: the charge is journalled on time but the
    // cash it consumed is released a step late, so the ledger briefly reports
    // money that is already spent. The per-step identity catches this.
    const staleCash: Replay = {
      ...replay,
      trace: replay.trace.map((t) => (t.step === leg.step ? { ...t, cashMicros: t.cashMicros + amount } : t)),
    };
    assertSummaryMatchesJournal(staleCash, `stale-cash control · seed=${seed}`);
    expect(() => assertStepCashIdentity(staleCash, `stale-cash control · seed=${seed}`)).toThrow();
  });



  it("catches an entry friction pre-charged on the previous step", () => {
    const { replay, plan, seed } = findMutableCase();
    const idx = replay.journal.findIndex((l) => l.side === "entry" && l.step > 0 && l.feeMicros + l.slipMicros > 0);
    expect(idx, `no pre-chargeable entry leg · seed=${seed}`).toBeGreaterThanOrEqual(0);
    const tampered: Replay = {
      ...replay,
      journal: replay.journal.map((l, i) => (i === idx ? { ...l, step: l.step - 1 } : l)),
    };
    expect(() => assertBookingTiming(tampered, plan, `pre-charge control · seed=${seed}`)).toThrow();
    // Totals still reconcile — proving timing is what caught it.
    assertSummaryMatchesJournal(tampered, `pre-charge control · seed=${seed}`);
  });

  it("catches entry and exit frictions netted into a single booking at close", () => {
    const { replay, plan, seed } = findMutableCase();
    const entryIdx = replay.journal.findIndex((l) => l.side === "entry" && l.feeMicros + l.slipMicros > 0);
    const exitIdx = replay.journal.findIndex(
      (l) => l.side === "exit" && l.fillStep === replay.journal[entryIdx]?.fillStep,
    );
    expect(entryIdx, `no entry leg · seed=${seed}`).toBeGreaterThanOrEqual(0);
    expect(exitIdx, `no matching exit leg · seed=${seed}`).toBeGreaterThanOrEqual(0);
    const entry = replay.journal[entryIdx];
    const exit = replay.journal[exitIdx];
    // Net both legs into the exit: identical grand total, wrong holding period.
    const netted: CostLeg[] = replay.journal
      .filter((_, i) => i !== entryIdx)
      .map((l, i, arr) =>
        arr[i] === exit
          ? { ...l, feeMicros: l.feeMicros + entry.feeMicros, slipMicros: l.slipMicros + entry.slipMicros }
          : l,
      );
    const tampered: Replay = { ...replay, journal: netted };
    const j = totalsFromJournal(netted);
    expect(j.total, `netting changed the grand total · seed=${seed}`).toBe(replay.summary.totalCostMicros);
    expect(() => assertBookingTiming(tampered, plan, `netting control · seed=${seed}`)).toThrow();
  });

  it("catches slippage reclassified as commission with the total held constant", () => {
    const { replay, seed } = findMutableCase();
    const idx = replay.journal.findIndex((l) => l.slipMicros > 0);
    expect(idx, `no slippage leg · seed=${seed}`).toBeGreaterThanOrEqual(0);
    const leg = replay.journal[idx];
    const tampered: Replay = {
      ...replay,
      journal: replay.journal.map((l, i) =>
        i === idx ? { ...l, feeMicros: l.feeMicros + leg.slipMicros, slipMicros: 0 } : l,
      ),
    };
    const j = totalsFromJournal(tampered.journal);
    expect(j.total, `reclassification changed the total · seed=${seed}`).toBe(replay.summary.totalCostMicros);
    expect(() => assertSummaryMatchesJournal(tampered, `reclass control · seed=${seed}`)).toThrow();
  });
});
