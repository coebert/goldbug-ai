/**
 * Shared costed-replay harness for the ledger test suites.
 *
 * A small, deliberately explicit replay engine: it walks a limited sizing plan
 * as cash and holdings, charges commission, a fixed ticket and slippage on both
 * sides of every fill, and records three things that the tests reconcile
 * against each other —
 *
 *   • `journal` — one cost leg per fill side, tagged with the step it was
 *     booked on and the step of the fill that incurred it,
 *   • `trace`   — cash, open notional and cumulative cost after every step,
 *   • `summary` — totals accumulated inline while the replay runs.
 *
 * All money is quantised to integer micro-units so reconciliation is integer
 * arithmetic rather than a float comparison with a tolerance window.
 */
import { resolveSizingLimits, type LimitedPlan, type SizingLimits } from "@/lib/breakout-sizing-limits";

export const MICRO = 1e6;
export const toMicros = (v: number) => Math.round(v * MICRO);
export const fromMicros = (v: number) => v / MICRO;

export const day = (i: number) => {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

export type Row = { symbol: string; date: string; barsHeld: number; size: number };

export type Costs = {
  /** Proportional commission per side, in basis points of notional. */
  commissionBps: number;
  /** Fixed ticket charge per side, in exposure units. */
  minFee: number;
  /** Adverse execution move per side, in basis points of notional. */
  slippageBps: number;
};

export function randomRows(r: () => number, n: number): Row[] {
  const symbols = 1 + Math.floor(r() * 8);
  const perDay = 1 + Math.floor(r() * 3);
  return Array.from({ length: n }, (_, i) => ({
    symbol: `S${i % symbols}`,
    date: day(Math.floor(i / perDay)),
    barsHeld: 1 + Math.floor(r() * 10),
    size: r() < 0.08 ? 0 : (r() * 2.2) / 3,
  }));
}

export function randomLimits(r: () => number): SizingLimits {
  return resolveSizingLimits({
    maxPositionSize: 0.3 + r() * 1.8,
    maxConcurrentSignals: 1 + Math.floor(r() * 12),
    maxTotalDeployedPct: 20 + r() * 250,
  });
}

export function randomCosts(r: () => number): Costs {
  return {
    commissionBps: r() < 0.15 ? 0 : r() * 60,
    minFee: r() < 0.2 ? 0 : r() * 4,
    slippageBps: r() < 0.15 ? 0 : r() * 45,
  };
}

export type CostLeg = {
  /** Step index the charge was booked on. */
  step: number;
  side: "entry" | "exit";
  symbol: string;
  /** Step index of the fill that incurred the charge. */
  fillStep: number;
  feeMicros: number;
  slipMicros: number;
};

export type StepTrace = {
  step: number;
  cashMicros: number;
  openNotionalMicros: number;
  cumulativeCostMicros: number;
};

/** What the engine reports at the end of the replay — accumulated inline. */
export type CostSummary = {
  totalFeeMicros: number;
  totalSlipMicros: number;
  totalCostMicros: number;
  entryFeeMicros: number;
  entrySlipMicros: number;
  exitFeeMicros: number;
  exitSlipMicros: number;
  filledCount: number;
  refusedCount: number;
  terminalCashMicros: number;
};

export type Replay = {
  journal: CostLeg[];
  trace: StepTrace[];
  summary: CostSummary;
  /** Independent record of when each funded position is due to be released. */
  fills: Array<{ fillStep: number; symbol: string; sizeMicros: number; releaseRank: number }>;
  dateRank: Map<string, number>;
  capitalMicros: number;
};

/**
 * The order in which positions that fall due on the same step are closed.
 *
 * Every policy here releases exactly the same set of positions on exactly the
 * same step — only the iteration order inside that step differs. Real engines
 * pick this order incidentally (array order, a Map keyed by symbol, a grouped
 * scan), so the ledger must not depend on it.
 */
export type ReleaseOrder = "lifo" | "fifo" | "symbol-asc" | "symbol-desc" | "size-desc";

export type ReplayOptions = {
  releaseOrder?: ReleaseOrder;
};

type OpenPos = { releaseRank: number; symbol: string; sizeMicros: number; fillStep: number; seq: number };

function orderDue(due: OpenPos[], order: ReleaseOrder): OpenPos[] {
  const byKey = (a: OpenPos, b: OpenPos) => a.seq - b.seq;
  switch (order) {
    case "fifo":
      return [...due].sort(byKey);
    case "lifo":
      return [...due].sort((a, b) => b.seq - a.seq);
    case "symbol-asc":
      return [...due].sort((a, b) => a.symbol.localeCompare(b.symbol) || byKey(a, b));
    case "symbol-desc":
      return [...due].sort((a, b) => b.symbol.localeCompare(a.symbol) || byKey(a, b));
    case "size-desc":
      return [...due].sort((a, b) => b.sizeMicros - a.sizeMicros || byKey(a, b));
  }
}

/**
 * Market data is not trustworthy: bars go missing, a feed sends a zero or
 * negative price, a symbol gaps by years, a field arrives as null. None of
 * that may reach the money. Everything entering the ledger is coerced to a
 * finite, sane value here — a bad input can only ever mean "no cost" or "no
 * hold", never a credit, a negative holding or a NaN that poisons the books.
 */
export function sanitiseCosts(c: Costs): Costs {
  const clean = (v: number, max: number) => (!Number.isFinite(v) || v <= 0 ? 0 : Math.min(v, max));
  return {
    commissionBps: clean(c.commissionBps, 5_000),
    minFee: clean(c.minFee, 1e6),
    slippageBps: clean(c.slippageBps, 5_000),
  };
}

/**
 * Capital must be a finite, non-negative bank. Capped at 1e9 units so the
 * micro-unit ledger stays inside exact integer range (1e9 * 1e6 < 2^53) —
 * past that, "integer" arithmetic silently starts rounding.
 */
export function sanitiseCapital(v: number): number {
  return !Number.isFinite(v) || v <= 0 ? 0 : Math.min(v, 1e9);
}


/**
 * Holding period in bars. A missing, NaN, zero, negative or absurd bar count
 * degrades to "close on the next step", which is the safe direction: the
 * position always unwinds rather than being stranded on the book forever.
 */
export function holdBars(row: Row | undefined): number {
  const v = row?.barsHeld;
  if (!Number.isFinite(v as number)) return 1;
  return Math.min(Math.max(1, Math.floor(v as number)), 1e6);
}

/**
 * Walks the plan charging frictions on both sides of every fill, booking each
 * charge on the step where that fill happens.
 */
export function runCostedReplay(
  rows: readonly Row[],
  plan: LimitedPlan,
  rawCapital: number,
  rawCosts: Costs,
  options: ReplayOptions = {},
): Replay {
  const releaseOrder = options.releaseOrder ?? "lifo";
  const costs = sanitiseCosts(rawCosts);
  const capital = sanitiseCapital(rawCapital);
  // Dates are ranked as opaque sortable keys, so a huge gap, a duplicate or a
  // malformed date changes the ranking but never the arithmetic.
  const dates = [...new Set(rows.map((x) => String(x?.date ?? "")))].sort();
  const dateRank = new Map(dates.map((d, i) => [d, i]));
  const capitalMicros = toMicros(capital);


  let cashMicros = capitalMicros;
  let seq = 0;
  const journal: CostLeg[] = [];
  const trace: StepTrace[] = [];
  const fills: Replay["fills"] = [];
  const summary: CostSummary = {
    totalFeeMicros: 0,
    totalSlipMicros: 0,
    totalCostMicros: 0,
    entryFeeMicros: 0,
    entrySlipMicros: 0,
    exitFeeMicros: 0,
    exitSlipMicros: 0,
    filledCount: 0,
    refusedCount: 0,
    terminalCashMicros: 0,
  };

  const open: OpenPos[] = [];

  const legsFor = (sizeMicros: number) => {
    const notional = fromMicros(sizeMicros);
    const slipMicros = toMicros((notional * costs.slippageBps) / 10_000);
    const feeMicros = toMicros((notional * costs.commissionBps) / 10_000 + costs.minFee);
    return { slipMicros, feeMicros };
  };

  const book = (leg: CostLeg) => {
    journal.push(leg);
    cashMicros -= leg.feeMicros + leg.slipMicros;
    summary.totalFeeMicros += leg.feeMicros;
    summary.totalSlipMicros += leg.slipMicros;
    summary.totalCostMicros += leg.feeMicros + leg.slipMicros;
    if (leg.side === "entry") {
      summary.entryFeeMicros += leg.feeMicros;
      summary.entrySlipMicros += leg.slipMicros;
    } else {
      summary.exitFeeMicros += leg.feeMicros;
      summary.exitSlipMicros += leg.slipMicros;
    }
  };

  const release = (upToRank: number, step: number) => {
    const due = open.filter((p) => p.releaseRank <= upToRank);
    if (due.length === 0) return;
    for (const pos of due) open.splice(open.indexOf(pos), 1);
    for (const pos of orderDue(due, releaseOrder)) {
      cashMicros += pos.sizeMicros;
      const { feeMicros, slipMicros } = legsFor(pos.sizeMicros);
      // Exit frictions can never exceed the proceeds they come out of.
      const total = Math.min(feeMicros + slipMicros, pos.sizeMicros);
      const slip = Math.min(slipMicros, total);
      book({
        step,
        side: "exit",
        symbol: pos.symbol,
        fillStep: pos.fillStep,
        feeMicros: total - slip,
        slipMicros: slip,
      });
    }
  };

  plan.signals.forEach((s, i) => {
    const at = dateRank.get(String(s?.date ?? "")) ?? 0;
    release(at, i);

    const rawSize = Number.isFinite(s?.size) ? s.size : 0;
    if (rawSize > 0) {
      // Fee-aware fill: shrink to the notional cash can fund including costs.
      const perUnit = 1 + (costs.slippageBps + costs.commissionBps) / 10_000;
      const affordable = Math.max(0, (fromMicros(cashMicros) - costs.minFee) / perUnit);
      const sizeMicros = Math.max(0, Math.min(toMicros(rawSize), Math.floor(toMicros(affordable))));
      const { feeMicros, slipMicros } = legsFor(sizeMicros);
      if (sizeMicros > 0 && sizeMicros + feeMicros + slipMicros <= cashMicros) {
        cashMicros -= sizeMicros;
        book({ step: i, side: "entry", symbol: s.symbol, fillStep: i, feeMicros, slipMicros });
        const releaseRank = at + holdBars(rows[i]);

        open.push({ releaseRank, symbol: s.symbol, sizeMicros, fillStep: i, seq: seq++ });
        fills.push({ fillStep: i, symbol: s.symbol, sizeMicros, releaseRank });
        summary.filledCount += 1;
      } else {
        summary.refusedCount += 1;
      }
    }

    trace.push({
      step: i,
      cashMicros,
      openNotionalMicros: open.reduce((a, p) => a + p.sizeMicros, 0),
      cumulativeCostMicros: summary.totalCostMicros,
    });
  });

  const finalStep = plan.signals.length;
  release(Number.POSITIVE_INFINITY, finalStep);
  trace.push({
    step: finalStep,
    cashMicros,
    openNotionalMicros: 0,
    cumulativeCostMicros: summary.totalCostMicros,
  });
  summary.terminalCashMicros = cashMicros;
  return { journal, trace, summary, fills, dateRank, capitalMicros };
}
