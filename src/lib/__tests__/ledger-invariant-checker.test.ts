import { describe, expect, it } from "vitest";
import {
  assertLedgerReconciles,
  checkLedgerInvariants,
  expectedCashDelta,
  smallestViolatingFills,
  type LedgerFill,
} from "@/lib/ledger-invariant-checker";
import { announceFuzzSeed, caseSeed, reproCommand, resolveFuzzSeed, rng } from "./fuzz-seed";

/**
 * The checker is the thing every other reconciliation suite leans on when it
 * fails, so it needs its own guarantees: clean runs must stay clean, broken
 * runs must be pinpointed to the exact step and delta, and the minimiser must
 * shrink a large cohort to the handful of fills that actually break it.
 */

const FILE = "src/lib/__tests__/ledger-invariant-checker.test.ts";
const BASE_SEED = resolveFuzzSeed();
const REPRO = reproCommand(BASE_SEED, FILE);
announceFuzzSeed(BASE_SEED, FILE);

const fill = (over: Partial<LedgerFill> & Pick<LedgerFill, "id" | "symbol" | "side">): LedgerFill => ({
  quantity: 10,
  price: 100,
  fees: 5,
  ...over,
});

function buildCleanRun(seed: number) {
  const r = rng(seed);
  const symbols = ["AAPL", "NVDA", "HSBA.L", "ULVR.L", "ASML.AS"];
  const held = new Map<string, number>();
  const fills: LedgerFill[] = [];
  let cash = 250_000;

  const count = 5 + Math.floor(r() * 60);
  for (let i = 0; i < count; i++) {
    const symbol = symbols[Math.floor(r() * symbols.length)]!;
    const price = Number((20 + r() * 400).toFixed(4));
    const have = held.get(symbol) ?? 0;
    const side: "buy" | "sell" = have > 0 && r() < 0.45 ? "sell" : "buy";
    const affordable = Math.floor((cash - 50) / price);
    const quantity =
      side === "buy" ? Math.min(affordable, 1 + Math.floor(r() * 50)) : Math.max(1, Math.floor(have * r()));
    if (quantity <= 0) continue;

    const f = fill({ id: `F${i}`, symbol, side, quantity, price, fees: Number((r() * 12).toFixed(4)) });
    const delta = expectedCashDelta(f);
    if (cash + delta < 0) continue;
    cash += delta;
    held.set(symbol, side === "buy" ? have + quantity : have - quantity);
    fills.push(f);
  }
  for (const [k, q] of held) if (q === 0) held.delete(k);
  return { fills, startingCash: 250_000, finalCash: cash, finalHoldings: Object.fromEntries(held) };
}

describe("ledger invariant checker — clean runs", () => {
  it("passes fuzzed self-consistent runs and reconstructs the closing state", () => {
    for (let c = 0; c < 200; c++) {
      const seed = caseSeed(BASE_SEED, "clean", c);
      const run = buildCleanRun(seed);
      const msg = `${REPRO} (case ${c}, seed ${seed})`;
      const result = checkLedgerInvariants(run.fills, {
        startingCash: run.startingCash,
        epsilon: 1e-6,
        expectedFinalCash: run.finalCash,
        expectedFinalHoldings: run.finalHoldings,
      });
      expect(result.violations.map((v) => v.message).join("\n") || "ok", msg).toBe("ok");
      expect(result.ok, msg).toBe(true);
      expect(result.smallestViolating, msg).toEqual([]);
      expect(result.report, msg).toContain("ledger OK");
      expect(result.steps.length, msg).toBe(run.fills.length);
    }
  });

  it("snapshots cash and holdings before and after every step", () => {
    const fills = [
      fill({ id: "A", symbol: "AAPL", side: "buy", quantity: 10, price: 100, fees: 5 }),
      fill({ id: "B", symbol: "AAPL", side: "sell", quantity: 4, price: 110, fees: 3 }),
    ];
    const r = checkLedgerInvariants(fills, { startingCash: 2_000 });
    expect(r.ok).toBe(true);
    expect(r.steps[0]).toMatchObject({
      cashBefore: 2_000,
      cashAfter: 995,
      cashDelta: -1_005,
      holdingBefore: 0,
      holdingAfter: 10,
    });
    expect(r.steps[1]).toMatchObject({ cashAfter: 1_432, holdingAfter: 6 });
    expect(r.steps[1]?.holdings).toEqual({ AAPL: 6 });
    expect(r.finalCash).toBe(1_432);
    expect(r.finalHoldings).toEqual({ AAPL: 6 });
  });

  it("carries opening positions through a resumed replay", () => {
    const r = checkLedgerInvariants(
      [fill({ id: "S", symbol: "NVDA", side: "sell", quantity: 30, price: 50, fees: 2 })],
      { startingCash: 0, startingHoldings: { NVDA: 30 } },
    );
    expect(r.ok).toBe(true);
    expect(r.finalCash).toBe(1_498);
    expect(r.finalHoldings).toEqual({});
  });

  it("allows negative cash and shorts only when explicitly permitted", () => {
    const fills = [fill({ id: "X", symbol: "AAPL", side: "buy", quantity: 10, price: 100, fees: 0 })];
    expect(checkLedgerInvariants(fills, { startingCash: 0 }).ok).toBe(false);
    expect(checkLedgerInvariants(fills, { startingCash: 0, allowNegativeCash: true }).ok).toBe(true);
  });
});

