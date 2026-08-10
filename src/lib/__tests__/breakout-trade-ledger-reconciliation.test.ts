import { describe, expect, it } from "vitest";
import { applySizingLimits, resolveSizingLimits, type SizingLimits } from "@/lib/breakout-sizing-limits";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Trade list vs ledger: every movement is attributable to a trade.
 *
 * The differential suite already proves the replay *summary* agrees with a
 * step-by-step walk. This one goes a level finer and reconciles the two things
 * a user actually reads side by side: the list of executed trades, and the cash
 * / holdings balances that list is supposed to explain.
 *
 * The rule enforced here is the one a bookkeeper would state: for every step,
 *
 *     cash[t] - cash[t-1]      == sum of the cash legs booked at step t
 *     holding[sym][t] - [t-1]  == sum of that symbol's holding legs at step t
 *
 * with no movement left over on either side. That catches the failures a
 * summary-level check cannot see: a fill posted to the balance but missing from
 * the trade list (or vice versa), an exit credited to the wrong symbol, a
 * double-booked entry, or a partial clamp where the trade row records the
 * requested size while the balance moves by the allowed size.
 *
 * Arithmetic is done in integer micro-units, so "exact" means exact — no
 * tolerance window that could hide a small systematic leak. Sizes are
 * quantised once, up front, and both the trade list and the ledger are built
 * from the same quantised values, so any difference is a real attribution bug
 * rather than float noise.
 */

const FILE = "src/lib/__tests__/breakout-trade-ledger-reconciliation.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

/** 1 unit of size == 1e6 micro-units; all ledger maths is integer. */
const MICRO = 1_000_000;
const toMicro = (x: number) => Math.round(x * MICRO);

const day = (i: number) => {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
};

type Row = { symbol: string; date: string; barsHeld: number; size: number; returnPct: number };

function randomRows(r: () => number, n: number): Row[] {
  const symbols = 1 + Math.floor(r() * 8);
  const perDay = 1 + Math.floor(r() * 3);
  return Array.from({ length: n }, (_, i) => ({
    symbol: `S${i % symbols}`,
    date: day(Math.floor(i / perDay)),
    barsHeld: 1 + Math.floor(r() * 10),
    size: r() < 0.08 ? 0 : r() * 2.5,
    returnPct: Math.round((r() - 0.45) * 1200) / 100,
  }));
}

function randomLimits(r: () => number): SizingLimits {
  return resolveSizingLimits({
    maxPositionSize: 0.4 + r() * 1.8,
    maxConcurrentSignals: 1 + Math.floor(r() * 12),
    maxTotalDeployedPct: 20 + r() * 280,
  });
}

// ---------------------------------------------------------------------------
// Cost model: commission, spread and FX fee legs
// ---------------------------------------------------------------------------

/**
 * Real fills never move cash by the notional alone. Three frictions are booked
 * as their own cash legs so they can be reconciled independently:
 *
 *   commission — bps of notional with a per-ticket minimum (Saxo-style)
 *   spread     — half the quoted spread, charged on both sides of the round trip
 *   fx fee     — bps of notional, only on instruments quoted in a foreign ccy
 *
 * They are cash-only: a fee never changes the share count, so the holdings
 * reconciliation must stay untouched by them. Each fee is booked on the exact
 * step of the fill that incurred it, so a cost that leaks into the wrong step
 * (or is netted silently into the fill price) breaks the step reconciliation.
 */
type CostModel = {
  commissionBps: number;
  minCommissionMicro: number;
  halfSpreadBps: number;
  fxFeeBps: number;
  /** Symbols quoted in a foreign currency, i.e. the ones the FX fee applies to. */
  foreign: ReadonlySet<string>;
};

const ZERO_COSTS: CostModel = {
  commissionBps: 0,
  minCommissionMicro: 0,
  halfSpreadBps: 0,
  fxFeeBps: 0,
  foreign: new Set(),
};

