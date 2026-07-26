// Integration test for the "Saxo returned InsufficientCash → skip subsequent
// buys until cash grows" lockout that the live executor applies before
// placing new orders.
//
// The lockout decision is a pure function of two database views:
//   1. Recent InsufficientCash buy rejects on this portfolio (`live_orders`).
//   2. CASH_SYNC observations recorded after the newest reject
//      (`live_broker_log.method='CASH_SYNC'`, `response.brokerCash`).
//
// This test walks the full time-ordered sequence a real tick would produce:
//   T0  — clean state, buy is allowed.
//   T1  — Saxo rejects a buy with `Reason: InsufficientCash`.
//   T2  — next tick's CASH_SYNC shows the same (or lower) broker cash: the
//         executor MUST skip every new buy for the tick.
//   T3  — a CASH_SYNC finally shows a material increase in broker cash: the
//         lockout MUST self-clear and buys are allowed again.
//
// The test also asserts the sell-side is untouched (only buys are gated) and
// that near-zero drift (below both the absolute and relative thresholds)
// does not count as growth.

import { describe, it, expect } from "vitest";
import {
  decideInsufficientCashLockout,
  type CashSyncObservation,
  type InsufficientCashReject,
} from "@/lib/insufficient-cash-lockout";

// Helper: given the world state, decide which of a routable batch of orders
// the executor would skip up-front due to the InsufficientCash lockout. This
// mirrors the loop inside `routeOrdersToBroker` that stamps `preSkips` for
// buys when the decision is `lockout: true`.
function applyLockoutToBatch(
  routable: Array<{ symbol: string; side: "buy" | "sell" }>,
  world: { rejects: InsufficientCashReject[]; cashSyncs: CashSyncObservation[] },
): { skipped: Record<string, string>; decision: ReturnType<typeof decideInsufficientCashLockout> } {
  const decision = decideInsufficientCashLockout(world);
  const skipped: Record<string, string> = {};
  if (decision.lockout) {
    for (const o of routable) {
      if (o.side === "buy") skipped[`${o.symbol}:${o.side}`] = decision.reason!;
    }
  }
  return { skipped, decision };
}

