import { describe, expect, it } from "vitest";
import { applySizingLimits } from "@/lib/breakout-sizing-limits";
import {
  day,
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
  type Replay,
  type Row,
} from "./costed-replay-harness";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * Extreme and malformed market inputs must never break the books.
 *
 * Live feeds misbehave in boring, recurring ways: a bar is missing, a price
 * prints as 0 or negative, a symbol gaps by three years, a date arrives as
 * null, a size comes through as NaN or Infinity, a fee field is negative.
 * None of that is exotic — it happens on ordinary trading days.
 *
 * The rule is that bad data may cost us a trade, but it may never cost us the
 * ledger. Whatever arrives, the replay must hold:
 *
 *   • cash never goes negative,
 *   • no holding is negative and none exceeds the funded book,
 *   • cash + open notional + cumulative cost == capital, exactly, every step,
 *   • every figure is a finite integer in micro-units (no NaN poisoning),
 *   • the book fully unwinds — nothing is stranded open forever,
 *   • costs are never a credit.
 */

const FILE = "src/lib/__tests__/breakout-malformed-market-inputs.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

const BAD_NUMBERS = [
  NaN,
  Infinity,
  -Infinity,
  0,
  -0,
  -1,
  -1e9,
  1e15,
  Number.MIN_VALUE,
  Number.MAX_SAFE_INTEGER,
  undefined as unknown as number,
  null as unknown as number,
];

const BAD_DATES = [
  "",
  "not-a-date",
  "0000-00-00",
  "2025-13-45",
  undefined as unknown as string,
  null as unknown as string,
];

function isCleanMicros(v: number): boolean {
  return Number.isFinite(v) && Number.isInteger(v);
}

/** Every constraint the ledger must satisfy, whatever went in. */
function assertLedgerSound(replay: Replay, label: string) {
  const { trace, summary, journal, capitalMicros, fills } = replay;

  expect(isCleanMicros(capitalMicros), `${label}: capital finite`).toBe(true);
  expect(capitalMicros, `${label}: capital non-negative`).toBeGreaterThanOrEqual(0);

  for (const t of trace) {
    const where = `${label} @step ${t.step}`;
    expect(isCleanMicros(t.cashMicros), `${where}: cash finite`).toBe(true);
    expect(isCleanMicros(t.openNotionalMicros), `${where}: open finite`).toBe(true);
    expect(isCleanMicros(t.cumulativeCostMicros), `${where}: cost finite`).toBe(true);

    // Solvency and no phantom shorts.
    expect(t.cashMicros, `${where}: cash non-negative`).toBeGreaterThanOrEqual(0);
    expect(t.openNotionalMicros, `${where}: holdings non-negative`).toBeGreaterThanOrEqual(0);
    expect(t.cumulativeCostMicros, `${where}: costs never a credit`).toBeGreaterThanOrEqual(0);

    // Nothing may be deployed or spent that the bank never had.
    expect(t.openNotionalMicros, `${where}: book within capital`).toBeLessThanOrEqual(capitalMicros);
    expect(t.cumulativeCostMicros, `${where}: costs within capital`).toBeLessThanOrEqual(capitalMicros);

    // Exact conservation, in integers — no tolerance window.
    expect(t.cashMicros + t.openNotionalMicros + t.cumulativeCostMicros, `${where}: conservation`).toBe(
      capitalMicros,
    );
  }

  for (const leg of journal) {
    const where = `${label} leg ${leg.side}@${leg.step}`;
    expect(isCleanMicros(leg.feeMicros), `${where}: fee finite`).toBe(true);
    expect(isCleanMicros(leg.slipMicros), `${where}: slippage finite`).toBe(true);
    expect(leg.feeMicros, `${where}: fee non-negative`).toBeGreaterThanOrEqual(0);
    expect(leg.slipMicros, `${where}: slippage non-negative`).toBeGreaterThanOrEqual(0);
  }

  for (const f of fills) {
    expect(f.sizeMicros, `${label}: funded fill positive`).toBeGreaterThan(0);
    expect(Number.isFinite(f.releaseRank), `${label}: release scheduled`).toBe(true);
  }

  // The book must unwind: at the end nothing is left open.
  const last = trace[trace.length - 1];
  if (last) {
    expect(last.openNotionalMicros, `${label}: fully unwound`).toBe(0);
    expect(summary.terminalCashMicros, `${label}: terminal cash matches trace`).toBe(last.cashMicros);
  }
  expect(summary.terminalCashMicros, `${label}: terminal cash non-negative`).toBeGreaterThanOrEqual(0);
  expect(summary.totalCostMicros, `${label}: total cost = fee + slippage`).toBe(
    summary.totalFeeMicros + summary.totalSlipMicros,
  );
}

function replayOf(rows: Row[], capital: number, costs: Costs, limits = randomLimits(rng(1))): Replay {
  const plan = applySizingLimits(rows, limits);
  return runCostedReplay(rows, plan, capital, costs);
}

// ---------------------------------------------------------------------------

