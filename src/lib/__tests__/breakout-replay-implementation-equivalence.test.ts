import { describe, expect, it } from "vitest";
import { applySizingLimits, type LimitedPlan } from "@/lib/breakout-sizing-limits";
import {
  fromMicros,
  holdBars,
  randomCosts,
  randomLimits,
  randomRows,
  runCostedReplay,
  sanitiseCapital,
  sanitiseCosts,
  toMicros,
  type Costs,
  type Row,
} from "./costed-replay-harness";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Property-based cross-implementation equivalence for the costed ledger.
 *
 * The production replay is written for speed: incremental cash, an array of
 * open positions mutated in place, totals accumulated as it walks. That shape
 * is exactly where an optimisation quietly changes behaviour — a position
 * released one step early, a fee booked against the wrong step, holdings
 * carried in a Map that iterates differently after a refactor.
 *
 * So the same semantics are written here three more times, deliberately in
 * different shapes, and a generated cohort is replayed through all four:
 *
 *   • `naiveReplay`   — no incremental state at all; the open book is
 *                       recomputed from the full fill history at every step.
 *   • `queueReplay`   — releases driven by a rank-ordered event queue rather
 *                       than by scanning the open book.
 *   • `symbolReplay`  — holdings kept as a per-symbol map, iterated by symbol
 *                       name rather than by fill order.
 *   • `chunkedReplay` — the same walk suspended and resumed in random slices,
 *                       carrying state across the boundary.
 *
 * The property, over hundreds of random cohorts: at *every* step all four
 * agree with the engine on cash, on total holdings, and on holdings per
 * symbol — as exact integers in micro-units, with no tolerance window. Any
 * disagreement means one path can fund a book another path cannot hold.
 */

const FILE = "src/lib/__tests__/breakout-replay-implementation-equivalence.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

// ---------------------------------------------------------------------------
// Shared arithmetic — identical rules, deliberately different control flow
// ---------------------------------------------------------------------------

type LedgerStep = {
  step: number;
  cashMicros: number;
  holdingsMicros: number;
  /** Holdings per symbol, sparse: a symbol with nothing open is absent. */
  bySymbol: Record<string, number>;
  cumulativeCostMicros: number;
};

type Ledger = { steps: LedgerStep[]; terminalCashMicros: number; totalCostMicros: number };

type Fill = { step: number; symbol: string; sizeMicros: number; releaseRank: number };

function legsFor(sizeMicros: number, costs: Costs) {
  const notional = fromMicros(sizeMicros);
  return {
    slipMicros: toMicros((notional * costs.slippageBps) / 10_000),
    feeMicros: toMicros((notional * costs.commissionBps) / 10_000 + costs.minFee),
  };
}

/** Exit frictions can never exceed the proceeds they come out of. */
function exitCostMicros(sizeMicros: number, costs: Costs): number {
  const { feeMicros, slipMicros } = legsFor(sizeMicros, costs);
  return Math.min(feeMicros + slipMicros, sizeMicros);
}

/** The size that cash can actually fund once both cost legs are paid. */
function fundableMicros(requested: number, cashMicros: number, costs: Costs): number {
  const perUnit = 1 + (costs.slippageBps + costs.commissionBps) / 10_000;
  const affordable = Math.max(0, (fromMicros(cashMicros) - costs.minFee) / perUnit);
  const sizeMicros = Math.max(0, Math.min(toMicros(requested), Math.floor(toMicros(affordable))));
  if (sizeMicros <= 0) return 0;
  const { feeMicros, slipMicros } = legsFor(sizeMicros, costs);
  return sizeMicros + feeMicros + slipMicros <= cashMicros ? sizeMicros : 0;
}

function ranksOf(rows: readonly Row[]): Map<string, number> {
  const dates = [...new Set(rows.map((x) => String(x?.date ?? "")))].sort();
  return new Map(dates.map((d, i) => [d, i]));
}

function tally(entries: Array<{ symbol: string; sizeMicros: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) out[e.symbol] = (out[e.symbol] ?? 0) + e.sizeMicros;
  return out;
}

// ---------------------------------------------------------------------------
// Implementation 1 — naive: recompute the whole book at every step
// ---------------------------------------------------------------------------

