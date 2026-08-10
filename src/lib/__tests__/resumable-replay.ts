/**
 * A replay that can be suspended to disk and resumed somewhere else.
 *
 * Long backtests do not always finish in the process that started them: a run
 * is chunked across workers, a scheduled job is interrupted and picked up on
 * the next tick, or a crashed run is restarted from its last checkpoint. All of
 * those are only safe if the *whole* live state of the replay is captured in a
 * serialisable checkpoint — no closure variable, no module-level cache, no
 * derived value that only exists in RAM.
 *
 * This module makes that explicit:
 *
 *   • `cohortForSeed`   — rebuilds the exact inputs from a seed, so a resuming
 *                         process reconstructs the tape rather than trusting it,
 *   • `runSegment`      — walks `[from, to)` of the plan from a checkpoint and
 *                         returns the next checkpoint plus the steps it emitted,
 *   • `finaliseReplay`  — unwinds the book and reports the tape and P&L,
 *   • `encode`/`decode` — JSON round-trip for the checkpoint.
 *
 * Everything is integer micro-units, so a resumed run must match the
 * single-process baseline exactly — not within a tolerance.
 */
import { applySizingLimits, type LimitedPlan } from "@/lib/breakout-sizing-limits";
import {
  fromMicros,
  holdBars,
  randomCosts,
  randomLimits,
  randomRows,
  sanitiseCapital,
  sanitiseCosts,
  toMicros,
  type Costs,
  type Row,
} from "./costed-replay-harness";
import { rng } from "./fuzz-seed";

export const CHECKPOINT_VERSION = 1;

export type Fill = { step: number; symbol: string; sizeMicros: number; releaseRank: number };

/** One executed leg of the tape — what a resumed run must reproduce exactly. */
export type TapeEntry = {
  step: number;
  side: "entry" | "exit";
  symbol: string;
  sizeMicros: number;
  feeMicros: number;
  slipMicros: number;
};

export type LedgerStep = {
  step: number;
  cashMicros: number;
  holdingsMicros: number;
  cumulativeCostMicros: number;
};

/** Everything that must survive a process boundary. Plain JSON only. */
export type Checkpoint = {
  version: number;
  seed: number;
  /** Next signal index to process. */
  cursor: number;
  cashMicros: number;
  costMicros: number;
  open: Fill[];
  tape: TapeEntry[];
  steps: LedgerStep[];
};

export type ReplayResult = {
  tape: TapeEntry[];
  steps: LedgerStep[];
  terminalCashMicros: number;
  totalCostMicros: number;
  /** P&L against the starting bank, in micro-units. */
  pnlMicros: number;
  filled: number;
};

export type Cohort = {
  seed: number;
  rows: Row[];
  plan: LimitedPlan;
  capital: number;
  costs: Costs;
};

/**
 * Deterministic inputs from a seed. The resuming process calls this instead of
 * reading the tape out of the checkpoint, which is what makes the test a real
 * cross-process check: only *state* travels, never the market data.
 */
export function cohortForSeed(seed: number): Cohort {
  const r = rng(seed);
  const rows = randomRows(r, 20 + Math.floor(r() * 80));
  const plan = applySizingLimits(rows, randomLimits(r));
  const capital = r() < 0.2 ? 5 + r() * 40 : 100 + r() * 4000;
  const costs = randomCosts(r);
  return { seed, rows, plan, capital, costs };
}

function legsFor(sizeMicros: number, costs: Costs) {
  const notional = fromMicros(sizeMicros);
  return {
    slipMicros: toMicros((notional * costs.slippageBps) / 10_000),
    feeMicros: toMicros((notional * costs.commissionBps) / 10_000 + costs.minFee),
  };
}

/** Exit frictions can never exceed the proceeds they come out of. */
function exitLegs(sizeMicros: number, costs: Costs) {
  const { feeMicros, slipMicros } = legsFor(sizeMicros, costs);
  const total = Math.min(feeMicros + slipMicros, sizeMicros);
  const slip = Math.min(slipMicros, total);
  return { feeMicros: total - slip, slipMicros: slip };
}

/** The size cash can actually fund once both cost legs are paid. */
function fundableMicros(requested: number, cashMicros: number, costs: Costs): number {
  const perUnit = 1 + (costs.slippageBps + costs.commissionBps) / 10_000;
  const affordable = Math.max(0, (fromMicros(cashMicros) - costs.minFee) / perUnit);
  const sizeMicros = Math.max(0, Math.min(toMicros(requested), Math.floor(toMicros(affordable))));
  if (sizeMicros <= 0) return 0;
  const { feeMicros, slipMicros } = legsFor(sizeMicros, costs);
  return sizeMicros + feeMicros + slipMicros <= cashMicros ? sizeMicros : 0;
}

export function ranksOf(rows: readonly Row[]): Map<string, number> {
  const dates = [...new Set(rows.map((x) => String(x?.date ?? "")))].sort();
  return new Map(dates.map((d, i) => [d, i]));
}

