import { describe, expect, it } from "vitest";
import { applySizingLimits } from "@/lib/breakout-sizing-limits";
import {
  randomCosts,
  randomLimits,
  randomRows,
  runCostedReplay,
  type CostLeg,
  type Costs,
  type ReleaseOrder,
  type Replay,
  type Row,
  type StepTrace,
} from "./costed-replay-harness";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Step-order determinism for the costed ledger.
 *
 * Two replays that fill the same positions on the same steps must produce the
 * same ledger, full stop. But *inside* a step the engine has genuine freedom:
 * when three positions all fall due on the same day, something has to decide
 * which one is closed first. Real code picks that order incidentally — array
 * order, a Map keyed by symbol, a grouped-by-symbol scan, a sort by size — and
 * the choice drifts as code is refactored.
 *
 * That freedom must not reach the books. If closing GLEN before AAPL rather
 * than after changes cash at the end of the step, the cost total, or which
 * step a friction lands on, then every downstream figure (available cash, the
 * next fill's size, drawdown, the summary) becomes a function of an
 * implementation detail nobody chose deliberately.
 *
 * So this file pins the invariant from both directions:
 *
 *   1. Same fills, different symbol iteration order → identical ledger
 *      transitions: per-step cash, open notional, cumulative cost, terminal
 *      cash, and the whole cost journal once same-step legs are compared as
 *      the set they are.
 *   2. Renaming symbols (a bijection that changes every comparison order)
 *      leaves the ledger identical up to the relabelling.
 *
 * Plus negative controls: an order-dependent charge, and a leg whose booking
 * step moves, must both be caught.
 */

const FILE = "src/lib/__tests__/breakout-ledger-step-order-determinism.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

const ORDERS: ReleaseOrder[] = ["lifo", "fifo", "symbol-asc", "symbol-desc", "size-desc"];

// ---------------------------------------------------------------------------
// Canonical views: what must be identical regardless of within-step ordering
// ---------------------------------------------------------------------------

/** The ledger transition at each step — the thing every downstream figure reads. */
function transitions(replay: Replay): StepTrace[] {
  return replay.trace.map((t) => ({ ...t }));
}

/**
 * Cost legs as a step-keyed multiset. Legs booked on the same step may be
 * emitted in any order, so they are sorted within their step; legs may never
 * move between steps, so the step key itself is never sorted away.
 */
function canonicalJournal(journal: readonly CostLeg[], rename: (s: string) => string = (s) => s) {
  return [...journal]
    .map((l) => ({ ...l, symbol: rename(l.symbol) }))
    .sort(
      (a, b) =>
        a.step - b.step ||
        a.side.localeCompare(b.side) ||
        a.symbol.localeCompare(b.symbol) ||
        a.fillStep - b.fillStep ||
        a.feeMicros - b.feeMicros ||
        a.slipMicros - b.slipMicros,
    );
}

function canonicalFills(fills: Replay["fills"], rename: (s: string) => string = (s) => s) {
  return [...fills]
    .map((f) => ({ ...f, symbol: rename(f.symbol) }))
    .sort((a, b) => a.fillStep - b.fillStep || a.symbol.localeCompare(b.symbol));
}

/** The full comparison: the fills must match first, then the ledger they produced. */
function assertSameLedger(a: Replay, b: Replay, ctx: string, rename: (s: string) => string = (s) => s) {
  // Precondition of the property: the two replays really do fill the same set.
  // `rename` maps a's symbols onto b's, so it is applied to a's side.
  expect(canonicalFills(b.fills), `fill sets differ, property does not apply: ${ctx}`).toEqual(
    canonicalFills(a.fills, rename),
  );
  expect(b.summary.filledCount, `fill count differs: ${ctx}`).toBe(a.summary.filledCount);
  expect(b.summary.refusedCount, `refusal count differs: ${ctx}`).toBe(a.summary.refusedCount);

  expect(transitions(b), `per-step ledger transitions differ: ${ctx}`).toEqual(transitions(a));
  expect(canonicalJournal(b.journal), `cost journal differs: ${ctx}`).toEqual(
    canonicalJournal(a.journal, rename),
  );
  expect(b.summary, `summary totals differ: ${ctx}`).toEqual(a.summary);
}

// ---------------------------------------------------------------------------

function buildCase(seed: number) {
  const r = rng(seed);
  const rows = randomRows(r, 30 + Math.floor(r() * 50));
  const costs = randomCosts(r);
  const capital = 1 + r() * 40;
  const plan = applySizingLimits(rows, randomLimits(r));
  return { rows, plan, costs, capital };
}

/** A bijective relabelling that reverses alphabetical order between symbols. */
function makeRenamer(rows: readonly Row[]) {
  const symbols = [...new Set(rows.map((x) => x.symbol))].sort();
  const map = new Map(symbols.map((s, i) => [s, `Z${symbols.length - 1 - i}_${s}`]));
  return (s: string) => map.get(s) ?? s;
}

describe("ledger step-order determinism", () => {
  it("produces identical ledger transitions under every same-step release order", () => {
    for (let c = 0; c < 120; c++) {
      const seed = caseSeed(BASE_SEED, "release-order", c);
      const { rows, plan, costs, capital } = buildCase(seed);
      const baseline = runCostedReplay(rows, plan, capital, costs, { releaseOrder: "lifo" });
      for (const order of ORDERS) {
        const alt = runCostedReplay(rows, plan, capital, costs, { releaseOrder: order });
        assertSameLedger(baseline, alt, `order=${order} · seed=${seed} · ${REPRO}`);
      }
    }
  });

  it("keeps the ledger identical when symbols are renamed to reverse their order", () => {
    for (let c = 0; c < 100; c++) {
      const seed = caseSeed(BASE_SEED, "rename", c);
      const { rows, costs, capital } = buildCase(seed);
      const rename = makeRenamer(rows);
      const renamedRows = rows.map((x) => ({ ...x, symbol: rename(x.symbol) }));
      const plan = applySizingLimits(rows, randomLimits(rng(seed)));
      const renamedPlan = applySizingLimits(renamedRows, randomLimits(rng(seed)));

      const base = runCostedReplay(rows, plan, capital, costs, { releaseOrder: "symbol-asc" });
      // Same fills, but every symbol comparison now sorts the other way.
      const renamed = runCostedReplay(renamedRows, renamedPlan, capital, costs, {
        releaseOrder: "symbol-asc",
      });
      assertSameLedger(base, renamed, `rename · seed=${seed} · ${REPRO}`, rename);
    }
  });

  it("is order-insensitive across the whole cost spectrum, including free and punitive", () => {
    const variants: Array<[string, Costs]> = [
      ["zero cost", { commissionBps: 0, minFee: 0, slippageBps: 0 }],
      ["ticket only", { commissionBps: 0, minFee: 0.08, slippageBps: 0 }],
      ["slippage only", { commissionBps: 0, minFee: 0, slippageBps: 30 }],
      ["punitive", { commissionBps: 400, minFee: 0.5, slippageBps: 350 }],
    ];
    for (const [label, costs] of variants) {
      for (let c = 0; c < 20; c++) {
        const seed = caseSeed(BASE_SEED, "cost-spectrum", c);
        const { rows, plan, capital } = buildCase(seed);
        const baseline = runCostedReplay(rows, plan, capital, costs, { releaseOrder: "fifo" });
        for (const order of ORDERS) {
          const alt = runCostedReplay(rows, plan, capital, costs, { releaseOrder: order });
          assertSameLedger(baseline, alt, `${label} · order=${order} · seed=${seed} · ${REPRO}`);
        }
      }
    }
  });

  it("re-running the same order twice is byte-identical (no ambient state)", () => {
    for (let c = 0; c < 60; c++) {
      const seed = caseSeed(BASE_SEED, "repeat", c);
      const { rows, plan, costs, capital } = buildCase(seed);
      for (const order of ORDERS) {
        const a = runCostedReplay(rows, plan, capital, costs, { releaseOrder: order });
        const b = runCostedReplay(rows, plan, capital, costs, { releaseOrder: order });
        expect(JSON.stringify(b), `repeat run drifted (order=${order}) · seed=${seed} · ${REPRO}`).toBe(
          JSON.stringify(a),
        );
      }
    }
  });

  it("has teeth: some cases really do close several positions on the same step", () => {
    let multiCloseSteps = 0;
    for (let c = 0; c < 60; c++) {
      const seed = caseSeed(BASE_SEED, "release-order", c);
      const { rows, plan, costs, capital } = buildCase(seed);
      const replay = runCostedReplay(rows, plan, capital, costs);
      const perStep = new Map<number, number>();
      for (const l of replay.journal) {
        if (l.side !== "exit") continue;
        perStep.set(l.step, (perStep.get(l.step) ?? 0) + 1);
      }
      multiCloseSteps += [...perStep.values()].filter((n) => n > 1).length;
    }
    expect(multiCloseSteps, `no same-step multi-close ever occurred · ${REPRO}`).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Negative controls
  // -------------------------------------------------------------------------

  it("catches a charge that depends on within-step position order", () => {
    const seed = caseSeed(BASE_SEED, "control-order-dependent", 0);
    const { rows, plan, costs, capital } = buildCase(seed);
    const baseline = runCostedReplay(rows, plan, capital, costs, { releaseOrder: "lifo" });

    // Simulate the classic bug: the ticket fee is only charged on the first
    // close of each step, so the total depends on which position closes first.
    const firstPerStep = new Map<number, CostLeg>();
    for (const l of baseline.journal) {
      if (l.side === "exit" && !firstPerStep.has(l.step)) firstPerStep.set(l.step, l);
    }
    const buggy: Replay = {
      ...baseline,
      journal: baseline.journal.map((l) => (firstPerStep.get(l.step) === l ? { ...l, feeMicros: 0 } : l)),
    };
    expect(() => assertSameLedger(baseline, buggy, `order-dependent control · seed=${seed}`)).toThrow();
  });

  it("catches a leg whose booking step moves, even with the same totals", () => {
    const seed = caseSeed(BASE_SEED, "control-step-move", 0);
    const { rows, plan, costs, capital } = buildCase(seed);
    const baseline = runCostedReplay(rows, plan, capital, costs);
    const idx = baseline.journal.findIndex((l) => l.step > 0 && l.step < baseline.trace.length - 1);
    expect(idx, `no movable leg · seed=${seed}`).toBeGreaterThanOrEqual(0);
    const moved: Replay = {
      ...baseline,
      journal: baseline.journal.map((l, i) => (i === idx ? { ...l, step: l.step + 1 } : l)),
    };
    // Grand totals are untouched, but the step key is part of the canonical form.
    expect(moved.summary, `control changed the summary · seed=${seed}`).toEqual(baseline.summary);
    expect(() => assertSameLedger(baseline, moved, `step-move control · seed=${seed}`)).toThrow();
  });

  it("catches a fill set that genuinely differs, rather than reporting a false match", () => {
    const seed = caseSeed(BASE_SEED, "control-fills", 0);
    const { rows, plan, costs, capital } = buildCase(seed);
    const baseline = runCostedReplay(rows, plan, capital, costs);
    const different = runCostedReplay(rows, plan, capital * 0.5 + 0.37, costs);
    expect(() => assertSameLedger(baseline, different, `fill-set control · seed=${seed}`)).toThrow();
  });
});