function naiveReplay(rows: readonly Row[], plan: LimitedPlan, rawCapital: number, rawCosts: Costs): Ledger {
  const costs = sanitiseCosts(rawCosts);
  const rank = ranksOf(rows);
  let cashMicros = toMicros(sanitiseCapital(rawCapital));
  let costMicros = 0;
  const fills: Fill[] = [];
  const steps: LedgerStep[] = [];

  // Which fills are still open at a given rank — derived, never cached.
  const openAt = (upToRank: number) => fills.filter((f) => f.releaseRank > upToRank);
  const released = new Set<number>();

  plan.signals.forEach((s, i) => {
    const at = rank.get(String(s?.date ?? "")) ?? 0;

    for (const f of fills) {
      if (f.releaseRank <= at && !released.has(f.step)) {
        released.add(f.step);
        cashMicros += f.sizeMicros;
        const c = exitCostMicros(f.sizeMicros, costs);
        cashMicros -= c;
        costMicros += c;
      }
    }

    const requested = Number.isFinite(s?.size) && s.size > 0 ? s.size : 0;
    if (requested > 0) {
      const sizeMicros = fundableMicros(requested, cashMicros, costs);
      if (sizeMicros > 0) {
        const { feeMicros, slipMicros } = legsFor(sizeMicros, costs);
        cashMicros -= sizeMicros + feeMicros + slipMicros;
        costMicros += feeMicros + slipMicros;
        fills.push({ step: i, symbol: s.symbol, sizeMicros, releaseRank: at + holdBars(rows[i]) });
      }
    }

    const open = openAt(at).filter((f) => !released.has(f.step));
    steps.push({
      step: i,
      cashMicros,
      holdingsMicros: open.reduce((a, f) => a + f.sizeMicros, 0),
      bySymbol: tally(open),
      cumulativeCostMicros: costMicros,
    });
  });

  for (const f of fills) {
    if (released.has(f.step)) continue;
    released.add(f.step);
    cashMicros += f.sizeMicros;
    const c = exitCostMicros(f.sizeMicros, costs);
    cashMicros -= c;
    costMicros += c;
  }
  steps.push({
    step: plan.signals.length,
    cashMicros,
    holdingsMicros: 0,
    bySymbol: {},
    cumulativeCostMicros: costMicros,
  });

  return { steps, terminalCashMicros: cashMicros, totalCostMicros: costMicros };
}

// ---------------------------------------------------------------------------
// Implementation 2 — event queue: releases scheduled, not scanned for
// ---------------------------------------------------------------------------

function queueReplay(rows: readonly Row[], plan: LimitedPlan, rawCapital: number, rawCosts: Costs): Ledger {
  const costs = sanitiseCosts(rawCosts);
  const rank = ranksOf(rows);
  let cashMicros = toMicros(sanitiseCapital(rawCapital));
  let costMicros = 0;
  // Kept sorted by releaseRank; the head is always the next event due.
  const queue: Fill[] = [];
  const steps: LedgerStep[] = [];

  const drain = (upToRank: number) => {
    while (queue.length > 0 && queue[0]!.releaseRank <= upToRank) {
      const f = queue.shift()!;
      cashMicros += f.sizeMicros;
      const c = exitCostMicros(f.sizeMicros, costs);
      cashMicros -= c;
      costMicros += c;
    }
  };

  plan.signals.forEach((s, i) => {
    const at = rank.get(String(s?.date ?? "")) ?? 0;
    drain(at);

    const requested = Number.isFinite(s?.size) && s.size > 0 ? s.size : 0;
    if (requested > 0) {
      const sizeMicros = fundableMicros(requested, cashMicros, costs);
      if (sizeMicros > 0) {
        const { feeMicros, slipMicros } = legsFor(sizeMicros, costs);
        cashMicros -= sizeMicros + feeMicros + slipMicros;
        costMicros += feeMicros + slipMicros;
        const fill: Fill = { step: i, symbol: s.symbol, sizeMicros, releaseRank: at + holdBars(rows[i]) };
        const idx = queue.findIndex((q) => q.releaseRank > fill.releaseRank);
        if (idx === -1) queue.push(fill);
        else queue.splice(idx, 0, fill);
      }
    }

    steps.push({
      step: i,
      cashMicros,
      holdingsMicros: queue.reduce((a, f) => a + f.sizeMicros, 0),
      bySymbol: tally(queue),
      cumulativeCostMicros: costMicros,
    });
  });

  drain(Number.POSITIVE_INFINITY);
  steps.push({
    step: plan.signals.length,
    cashMicros,
    holdingsMicros: 0,
    bySymbol: {},
    cumulativeCostMicros: costMicros,
  });

  return { steps, terminalCashMicros: cashMicros, totalCostMicros: costMicros };
}