describe("ledger invariant checker — exact deltas on failure", () => {
  it("reports the offending step, the shortfall, and the surrounding snapshots", () => {
    const fills = [
      fill({ id: "ok1", symbol: "AAPL", side: "buy", quantity: 5, price: 100, fees: 1 }),
      fill({ id: "ok2", symbol: "NVDA", side: "buy", quantity: 2, price: 200, fees: 1 }),
      fill({ id: "BAD", symbol: "ULVR.L", side: "buy", quantity: 100, price: 46.8, fees: 4, note: "gbx?" }),
      fill({ id: "ok3", symbol: "AAPL", side: "sell", quantity: 5, price: 101, fees: 1 }),
    ];
    const r = checkLedgerInvariants(fills, { startingCash: 1_000 });
    expect(r.ok).toBe(false);
    expect(r.first?.code).toBe("negative_cash");
    expect(r.first?.index).toBe(2);
    expect(r.first?.fill?.id).toBe("BAD");
    // cash: 1000 - 501 - 401 - 4684 = -3586
    expect(r.first?.actual).toBeCloseTo(-3_586, 6);
    expect(r.first?.delta).toBeCloseTo(-3_586, 6);
    expect(r.report).toContain("LEDGER RECONCILIATION FAILED");
    expect(r.report).toContain("negative_cash");
    expect(r.report).toContain("gbx?");
    // Context window shows the neighbours, not just the break.
    expect(r.report).toContain("ok2");
    expect(r.report).toContain("ok3");
  });

  it("flags overselling with the exact holding shortfall", () => {
    const fills = [
      fill({ id: "b", symbol: "AAPL", side: "buy", quantity: 4, price: 10, fees: 0 }),
      fill({ id: "s", symbol: "AAPL", side: "sell", quantity: 6.5, price: 10, fees: 0 }),
    ];
    const r = checkLedgerInvariants(fills, { startingCash: 1_000 });
    expect(r.first?.code).toBe("negative_holding");
    expect(r.first?.actual).toBeCloseTo(-2.5, 9);
    expect(r.first?.message).toContain("AAPL");
  });

  it("reports closing-total disagreements against the replay summary", () => {
    const fills = [fill({ id: "a", symbol: "AAPL", side: "buy", quantity: 1, price: 100, fees: 2 })];
    const r = checkLedgerInvariants(fills, {
      startingCash: 500,
      expectedFinalCash: 400,
      expectedFinalHoldings: { AAPL: 2 },
    });
    const codes = r.violations.map((v) => v.code);
    expect(codes).toContain("final_cash_mismatch");
    expect(codes).toContain("final_holdings_mismatch");
    const cashV = r.violations.find((v) => v.code === "final_cash_mismatch")!;
    expect(cashV.actual).toBe(398);
    expect(cashV.delta).toBeCloseTo(-2, 9);
    const holdV = r.violations.find((v) => v.code === "final_holdings_mismatch")!;
    expect(holdV.delta).toBeCloseTo(-1, 9);
  });

  it("catches NaN poisoning instead of letting it spread", () => {
    const r = checkLedgerInvariants(
      [fill({ id: "nan", symbol: "AAPL", side: "buy", quantity: Number.NaN, price: 10 })],
      { startingCash: 100 },
    );
    expect(r.first?.code).toBe("invalid_input");
    expect(Number.isFinite(r.finalCash)).toBe(true);
  });

  it("assertLedgerReconciles throws with the full diagnosis", () => {
    expect(() =>
      assertLedgerReconciles(
        [fill({ id: "z", symbol: "AAPL", side: "buy", quantity: 10, price: 100, fees: 0 })],
        { startingCash: 10 },
        "hourly run #42",
      ),
    ).toThrow(/hourly run #42[\s\S]*negative_cash/);
    expect(() =>
      assertLedgerReconciles([fill({ id: "z", symbol: "AAPL", side: "buy", quantity: 1, price: 1 })], {
        startingCash: 10,
      }),
    ).not.toThrow();
  });
});

describe("ledger invariant checker — smallest violating trade", () => {
  it("shrinks a large clean cohort plus one bad fill down to that fill", () => {
    for (let c = 0; c < 40; c++) {
      const seed = caseSeed(BASE_SEED, "shrink", c);
      const run = buildCleanRun(seed);
      const msg = `${REPRO} (case ${c}, seed ${seed})`;
      if (run.fills.length < 5) continue;

      // One oversell of a symbol never bought: the only cause of the failure.
      const poison = fill({ id: "POISON", symbol: "ZZZZ", side: "sell", quantity: 7, price: 12, fees: 0 });
      const at = Math.floor(run.fills.length / 2);
      const fills = [...run.fills.slice(0, at), poison, ...run.fills.slice(at)];

      const r = checkLedgerInvariants(fills, { startingCash: run.startingCash, epsilon: 1e-6 });
      expect(r.ok, msg).toBe(false);
      expect(r.first?.code, msg).toBe("negative_holding");
      expect(r.smallestViolating.length, msg).toBe(1);
      expect(r.smallestViolating[0]?.id, msg).toBe("POISON");
      expect(r.report, msg).toContain("smallest violating trade set (1 of");
    }
  });

  it("finds the minimal prefix that exhausts cash", () => {
    const fills = Array.from({ length: 12 }, (_, i) =>
      fill({ id: `B${i}`, symbol: "AAPL", side: "buy", quantity: 1, price: 100, fees: 0 }),
    );
    const r = checkLedgerInvariants(fills, { startingCash: 250 });
    expect(r.first?.code).toBe("negative_cash");
    expect(r.first?.index).toBe(2);
    // Any 3 of these identical buys overdraw the account; no 2 do.
    expect(r.smallestViolating.length).toBe(3);
    expect(smallestViolatingFills(fills.slice(0, 2), { startingCash: 250 }, "negative_cash")).toEqual(
      [],
    );
  });

  it("keeps the minimiser on the same invariant when several are broken", () => {
    const fills = [
      fill({ id: "oversell", symbol: "TSLA", side: "sell", quantity: 3, price: 100, fees: 0 }),
      ...Array.from({ length: 8 }, (_, i) =>
        fill({ id: `spend${i}`, symbol: "AAPL", side: "buy", quantity: 1, price: 100, fees: 0 }),
      ),
    ];
    const r = checkLedgerInvariants(fills, { startingCash: 400 });
    expect(new Set(r.violations.map((v) => v.code))).toEqual(
      new Set(["negative_holding", "negative_cash"]),
    );
    expect(r.first?.code).toBe("negative_holding");
    expect(r.smallestViolating.map((f) => f.id)).toEqual(["oversell"]);
    // Asking for the other invariant shrinks to its own minimum instead.
    expect(smallestViolatingFills(fills, { startingCash: 400 }, "negative_cash")).toHaveLength(5);
  });

  it("does not attempt to shrink whole-run closing mismatches", () => {
    const fills = [fill({ id: "a", symbol: "AAPL", side: "buy", quantity: 1, price: 10, fees: 0 })];
    const r = checkLedgerInvariants(fills, { startingCash: 100, expectedFinalCash: 0 });
    expect(r.first?.code).toBe("final_cash_mismatch");
    expect(r.smallestViolating).toEqual([]);
  });

  it("is deterministic — same input, byte-identical report", () => {
    for (let c = 0; c < 25; c++) {
      const seed = caseSeed(BASE_SEED, "determinism", c);
      const run = buildCleanRun(seed);
      const fills = [
        ...run.fills,
        fill({ id: "P", symbol: "QQQQ", side: "sell", quantity: 2, price: 5, fees: 0 }),
      ];
      const a = checkLedgerInvariants(fills, { startingCash: run.startingCash, epsilon: 1e-6 });
      const b = checkLedgerInvariants(fills, { startingCash: run.startingCash, epsilon: 1e-6 });
      expect(a.report).toBe(b.report);
      expect(a.smallestViolating).toEqual(b.smallestViolating);
    }
  });
});