export function startCheckpoint(cohort: Cohort): Checkpoint {
  return {
    version: CHECKPOINT_VERSION,
    seed: cohort.seed,
    cursor: 0,
    cashMicros: toMicros(sanitiseCapital(cohort.capital)),
    costMicros: 0,
    open: [],
    tape: [],
    steps: [],
  };
}

/**
 * Walks `[from, to)` of the plan starting from `state`, returning the next
 * checkpoint. Only locals are created here; nothing is cached between calls.
 */
export function runSegment(cohort: Cohort, state: Checkpoint, to: number): Checkpoint {
  if (state.seed !== cohort.seed) {
    throw new Error(`checkpoint seed ${state.seed} does not match cohort seed ${cohort.seed}`);
  }
  const costs = sanitiseCosts(cohort.costs);
  const rank = ranksOf(cohort.rows);
  const signals = cohort.plan.signals;
  const end = Math.min(to, signals.length);

  let cashMicros = state.cashMicros;
  let costMicros = state.costMicros;
  let open = state.open.map((f) => ({ ...f }));
  const tape = state.tape.map((t) => ({ ...t }));
  const steps = state.steps.map((s) => ({ ...s }));

  const release = (upToRank: number, step: number) => {
    const keep: Fill[] = [];
    // Release in fill order so the tape is a function of the book, not of how
    // the array happened to be laid out when it crossed the boundary.
    for (const f of [...open].sort((a, b) => a.step - b.step)) {
      if (f.releaseRank > upToRank) {
        keep.push(f);
        continue;
      }
      cashMicros += f.sizeMicros;
      const { feeMicros, slipMicros } = exitLegs(f.sizeMicros, costs);
      cashMicros -= feeMicros + slipMicros;
      costMicros += feeMicros + slipMicros;
      tape.push({ step, side: "exit", symbol: f.symbol, sizeMicros: f.sizeMicros, feeMicros, slipMicros });
    }
    open = keep;
  };

  for (let i = state.cursor; i < end; i += 1) {
    const s = signals[i]!;
    const at = rank.get(String(s?.date ?? "")) ?? 0;
    release(at, i);

    const requested = Number.isFinite(s?.size) && s.size > 0 ? s.size : 0;
    if (requested > 0) {
      const sizeMicros = fundableMicros(requested, cashMicros, costs);
      if (sizeMicros > 0) {
        const { feeMicros, slipMicros } = legsFor(sizeMicros, costs);
        cashMicros -= sizeMicros + feeMicros + slipMicros;
        costMicros += feeMicros + slipMicros;
        open.push({ step: i, symbol: s.symbol, sizeMicros, releaseRank: at + holdBars(cohort.rows[i]) });
        tape.push({ step: i, side: "entry", symbol: s.symbol, sizeMicros, feeMicros, slipMicros });
      }
    }

    steps.push({
      step: i,
      cashMicros,
      holdingsMicros: open.reduce((a, f) => a + f.sizeMicros, 0),
      cumulativeCostMicros: costMicros,
    });
  }

  return {
    version: CHECKPOINT_VERSION,
    seed: cohort.seed,
    cursor: end,
    cashMicros,
    costMicros,
    open,
    tape,
    steps,
  };
}

/** Unwinds whatever is still open and reports the finished replay. */
export function finaliseReplay(cohort: Cohort, state: Checkpoint): ReplayResult {
  const total = cohort.plan.signals.length;
  if (state.cursor < total) {
    throw new Error(`replay is not finished: cursor ${state.cursor} of ${total}`);
  }
  const done = runSegment(cohort, { ...state, cursor: total }, total);
  const costs = sanitiseCosts(cohort.costs);

  let cashMicros = done.cashMicros;
  let costMicros = done.costMicros;
  const tape = [...done.tape];
  for (const f of [...done.open].sort((a, b) => a.step - b.step)) {
    cashMicros += f.sizeMicros;
    const { feeMicros, slipMicros } = exitLegs(f.sizeMicros, costs);
    cashMicros -= feeMicros + slipMicros;
    costMicros += feeMicros + slipMicros;
    tape.push({ step: total, side: "exit", symbol: f.symbol, sizeMicros: f.sizeMicros, feeMicros, slipMicros });
  }

  const steps = [
    ...done.steps,
    { step: total, cashMicros, holdingsMicros: 0, cumulativeCostMicros: costMicros },
  ];

  return {
    tape,
    steps,
    terminalCashMicros: cashMicros,
    totalCostMicros: costMicros,
    pnlMicros: cashMicros - toMicros(sanitiseCapital(cohort.capital)),
    filled: tape.filter((t) => t.side === "entry").length,
  };
}

/** Baseline: the whole replay in one process, one segment, no checkpoint. */
export function runWholeReplay(cohort: Cohort): ReplayResult {
  const end = runSegment(cohort, startCheckpoint(cohort), cohort.plan.signals.length);
  return finaliseReplay(cohort, end);
}

export function encode(state: Checkpoint): string {
  return JSON.stringify(state);
}

export function decode(text: string): Checkpoint {
  const parsed = JSON.parse(text) as Checkpoint;
  if (parsed?.version !== CHECKPOINT_VERSION) {
    throw new Error(`unsupported checkpoint version: ${String(parsed?.version)}`);
  }
  return parsed;
}