// ---------------------------------------------------------------------------
// Implementation 3 — per-symbol map, iterated by symbol name
// ---------------------------------------------------------------------------

function symbolReplay(rows: readonly Row[], plan: LimitedPlan, rawCapital: number, rawCosts: Costs): Ledger {
  const costs = sanitiseCosts(rawCosts);
  const rank = ranksOf(rows);
  let cashMicros = toMicros(sanitiseCapital(rawCapital));
  let costMicros = 0;
  const book = new Map<string, Fill[]>();
  const steps: LedgerStep[] = [];

  const releaseDue = (upToRank: number) => {
    for (const symbol of [...book.keys()].sort()) {
      const lots = book.get(symbol)!;
      const keep: Fill[] = [];
      for (const f of lots) {
        if (f.releaseRank > upToRank) {
          keep.push(f);
          continue;
        }
        cashMicros += f.sizeMicros;
        const c = exitCostMicros(f.sizeMicros, costs);
        cashMicros -= c;
        costMicros += c;
      }
      if (keep.length === 0) book.delete(symbol);
      else book.set(symbol, keep);
    }
  };

  const snapshot = () => {
    const bySymbol: Record<string, number> = {};
    let total = 0;
    for (const [symbol, lots] of book) {
      const sum = lots.reduce((a, f) => a + f.sizeMicros, 0);
      if (sum !== 0) bySymbol[symbol] = sum;
      total += sum;
    }
    return { bySymbol, total };
  };

  plan.signals.forEach((s, i) => {
    const at = rank.get(String(s?.date ?? "")) ?? 0;
    releaseDue(at);

    const requested = Number.isFinite(s?.size) && s.size > 0 ? s.size : 0;
    if (requested > 0) {
      const sizeMicros = fundableMicros(requested, cashMicros, costs);
      if (sizeMicros > 0) {
        const { feeMicros, slipMicros } = legsFor(sizeMicros, costs);
        cashMicros -= sizeMicros + feeMicros + slipMicros;
        costMicros += feeMicros + slipMicros;
        const lots = book.get(s.symbol) ?? [];
        lots.push({ step: i, symbol: s.symbol, sizeMicros, releaseRank: at + holdBars(rows[i]) });
        book.set(s.symbol, lots);
      }
    }

    const { bySymbol, total } = snapshot();
    steps.push({ step: i, cashMicros, holdingsMicros: total, bySymbol, cumulativeCostMicros: costMicros });
  });

  releaseDue(Number.POSITIVE_INFINITY);
  steps.push({
    step: plan.signals.length,
    cashMicros,
    holdingsMicros: 0,
    bySymbol: {},
    cumulativeCostMicros: costMicros,
  });

  return { steps, terminalCashMicros: cashMicros, totalCostMicros: costMicros };
}

// ---------------------------------------------------------------------------
// Implementation 4 — the walk suspended and resumed in slices
// ---------------------------------------------------------------------------