function randomCosts(r: () => number, symbols: readonly string[]): CostModel {
  const foreign = new Set(symbols.filter(() => r() < 0.5));
  return {
    commissionBps: Math.round(r() * 25),
    minCommissionMicro: Math.round(r() * 5000),
    halfSpreadBps: Math.round(r() * 40),
    fxFeeBps: Math.round(r() * 30),
    foreign,
  };
}

const bpsOf = (notionalMicro: number, bps: number) => (bps <= 0 ? 0 : Math.round((notionalMicro * bps) / 10_000));

type CostKind = "commission" | "spread" | "fx";
const COST_KINDS: readonly CostKind[] = ["commission", "spread", "fx"];
type CostBreakdown = Record<CostKind, number>;

/** Costs charged on one fill leg, as positive amounts (they debit cash). */
function costsFor(costs: CostModel, symbol: string, notionalMicro: number): CostBreakdown {
  const notional = Math.max(0, notionalMicro);
  if (notional === 0) return { commission: 0, spread: 0, fx: 0 };
  const commission = Math.max(costs.minCommissionMicro, bpsOf(notional, costs.commissionBps));
  return {
    commission,
    spread: bpsOf(notional, costs.halfSpreadBps),
    fx: costs.foreign.has(symbol) ? bpsOf(notional, costs.fxFeeBps) : 0,
  };
}

const sumCosts = (b: CostBreakdown) => b.commission + b.spread + b.fx;

// ---------------------------------------------------------------------------
// The executed trade list (what the UI renders) and the ledger legs it implies
// ---------------------------------------------------------------------------

type Leg = {
  step: number;
  tradeId: number;
  symbol: string;
  kind: "entry" | "exit" | CostKind;
  /** Which fill the leg belongs to — fees settle with their own fill. */
  parent: "entry" | "exit";
  cashMicro: number;
  holdingMicro: number;
};

const isCostLeg = (l: Leg): l is Leg & { kind: CostKind } => l.kind !== "entry" && l.kind !== "exit";

type ExecutedTrade = {
  id: number;
  symbol: string;
  entryStep: number;
  exitStep: number;
  sizeMicro: number;
  /** Cash paid out at entry (negative) plus cash returned at exit (positive), before fees. */
  cashLegsMicro: [number, number];
  holdingLegsMicro: [number, number];
  pnlMicro: number;
  /** Fees on the entry fill and on the exit fill, as positive debits. */
  entryCosts: CostBreakdown;
  exitCosts: CostBreakdown;
  costsMicro: number;
};

type Book = {
  trades: ExecutedTrade[];
  legs: Leg[];
  steps: number;
  capitalMicro: number;
  costs: CostModel;
};

/**
 * Build the executed trade list from the sized plan.
 *
 * Each funded signal becomes one trade with an entry that debits cash and
 * credits the holding, an exit `barsHeld` steps later that does the reverse
 * plus P&L, and — when a cost model is supplied — commission, spread and FX
 * legs attached to each of those two fills. Skipped signals produce no trade
 * and no leg, which is itself part of what gets reconciled.
 */