describe("insufficient-cash lockout — full tick timeline", () => {
  const buys = [
    { symbol: "VMID.L", side: "buy" as const },
    { symbol: "V", side: "buy" as const },
    { symbol: "JNJ", side: "buy" as const },
  ];
  const sells = [{ symbol: "AAPL", side: "sell" as const }];
  const batch = [...buys, ...sells];

  it("T0: clean state — no rejects, all buys allowed through", () => {
    const { skipped, decision } = applyLockoutToBatch(batch, {
      rejects: [],
      cashSyncs: [{ at: "2026-07-25T09:00:00Z", brokerCash: 124.6 }],
    });
    expect(decision.lockout).toBe(false);
    expect(skipped).toEqual({});
  });

  it("T1→T2: Saxo returned InsufficientCash, next tick sees same/lower cash → ALL new buys skipped, sell untouched", () => {
    const world = {
      // T1: Saxo rejected the VMID.L buy at 10:00 with InsufficientCash.
      rejects: [
        {
          at: "2026-07-25T10:00:00Z",
          symbol: "VMID.L",
          quantity: 1,
        },
      ],
      // T2: next hourly tick's CASH_SYNC at 11:00 shows the same £124.60 —
      // no material growth vs the reject.
      cashSyncs: [
        { at: "2026-07-25T11:00:00Z", brokerCash: 124.6 },
      ],
    };

    const { skipped, decision } = applyLockoutToBatch(batch, world);

    expect(decision.lockout).toBe(true);
    expect(decision.reason).toMatch(/InsufficientCash/);
    expect(decision.reason).toMatch(/locked out until broker cash grows/);

    // Every buy in the batch is skipped up-front, regardless of symbol.
    expect(Object.keys(skipped).sort()).toEqual(
      ["JNJ:buy", "V:buy", "VMID.L:buy"],
    );
    for (const reason of Object.values(skipped)) {
      expect(reason).toBe(decision.reason);
    }

    // Sell orders are NOT gated by the cash lockout — they FREE cash, they
    // don't consume it. This is the whole reason we gate on side="buy" only.
    expect(skipped["AAPL:sell"]).toBeUndefined();
  });

  it("T2 idempotent re-tick: many CASH_SYNC rows at the same low cash still lock out", () => {
    const world = {
      rejects: [{ at: "2026-07-25T10:00:00Z", symbol: "VMID.L", quantity: 1 }],
      cashSyncs: [
        { at: "2026-07-25T11:00:00Z", brokerCash: 124.6 },
        { at: "2026-07-25T12:00:00Z", brokerCash: 124.6 },
        { at: "2026-07-25T13:00:00Z", brokerCash: 124.62 }, // sub-threshold drift
        { at: "2026-07-25T14:00:00Z", brokerCash: 124.55 }, // FX rounding
      ],
    };
    const { decision } = applyLockoutToBatch(batch, world);
    expect(decision.lockout).toBe(true);
    // Growth is real but tiny (0.07) — well below max(5, 124.55 * 0.05 = 6.23).
    expect(decision.stats.growth).toBeGreaterThan(0);
    expect(decision.stats.growth!).toBeLessThan(decision.stats.growthThreshold!);
  });

  it("T3: material cash growth after the reject → lockout self-clears, buys resume", () => {
    const world = {
      rejects: [{ at: "2026-07-25T10:00:00Z", symbol: "VMID.L", quantity: 1 }],
      cashSyncs: [
        { at: "2026-07-25T11:00:00Z", brokerCash: 124.6 },
        { at: "2026-07-25T12:00:00Z", brokerCash: 124.6 },
        // A settled sell / external deposit lands: broker cash jumps to £500.
        { at: "2026-07-25T13:00:00Z", brokerCash: 500.0 },
      ],
    };
    const { skipped, decision } = applyLockoutToBatch(batch, world);
    expect(decision.lockout).toBe(false);
    expect(skipped).toEqual({});
    expect(decision.stats.growth).toBeCloseTo(500 - 124.6, 6);
    expect(decision.stats.growth!).toBeGreaterThanOrEqual(decision.stats.growthThreshold!);
  });

  it("only CASH_SYNC rows recorded AFTER the newest reject count as growth", () => {
    const world = {
      rejects: [{ at: "2026-07-25T10:00:00Z", symbol: "VMID.L", quantity: 1 }],
      cashSyncs: [
        // Pre-reject deposit — must NOT be treated as "grew since reject".
        { at: "2026-07-25T09:00:00Z", brokerCash: 10_000 },
        // Post-reject: back to £120.
        { at: "2026-07-25T11:00:00Z", brokerCash: 120 },
      ],
    };
    const { decision } = applyLockoutToBatch(batch, world);
    expect(decision.lockout).toBe(true);
    expect(decision.stats.samplesSinceReject).toBe(1);
    expect(decision.stats.maxCashSinceReject).toBe(120);
  });

  it("newest reject dominates when there are multiple: a fresh reject re-arms the lockout", () => {
    const world = {
      rejects: [
        // Older reject at 08:00.
        { at: "2026-07-25T08:00:00Z", symbol: "VMID.L", quantity: 1 },
        // A deposit at 09:00 would have cleared the older reject on its own…
        // …but a new reject at 10:00 shifts the "since reject" window
        // forward. Only the 11:00 sync counts, and it shows flat cash.
        { at: "2026-07-25T10:00:00Z", symbol: "V", quantity: 1 },
      ],
      cashSyncs: [
        { at: "2026-07-25T09:00:00Z", brokerCash: 10_000 },
        { at: "2026-07-25T11:00:00Z", brokerCash: 124.6 },
      ],
    };
    const { decision } = applyLockoutToBatch(batch, world);
    expect(decision.lockout).toBe(true);
    expect(decision.stats.newestRejectAt).toBe("2026-07-25T10:00:00Z");
    expect(decision.stats.samplesSinceReject).toBe(1);
    expect(decision.stats.maxCashSinceReject).toBe(124.6);
  });

  it("reject with zero CASH_SYNC observations afterwards → stays locked out (fail-closed)", () => {
    const world = {
      rejects: [{ at: "2026-07-25T10:00:00Z", symbol: "VMID.L", quantity: 1 }],
      cashSyncs: [],
    };
    const { skipped, decision } = applyLockoutToBatch(batch, world);
    expect(decision.lockout).toBe(true);
    expect(decision.stats.samplesSinceReject).toBe(0);
    expect(Object.keys(skipped).sort()).toEqual(["JNJ:buy", "V:buy", "VMID.L:buy"]);
  });

  it("absolute-growth floor kicks in at very low broker cash (relative threshold would be < £5)", () => {
    // minCash = £20 → 5% = £1, but the absolute floor is £5. Growth of £3
    // beats 5% but not the £5 floor, so we MUST stay locked.
    const under = {
      rejects: [{ at: "2026-07-25T10:00:00Z", symbol: "VMID.L", quantity: 1 }],
      cashSyncs: [
        { at: "2026-07-25T11:00:00Z", brokerCash: 20 },
        { at: "2026-07-25T12:00:00Z", brokerCash: 23 },
      ],
    };
    expect(decideInsufficientCashLockout(under).lockout).toBe(true);

    // Growth of £6 clears the £5 floor and the 5% test.
    const over = {
      rejects: under.rejects,
      cashSyncs: [
        { at: "2026-07-25T11:00:00Z", brokerCash: 20 },
        { at: "2026-07-25T12:00:00Z", brokerCash: 26 },
      ],
    };
    expect(decideInsufficientCashLockout(over).lockout).toBe(false);
  });
});