function chunkedReplay(
  rows: readonly Row[],
  plan: LimitedPlan,
  rawCapital: number,
  rawCosts: Costs,
  chunkSizes: number[],
): Ledger {
  const total = plan.signals.length;
  const bounds: Array<[number, number]> = [];
  let cursor = 0;
  let ci = 0;
  while (cursor < total) {
    const size = Math.max(1, chunkSizes[ci % Math.max(1, chunkSizes.length)] ?? total);
    bounds.push([cursor, Math.min(total, cursor + size)]);
    cursor += size;
    ci += 1;
  }
  if (bounds.length === 0) bounds.push([0, 0]);

  // Carried state — everything that must survive a suspend/resume boundary.
  const costs = sanitiseCosts(rawCosts);
  const rank = ranksOf(rows);
  const state = {
    cashMicros: toMicros(sanitiseCapital(rawCapital)),
    costMicros: 0,
    open: [] as Fill[],
  };
  const steps: LedgerStep[] = [];

  const release = (upToRank: number) => {
    const keep: Fill[] = [];
    for (const f of state.open) {
      if (f.releaseRank > upToRank) {
        keep.push(f);
        continue;
      }
      state.cashMicros += f.sizeMicros;
      const c = exitCostMicros(f.sizeMicros, costs);
      state.cashMicros -= c;
      state.costMicros += c;
    }
    state.open = keep;
  };

  for (const [from, to] of bounds) {
    // Fresh locals each slice; only `state` crosses the boundary.
    for (let i = from; i < to; i += 1) {
      const s = plan.signals[i]!;
      const at = rank.get(String(s?.date ?? "")) ?? 0;
      release(at);

      const requested = Number.isFinite(s?.size) && s.size > 0 ? s.size : 0;
      if (requested > 0) {
        const sizeMicros = fundableMicros(requested, state.cashMicros, costs);
        if (sizeMicros > 0) {
          const { feeMicros, slipMicros } = legsFor(sizeMicros, costs);
          state.cashMicros -= sizeMicros + feeMicros + slipMicros;
          state.costMicros += feeMicros + slipMicros;
          state.open.push({ step: i, symbol: s.symbol, sizeMicros, releaseRank: at + holdBars(rows[i]) });
        }
      }

      steps.push({
        step: i,
        cashMicros: state.cashMicros,
        holdingsMicros: state.open.reduce((a, f) => a + f.sizeMicros, 0),
        bySymbol: tally(state.open),
        cumulativeCostMicros: state.costMicros,
      });
    }
  }

  release(Number.POSITIVE_INFINITY);
  steps.push({
    step: total,
    cashMicros: state.cashMicros,
    holdingsMicros: 0,
    bySymbol: {},
    cumulativeCostMicros: state.costMicros,
  });

  return { steps, terminalCashMicros: state.cashMicros, totalCostMicros: state.costMicros };
}

// ---------------------------------------------------------------------------
// The engine under test, projected into the same shape
// ---------------------------------------------------------------------------

/**
 * The engine projected into the same shape. Per-symbol holdings are left empty
 * here: the engine reports only the total, so the per-symbol property is
 * proven between the three independent implementations instead.
 */
function engineLedger(rows: readonly Row[], plan: LimitedPlan, capital: number, costs: Costs): Ledger {
  const replay = runCostedReplay(rows, plan, capital, costs);
  return {
    steps: replay.trace.map((t) => ({
      step: t.step,
      cashMicros: t.cashMicros,
      holdingsMicros: t.openNotionalMicros,
      bySymbol: {},
      cumulativeCostMicros: t.cumulativeCostMicros,
    })),
    terminalCashMicros: replay.summary.terminalCashMicros,
    totalCostMicros: replay.summary.totalCostMicros,
  };
}

// ---------------------------------------------------------------------------
// Cohort generation
// ---------------------------------------------------------------------------

type Cohort = { rows: Row[]; plan: LimitedPlan; capital: number; costs: Costs; chunks: number[] };

function randomCohort(seed: number): Cohort {
  const r = rng(seed);
  const rows = randomRows(r, 4 + Math.floor(r() * 60));
  const plan = applySizingLimits(rows, randomLimits(r));
  const capital = r() < 0.2 ? 1 + r() * 20 : 50 + r() * 4000;
  const costs = randomCosts(r);
  const chunks = Array.from({ length: 1 + Math.floor(r() * 4) }, () => 1 + Math.floor(r() * 9));
  return { rows, plan, capital, costs, chunks };
}

function ledgersFor(c: Cohort): Record<string, Ledger> {
  return {
    engine: engineLedger(c.rows, c.plan, c.capital, c.costs),
    naive: naiveReplay(c.rows, c.plan, c.capital, c.costs),
    queue: queueReplay(c.rows, c.plan, c.capital, c.costs),
    symbol: symbolReplay(c.rows, c.plan, c.capital, c.costs),
    chunked: chunkedReplay(c.rows, c.plan, c.capital, c.costs, c.chunks),
  };
}

function cashTrace(l: Ledger): number[] {
  return l.steps.map((s) => s.cashMicros);
}

function holdingsTrace(l: Ledger): number[] {
  return l.steps.map((s) => s.holdingsMicros);
}

function costTrace(l: Ledger): number[] {
  return l.steps.map((s) => s.cumulativeCostMicros);
}

function symbolTrace(l: Ledger): string[] {
  return l.steps.map((s) =>
    Object.keys(s.bySymbol)
      .sort()
      .map((k) => `${k}:${s.bySymbol[k]}`)
      .join("|"),
  );
}