function buildBook(rows: readonly Row[], limits: SizingLimits, costs: CostModel = ZERO_COSTS): Book {
  const dates = [...new Set(rows.map((x) => x.date))].sort();
  const rank = new Map(dates.map((d, i) => [d, i]));
  const plan = applySizingLimits(rows, limits);

  const trades: ExecutedTrade[] = [];
  const legs: Leg[] = [];
  let lastStep = 0;

  plan.signals.forEach((s, i) => {
    const sizeMicro = toMicro(s.size);
    if (sizeMicro <= 0) return;
    const row = rows[i];
    const entryStep = rank.get(s.date) ?? 0;
    const exitStep = entryStep + Math.max(1, row.barsHeld);
    // P&L is booked in the same integer space so the exit credit is exact.
    // `|| 0` normalises -0, which is arithmetically identical but fails Object.is.
    const pnlMicro = Math.round((sizeMicro * row.returnPct) / 100) || 0;
    const id = trades.length;
    const exitGross = sizeMicro + pnlMicro;

    // Fees are charged on the traded notional of each side: the cash paid in at
    // entry, and the gross proceeds at exit (a loss shrinks the exit ticket).
    const entryCosts = costsFor(costs, s.symbol, sizeMicro);
    const exitCosts = costsFor(costs, s.symbol, exitGross);

    trades.push({
      id,
      symbol: s.symbol,
      entryStep,
      exitStep,
      sizeMicro,
      cashLegsMicro: [-sizeMicro, exitGross],
      holdingLegsMicro: [sizeMicro, -sizeMicro],
      pnlMicro,
      entryCosts,
      exitCosts,
      costsMicro: sumCosts(entryCosts) + sumCosts(exitCosts),
    });
    legs.push(
      {
        step: entryStep,
        tradeId: id,
        symbol: s.symbol,
        kind: "entry",
        parent: "entry",
        cashMicro: -sizeMicro,
        holdingMicro: sizeMicro,
      },
      {
        step: exitStep,
        tradeId: id,
        symbol: s.symbol,
        kind: "exit",
        parent: "exit",
        cashMicro: exitGross,
        holdingMicro: -sizeMicro,
      },
    );
    for (const [parent, step, breakdown] of [
      ["entry", entryStep, entryCosts],
      ["exit", exitStep, exitCosts],
    ] as const) {
      for (const kind of COST_KINDS) {
        const amount = breakdown[kind];
        if (amount === 0) continue;
        legs.push({
          step,
          tradeId: id,
          symbol: s.symbol,
          kind,
          parent,
          cashMicro: -amount,
          holdingMicro: 0,
        });
      }
    }
    if (exitStep > lastStep) lastStep = exitStep;
  });

  const capitalMicro = toMicro((rows.length * limits.maxTotalDeployedPct) / 100);
  return { trades, legs, steps: lastStep + 1, capitalMicro, costs };
}

// ---------------------------------------------------------------------------
// The ledger: balances only, rebuilt independently of the trade rows
// ---------------------------------------------------------------------------

type LedgerStep = { step: number; cashMicro: number; holdingsMicro: Map<string, number> };

/**
 * Replay the legs into running balances. Deliberately dumb: it applies whatever
 * legs exist and records the resulting balance, so it cannot silently agree
 * with the trade list by construction — the assertions do the tying-out.
 */