describe("malformed market inputs — sanitisers", () => {
  it("coerces every bad cost field to a non-negative finite charge", () => {
    for (const v of BAD_NUMBERS) {
      const c = sanitiseCosts({ commissionBps: v, minFee: v, slippageBps: v });
      for (const [k, got] of Object.entries(c)) {
        expect(Number.isFinite(got), `${k} finite for ${String(v)}`).toBe(true);
        expect(got, `${k} non-negative for ${String(v)}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("coerces bad capital to a finite non-negative bank", () => {
    for (const v of BAD_NUMBERS) {
      const got = sanitiseCapital(v);
      expect(Number.isFinite(got)).toBe(true);
      expect(got).toBeGreaterThanOrEqual(0);
    }
  });

  it("degrades a missing or absurd bar count to a next-step release, never a stranded position", () => {
    for (const v of BAD_NUMBERS) {
      const bars = holdBars({ symbol: "A", date: day(0), barsHeld: v, size: 1 });
      expect(Number.isInteger(bars), `bars integer for ${String(v)}`).toBe(true);
      expect(bars, `bars at least one for ${String(v)}`).toBeGreaterThanOrEqual(1);
      expect(bars).toBeLessThanOrEqual(1e6);
    }
    expect(holdBars(undefined)).toBe(1);
  });
});

describe("malformed market inputs — constraints hold", () => {
  it("survives zero, negative and non-finite sizes", () => {
    for (const size of BAD_NUMBERS) {
      const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({
        symbol: `S${i % 3}`,
        date: day(i),
        barsHeld: 2,
        size,
      }));
      assertLedgerSound(replayOf(rows, 100, { commissionBps: 12, minFee: 1, slippageBps: 8 }), `size=${String(size)}`);
    }
  });

  it("survives missing, zero and absurd bar counts", () => {
    for (const barsHeld of BAD_NUMBERS) {
      const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({
        symbol: `S${i % 4}`,
        date: day(i),
        barsHeld,
        size: 0.4,
      }));
      assertLedgerSound(replayOf(rows, 250, { commissionBps: 5, minFee: 2, slippageBps: 15 }), `bars=${String(barsHeld)}`);
    }
  });

  it("survives malformed and duplicated dates", () => {
    for (const date of BAD_DATES) {
      const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({
        symbol: `S${i % 2}`,
        // Half the tape carries the broken date, half is well formed.
        date: i % 2 === 0 ? date : day(i),
        barsHeld: 3,
        size: 0.5,
      }));
      assertLedgerSound(replayOf(rows, 80, { commissionBps: 20, minFee: 0.5, slippageBps: 20 }), `date=${String(date)}`);
    }
  });

  it("survives huge calendar gaps and out-of-order bars", () => {
    const rows: Row[] = [
      { symbol: "A", date: day(0), barsHeld: 4, size: 0.6 },
      { symbol: "B", date: day(9000), barsHeld: 1, size: 0.6 },
      { symbol: "A", date: day(3), barsHeld: 100000, size: 0.6 },
      { symbol: "C", date: day(-4000), barsHeld: 2, size: 0.6 },
      { symbol: "B", date: day(9000), barsHeld: 0, size: 0.6 },
      { symbol: "C", date: day(20000), barsHeld: 7, size: 0.6 },
    ];
    assertLedgerSound(replayOf(rows, 120, { commissionBps: 30, minFee: 3, slippageBps: 25 }), "gaps");
  });

  it("survives a bank of zero, a bank of nothing valid, and free-money cost fields", () => {
    const rows: Row[] = Array.from({ length: 8 }, (_, i) => ({
      symbol: `S${i % 2}`,
      date: day(i),
      barsHeld: 2,
      size: 1,
    }));
    for (const capital of [0, -50, NaN, Infinity]) {
      assertLedgerSound(
        replayOf(rows, capital, { commissionBps: -10, minFee: -5, slippageBps: NaN }),
        `capital=${String(capital)}`,
      );
    }
  });

  it("never funds a book it cannot hold, even with extreme cost fields", () => {
    const rows: Row[] = Array.from({ length: 20 }, (_, i) => ({
      symbol: `S${i % 5}`,
      date: day(Math.floor(i / 2)),
      barsHeld: 3,
      size: 5,
    }));
    for (const costs of [
      { commissionBps: 5000, minFee: 0, slippageBps: 5000 },
      { commissionBps: 0, minFee: 1e9, slippageBps: 0 },
      { commissionBps: 1e12, minFee: 1e12, slippageBps: 1e12 },
    ]) {
      const replay = replayOf(rows, 100, costs);
      assertLedgerSound(replay, `costs=${JSON.stringify(costs)}`);
      expect(fromMicros(replay.summary.totalCostMicros)).toBeLessThanOrEqual(100);
    }
  });
});

describe("malformed market inputs — fuzzed corruption", () => {
  it("holds every constraint when a random slice of the tape is corrupted", () => {
    for (let c = 0; c < 200; c += 1) {
      const seed = caseSeed(BASE_SEED, "corrupted-tape", c);
      const r = rng(seed);
      const rows = randomRows(r, 6 + Math.floor(r() * 40));

      // Corrupt roughly a third of the tape with realistic feed garbage.
      const corrupted: Row[] = rows.map((row) => {
        if (r() > 0.35) return row;
        const pick = Math.floor(r() * 3);
        if (pick === 0) return { ...row, size: BAD_NUMBERS[Math.floor(r() * BAD_NUMBERS.length)]! };
        if (pick === 1) return { ...row, barsHeld: BAD_NUMBERS[Math.floor(r() * BAD_NUMBERS.length)]! };
        return { ...row, date: BAD_DATES[Math.floor(r() * BAD_DATES.length)]! };
      });

      const costs = r() < 0.25 ? { commissionBps: -1, minFee: NaN, slippageBps: Infinity } : randomCosts(r);
      const capital = r() < 0.15 ? BAD_NUMBERS[Math.floor(r() * BAD_NUMBERS.length)]! : 50 + r() * 5000;

      const plan = applySizingLimits(corrupted, randomLimits(r));
      const replay = runCostedReplay(corrupted, plan, capital, costs);
      assertLedgerSound(replay, `seed ${seed} — repro: ${REPRO}`);

      // A corrupted tape may trade less, but it may never invent capital.
      expect(replay.capitalMicros).toBe(toMicros(sanitiseCapital(capital)));
    }
  });
});