// ---------------------------------------------------------------------------

describe("replay implementation equivalence — property based", () => {
  it("all implementations agree on cash at every step across random cohorts", () => {
    for (let c = 0; c < 250; c += 1) {
      const seed = caseSeed(BASE_SEED, "cash", c);
      const cohort = randomCohort(seed);
      const ledgers = ledgersFor(cohort);
      const expected = cashTrace(ledgers.engine!);
      for (const [name, l] of Object.entries(ledgers)) {
        expect(cashTrace(l), `${name} cash — seed ${seed} — repro: ${REPRO}`).toEqual(expected);
      }
    }
  });

  it("all implementations agree on total holdings at every step", () => {
    for (let c = 0; c < 250; c += 1) {
      const seed = caseSeed(BASE_SEED, "holdings", c);
      const cohort = randomCohort(seed);
      const ledgers = ledgersFor(cohort);
      const expected = holdingsTrace(ledgers.engine!);
      for (const [name, l] of Object.entries(ledgers)) {
        expect(holdingsTrace(l), `${name} holdings — seed ${seed} — repro: ${REPRO}`).toEqual(expected);
      }
    }
  });

  it("the independent implementations agree on holdings per symbol at every step", () => {
    for (let c = 0; c < 250; c += 1) {
      const seed = caseSeed(BASE_SEED, "per-symbol", c);
      const cohort = randomCohort(seed);
      const { naive, queue, symbol, chunked } = ledgersFor(cohort);
      const expected = symbolTrace(naive!);
      for (const [name, l] of Object.entries({ queue, symbol, chunked })) {
        expect(symbolTrace(l!), `${name} per-symbol — seed ${seed} — repro: ${REPRO}`).toEqual(expected);
      }
    }
  });

  it("all implementations agree on cumulative cost, terminal cash and total cost", () => {
    for (let c = 0; c < 250; c += 1) {
      const seed = caseSeed(BASE_SEED, "costs", c);
      const cohort = randomCohort(seed);
      const ledgers = ledgersFor(cohort);
      const ref = ledgers.engine!;
      for (const [name, l] of Object.entries(ledgers)) {
        const where = `${name} — seed ${seed} — repro: ${REPRO}`;
        expect(costTrace(l), `${where} cumulative cost`).toEqual(costTrace(ref));
        expect(l.terminalCashMicros, `${where} terminal cash`).toBe(ref.terminalCashMicros);
        expect(l.totalCostMicros, `${where} total cost`).toBe(ref.totalCostMicros);
      }
    }
  });

  it("every implementation keeps cash and holdings sound on every generated cohort", () => {
    for (let c = 0; c < 150; c += 1) {
      const seed = caseSeed(BASE_SEED, "invariants", c);
      const cohort = randomCohort(seed);
      const capitalMicros = toMicros(sanitiseCapital(cohort.capital));
      for (const [name, l] of Object.entries(ledgersFor(cohort))) {
        for (const s of l.steps) {
          const where = `${name} @${s.step} — seed ${seed} — repro: ${REPRO}`;
          expect(s.cashMicros, `${where}: cash non-negative`).toBeGreaterThanOrEqual(0);
          expect(s.holdingsMicros, `${where}: holdings non-negative`).toBeGreaterThanOrEqual(0);
          for (const [sym, v] of Object.entries(s.bySymbol)) {
            expect(v, `${where}: ${sym} non-negative`).toBeGreaterThanOrEqual(0);
          }
          expect(s.cashMicros + s.holdingsMicros + s.cumulativeCostMicros, `${where}: conservation`).toBe(
            capitalMicros,
          );
        }
        expect(l.steps[l.steps.length - 1]!.holdingsMicros, `${name}: fully unwound`).toBe(0);
      }
    }
  });

  it("a single altered release rule is caught by the differential", () => {
    const cohort = randomCohort(caseSeed(BASE_SEED, "negative-control", 0));
    // One position held a bar longer — the classic off-by-one in a release rule.
    const drifted = naiveReplay(
      cohort.rows.map((row, i) => (i === 0 ? { ...row, barsHeld: row.barsHeld + 1 } : row)),
      cohort.plan,
      cohort.capital,
      cohort.costs,
    );
    const base = naiveReplay(cohort.rows, cohort.plan, cohort.capital, cohort.costs);
    expect(cashTrace(drifted)).not.toEqual(cashTrace(base));
  });
});