function runLedger(book: Book): LedgerStep[] {
  const byStep = new Map<number, Leg[]>();
  for (const leg of book.legs) {
    const bucket = byStep.get(leg.step);
    if (bucket) bucket.push(leg);
    else byStep.set(leg.step, [leg]);
  }

  let cash = book.capitalMicro;
  const holdings = new Map<string, number>();
  const out: LedgerStep[] = [];

  for (let step = 0; step < book.steps; step++) {
    // Exits settle before entries at the same step, matching the engine's
    // release-then-open ordering; integer maths makes the order irrelevant to
    // the totals, but it keeps intermediate balances realistic.
    const here = (byStep.get(step) ?? []).slice().sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "exit" ? -1 : 1));
    for (const leg of here) {
      cash += leg.cashMicro;
      const held = (holdings.get(leg.symbol) ?? 0) + leg.holdingMicro;
      if (held === 0) holdings.delete(leg.symbol);
      else holdings.set(leg.symbol, held);
    }
    out.push({ step, cashMicro: cash, holdingsMicro: new Map(holdings) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

function reconcile(rows: readonly Row[], limits: SizingLimits, ctx: string) {
  const book = buildBook(rows, limits);
  const ledger = runLedger(book);

  const legsAt = (step: number) => book.legs.filter((l) => l.step === step);

  let prevCash = book.capitalMicro;
  let prevHoldings = new Map<string, number>();

  for (const snap of ledger) {
    const here = legsAt(snap.step);

    // 1. Cash: the step's balance change equals the sum of that step's cash legs.
    const cashDelta = snap.cashMicro - prevCash;
    const legCash = here.reduce((a, l) => a + l.cashMicro, 0);
    expect(cashDelta, `cash delta at step ${snap.step} is not explained by the trade legs: ${ctx}`).toBe(legCash);

    // 2. Holdings: same rule, per symbol, over the union of both sides so a
    //    balance that moved without a leg (or a leg with no balance move) fails.
    const symbols = new Set<string>([...prevHoldings.keys(), ...snap.holdingsMicro.keys(), ...here.map((l) => l.symbol)]);
    for (const symbol of symbols) {
      const delta = (snap.holdingsMicro.get(symbol) ?? 0) - (prevHoldings.get(symbol) ?? 0);
      const legHold = here.filter((l) => l.symbol === symbol).reduce((a, l) => a + l.holdingMicro, 0);
      expect(delta, `holding delta for ${symbol} at step ${snap.step} is not explained by its legs: ${ctx}`).toBe(
        legHold,
      );
    }

    // 3. No holding may go short — a mis-attributed exit shows up here first.
    for (const [symbol, qty] of snap.holdingsMicro) {
      expect(qty, `holding for ${symbol} went negative at step ${snap.step}: ${ctx}`).toBeGreaterThan(0);
    }

    prevCash = snap.cashMicro;
    prevHoldings = snap.holdingsMicro;
  }

  return { book, ledger };
}

const CASES = 60;

describe("executed trades reconcile to the cash/holdings ledger", () => {
  it("every per-step balance change is exactly the sum of that step's trade legs", () => {
    for (let c = 0; c < CASES; c++) {
      const r = rng(caseSeed(BASE_SEED, "steps", c));
      const rows = randomRows(r, 20 + Math.floor(r() * 120));
      reconcile(rows, randomLimits(r), `case ${c} — ${REPRO}`);
    }
  });

  it("each trade's own legs net to zero holdings and to its P&L in cash", () => {
    for (let c = 0; c < CASES; c++) {
      const r = rng(caseSeed(BASE_SEED, "per-trade", c));
      const { book } = reconcile(randomRows(r, 30 + Math.floor(r() * 90)), randomLimits(r), `case ${c} — ${REPRO}`);
      for (const t of book.trades) {
        const ctx = `trade ${t.id} (${t.symbol}) — case ${c} — ${REPRO}`;
        expect(t.holdingLegsMicro[0] + t.holdingLegsMicro[1], `holding legs do not net to flat: ${ctx}`).toBe(0);
        expect(t.cashLegsMicro[0] + t.cashLegsMicro[1], `cash legs do not net to P&L: ${ctx}`).toBe(t.pnlMicro);
        expect(t.cashLegsMicro[0], `entry did not debit the full size: ${ctx}`).toBe(-t.sizeMicro);
        expect(t.exitStep, `exit does not follow entry: ${ctx}`).toBeGreaterThan(t.entryStep);
      }
    }
  });

  it("the closing balances equal capital plus total P&L, with a flat book", () => {
    for (let c = 0; c < CASES; c++) {
      const r = rng(caseSeed(BASE_SEED, "close", c));
      const { book, ledger } = reconcile(
        randomRows(r, 25 + Math.floor(r() * 100)),
        randomLimits(r),
        `case ${c} — ${REPRO}`,
      );
      const last = ledger[ledger.length - 1];
      const ctx = `case ${c} — ${REPRO}`;
      if (!last) {
        expect(book.trades.length, `no ledger steps but trades exist: ${ctx}`).toBe(0);
        continue;
      }
      const pnl = book.trades.reduce((a, t) => a + t.pnlMicro, 0);
      expect(last.cashMicro, `closing cash != capital + P&L: ${ctx}`).toBe(book.capitalMicro + pnl);
      expect(last.holdingsMicro.size, `book was not flat at the end: ${ctx}`).toBe(0);
    }
  });

  it("total legs equal the total of the trade list, with nothing unattributed", () => {
    for (let c = 0; c < CASES; c++) {
      const r = rng(caseSeed(BASE_SEED, "totals", c));
      const { book } = reconcile(randomRows(r, 40 + Math.floor(r() * 60)), randomLimits(r), `case ${c} — ${REPRO}`);
      const ctx = `case ${c} — ${REPRO}`;

      // Two legs per trade and no orphans: every leg maps to a listed trade.
      expect(book.legs.length, `leg count != 2 per trade: ${ctx}`).toBe(book.trades.length * 2);
      const ids = new Set(book.trades.map((t) => t.id));
      for (const leg of book.legs) {
        expect(ids.has(leg.tradeId), `leg references an unlisted trade: ${ctx}`).toBe(true);
      }

      const legCash = book.legs.reduce((a, l) => a + l.cashMicro, 0);
      const tradeCash = book.trades.reduce((a, t) => a + t.cashLegsMicro[0] + t.cashLegsMicro[1], 0);
      expect(legCash, `ledger cash total != trade list cash total: ${ctx}`).toBe(tradeCash);

      const legHold = book.legs.reduce((a, l) => a + l.holdingMicro, 0);
      expect(legHold, `holdings did not net to zero across the run: ${ctx}`).toBe(0);

      // Per-symbol: gross bought equals gross sold, symbol by symbol.
      const bought = new Map<string, number>();
      const sold = new Map<string, number>();
      for (const leg of book.legs) {
        const target = leg.kind === "entry" ? bought : sold;
        target.set(leg.symbol, (target.get(leg.symbol) ?? 0) + Math.abs(leg.holdingMicro));
      }
      for (const [symbol, qty] of bought) {
        expect(sold.get(symbol) ?? 0, `unwind mismatch for ${symbol}: ${ctx}`).toBe(qty);
      }
    }
  });

  it("skipped signals contribute no trade row and no ledger movement", () => {
    for (let c = 0; c < CASES; c++) {
      const r = rng(caseSeed(BASE_SEED, "skips", c));
      const rows = randomRows(r, 30 + Math.floor(r() * 70));
      const limits = randomLimits(r);
      const plan = applySizingLimits(rows, limits);
      const { book } = reconcile(rows, limits, `case ${c} — ${REPRO}`);
      const funded = plan.signals.filter((s) => toMicro(s.size) > 0).length;
      expect(book.trades.length, `trade count != funded signals — case ${c} — ${REPRO}`).toBe(funded);
    }
  });

  it("a fabricated extra credit is caught by the step reconciliation", () => {
    // Negative control: if the balance moved by more than the trade list says,
    // the reconciliation must fail. Without this the suite could pass vacuously.
    const r = rng(caseSeed(BASE_SEED, "control", 0));
    const rows = randomRows(r, 60).map((row, i) => (i === 0 ? { ...row, size: 1 } : row));
    const limits = resolveSizingLimits({ maxPositionSize: 2, maxConcurrentSignals: 8, maxTotalDeployedPct: 200 });
    const book = buildBook(rows, limits);
    expect(book.trades.length, `control needs at least one trade — ${REPRO}`).toBeGreaterThan(0);

    const tampered: Book = {
      ...book,
      legs: book.legs.map((l, i) => (i === 0 ? { ...l, cashMicro: l.cashMicro - 1 } : l)),
    };
    const ledger = runLedger(tampered);
    const step0 = ledger.find((s) => s.step === tampered.legs[0].step)!;
    const before = tampered.capitalMicro;
    const legCashFromList = book.legs
      .filter((l) => l.step === tampered.legs[0].step)
      .reduce((a, l) => a + l.cashMicro, 0);
    expect(step0.cashMicro - before, `tampering went undetected — ${REPRO}`).not.toBe(legCashFromList);
  });
});
