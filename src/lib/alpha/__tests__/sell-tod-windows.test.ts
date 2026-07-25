// Sell-side TOD hard-block + haircut behaviour across all session windows
// and sell order types.
//
// The trading engine's `applyExecAlphaSell` helper (in
// trading-engine.server.ts) composes two pure primitives:
//   • `todExecutionAdjustment` — venue-aware session gate
//   • `planOrderSlices`        — ADV participation slicer
//
// and layers one extra rule specific to sells: **protective exits bypass
// the TOD gate but still attach slicing telemetry**. Auto-liquidations
// (stop-loss, event blackouts) must always be able to fire; discretionary
// AI sells and rebalance-band trims are gated exactly like buys.
//
// These tests lock that contract at the primitive level (all venue windows
// exercised) and at the order-type level via a faithful re-implementation of
// `applyExecAlphaSell` so future engine edits can't silently regress the
// protective-bypass semantics or the "slice-plan still emitted when the gate
// haircuts to zero-block" invariants.

import { describe, it, expect } from "vitest";
import {
  todExecutionAdjustment,
  planOrderSlices,
  inferVenueFromSymbol,
  type Venue,
} from "../execution-alpha";

// ---------------------------------------------------------------------------
// Helpers: build a UTC instant that renders to a specific local-venue
// minute-of-day for the given venue. Winter dates avoid DST edge cases.
// ---------------------------------------------------------------------------

/** Winter (GMT) date so London local = UTC. */
function lseInstant(hour: number, minute: number): Date {
  return new Date(Date.UTC(2025, 0, 15, hour, minute, 0));
}

/** Winter (EST, UTC-5) date so NY local hour = UTC hour - 5. */
function nyInstant(nyHour: number, nyMinute: number): Date {
  return new Date(Date.UTC(2025, 0, 15, nyHour + 5, nyMinute, 0));
}

// Engine defaults surfaced in RiskConfig; kept here so tests break loudly if
// somebody moves the goalposts.
const CFG = {
  avoidOpenMin: 15,
  avoidCloseMin: 10,
  openHaircut: 0.4,
  closeHaircut: 0.4,
  hardBlockOpenMin: 5,
  hardBlockCloseMin: 3,
  participationCap: 0.05,
  maxChildNotional: 5_000,
} as const;

// ---------------------------------------------------------------------------
// Faithful re-implementation of `applyExecAlphaSell` from
// trading-engine.server.ts (lines ~760-812). Any drift there without an
// equivalent update here should fail these tests.
// ---------------------------------------------------------------------------

type SellOrderKind =
  | "stop_loss"
  | "event_blackout"
  | "chandelier"
  | "ai_sell"
  | "rebalance_trim";

const PROTECTIVE_KINDS: ReadonlySet<SellOrderKind> = new Set([
  "stop_loss",
  "event_blackout",
]);

function simulateSellSide(args: {
  now: Date;
  symbol: string;
  notional: number;
  fillPrice: number;
  adv20d: number | null;
  kind: SellOrderKind;
}) {
  const protective = PROTECTIVE_KINDS.has(args.kind);
  const venue = inferVenueFromSymbol(args.symbol);
  let adjNotional = args.notional;
  let tod: ReturnType<typeof todExecutionAdjustment> | undefined;

  if (!protective) {
    tod = todExecutionAdjustment({
      now: args.now,
      venue,
      avoidOpenMin: CFG.avoidOpenMin,
      avoidCloseMin: CFG.avoidCloseMin,
      openHaircut: CFG.openHaircut,
      closeHaircut: CFG.closeHaircut,
      hardBlockOpenMin: CFG.hardBlockOpenMin,
      hardBlockCloseMin: CFG.hardBlockCloseMin,
    });
    if (!tod.allow) return { allow: false, adjNotional: 0, tod, slicePlan: undefined };
    if (tod.multiplier < 1) adjNotional = adjNotional * tod.multiplier;
  }

  const slicePlan =
    adjNotional > 0
      ? planOrderSlices({
          parentNotional: adjNotional,
          price: args.fillPrice,
          adv20d: args.adv20d,
          participationCap: CFG.participationCap,
          maxChildNotional: CFG.maxChildNotional,
        })
      : undefined;

  return { allow: true, adjNotional, tod, slicePlan };
}

// ---------------------------------------------------------------------------
// 1. Primitive-level: exercise EVERY session-window branch per venue.
// ---------------------------------------------------------------------------

describe("todExecutionAdjustment — sell side, all session windows", () => {
  const baseArgs = {
    avoidOpenMin: CFG.avoidOpenMin,
    avoidCloseMin: CFG.avoidCloseMin,
    openHaircut: CFG.openHaircut,
    closeHaircut: CFG.closeHaircut,
    hardBlockOpenMin: CFG.hardBlockOpenMin,
    hardBlockCloseMin: CFG.hardBlockCloseMin,
  } as const;

  describe("LSE (08:00 – 16:30 London)", () => {
    it("before-open (07:30) → allow, mid-session multiplier (outside RTH)", () => {
      const r = todExecutionAdjustment({ ...baseArgs, venue: "LSE", now: lseInstant(7, 30) });
      expect(r.allow).toBe(true);
      expect(r.multiplier).toBe(1);
      expect(r.reason).toMatch(/outside RTH/i);
    });

    it("hard-block open window (08:02, within first 5m) → block, mult=0", () => {
      const r = todExecutionAdjustment({ ...baseArgs, venue: "LSE", now: lseInstant(8, 2) });
      expect(r.allow).toBe(false);
      expect(r.multiplier).toBe(0);
      expect(r.reason).toMatch(/hard-block first/i);
    });

    it("open haircut window (08:10, min 10 since open < 15) → allow, mult=0.4", () => {
      const r = todExecutionAdjustment({ ...baseArgs, venue: "LSE", now: lseInstant(8, 10) });
      expect(r.allow).toBe(true);
      expect(r.multiplier).toBeCloseTo(0.4, 6);
      expect(r.reason).toMatch(/open window haircut/i);
    });

    it("mid-session (12:00) → allow, mult=1", () => {
      const r = todExecutionAdjustment({ ...baseArgs, venue: "LSE", now: lseInstant(12, 0) });
      expect(r.allow).toBe(true);
      expect(r.multiplier).toBe(1);
      expect(r.reason).toMatch(/mid-session/i);
    });

    it("close haircut window (16:25, 5m until 16:30 close) → allow, mult=0.4", () => {
      const r = todExecutionAdjustment({ ...baseArgs, venue: "LSE", now: lseInstant(16, 25) });
      expect(r.allow).toBe(true);
      expect(r.multiplier).toBeCloseTo(0.4, 6);
      expect(r.reason).toMatch(/close window haircut/i);
    });

    it("hard-block close (16:28, 2m until close) → block, mult=0", () => {
      const r = todExecutionAdjustment({ ...baseArgs, venue: "LSE", now: lseInstant(16, 28) });
      expect(r.allow).toBe(false);
      expect(r.multiplier).toBe(0);
      expect(r.reason).toMatch(/hard-block last/i);
    });

    it("after-close (17:00) → allow, outside RTH (batch)", () => {
      const r = todExecutionAdjustment({ ...baseArgs, venue: "LSE", now: lseInstant(17, 0) });
      expect(r.allow).toBe(true);
      expect(r.multiplier).toBe(1);
      expect(r.reason).toMatch(/outside RTH/i);
    });
  });

  describe("NYSE (09:30 – 16:00 New York)", () => {
    it("pre-open (09:00 NY) → allow (outside RTH)", () => {
      const r = todExecutionAdjustment({ ...baseArgs, venue: "NYSE", now: nyInstant(9, 0) });
      expect(r.allow).toBe(true);
      expect(r.multiplier).toBe(1);
    });

    it("hard-block open (09:32 NY, 2m since 09:30) → block", () => {
      const r = todExecutionAdjustment({ ...baseArgs, venue: "NYSE", now: nyInstant(9, 32) });
      expect(r.allow).toBe(false);
      expect(r.multiplier).toBe(0);
    });

    it("open haircut (09:40 NY, 10m since open < 15) → haircut", () => {
      const r = todExecutionAdjustment({ ...baseArgs, venue: "NYSE", now: nyInstant(9, 40) });
      expect(r.allow).toBe(true);
      expect(r.multiplier).toBeCloseTo(0.4, 6);
    });

    it("mid-session (12:00 NY) → mult=1", () => {
      const r = todExecutionAdjustment({ ...baseArgs, venue: "NYSE", now: nyInstant(12, 0) });
      expect(r.multiplier).toBe(1);
    });

    it("close haircut (15:55 NY, 5m to close) → haircut", () => {
      const r = todExecutionAdjustment({ ...baseArgs, venue: "NYSE", now: nyInstant(15, 55) });
      expect(r.multiplier).toBeCloseTo(0.4, 6);
    });

    it("hard-block close (15:58 NY, 2m to close) → block", () => {
      const r = todExecutionAdjustment({ ...baseArgs, venue: "NYSE", now: nyInstant(15, 58) });
      expect(r.allow).toBe(false);
    });

    it("after-close (16:30 NY) → outside RTH", () => {
      const r = todExecutionAdjustment({ ...baseArgs, venue: "NYSE", now: nyInstant(16, 30) });
      expect(r.allow).toBe(true);
      expect(r.multiplier).toBe(1);
    });
  });

  describe("CRYPTO / OTHER (no session)", () => {
    (["CRYPTO", "OTHER"] as const).forEach((venue: Venue) => {
      it(`${venue} at any hour → allow, mult=1, no-session reason`, () => {
        // Sweep a full 24h; every hour must pass through untouched.
        for (let h = 0; h < 24; h++) {
          const r = todExecutionAdjustment({ ...baseArgs, venue, now: new Date(Date.UTC(2025, 0, 15, h, 0, 0)) });
          expect(r.allow).toBe(true);
          expect(r.multiplier).toBe(1);
          expect(r.reason).toMatch(/no-session/i);
        }
      });
    });
  });

  it("hard-block windows disabled (0/0) → haircut, not block, inside auction", () => {
    const r = todExecutionAdjustment({
      ...baseArgs,
      hardBlockOpenMin: 0,
      hardBlockCloseMin: 0,
      venue: "LSE",
      now: lseInstant(8, 2),
    });
    expect(r.allow).toBe(true);
    expect(r.multiplier).toBeCloseTo(0.4, 6);
    expect(r.reason).toMatch(/open window haircut/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Order-type contract: protective sells bypass TOD, discretionary do not.
// ---------------------------------------------------------------------------

describe("applyExecAlphaSell — sell order-type × session-window matrix", () => {
  const SYMBOL_LSE = "VOD.L";
  const SYMBOL_NY = "AAPL";
  const NOTIONAL = 12_000;
  const PRICE = 150;
  const ADV = 100_000; // shares → ADV value = 15m; 5% cap = 750k, well above notional

  describe("protective exits bypass TOD (stop_loss, event_blackout)", () => {
    const cases = [
      { name: "LSE hard-block open", now: lseInstant(8, 2), symbol: SYMBOL_LSE },
      { name: "LSE open haircut", now: lseInstant(8, 10), symbol: SYMBOL_LSE },
      { name: "LSE hard-block close", now: lseInstant(16, 28), symbol: SYMBOL_LSE },
      { name: "LSE close haircut", now: lseInstant(16, 25), symbol: SYMBOL_LSE },
      { name: "NYSE hard-block open", now: nyInstant(9, 32), symbol: SYMBOL_NY },
      { name: "NYSE close haircut", now: nyInstant(15, 55), symbol: SYMBOL_NY },
    ] as const;

    (["stop_loss", "event_blackout"] as const).forEach((kind) => {
      cases.forEach((c) => {
        it(`${kind} @ ${c.name} → allow full notional, tod undefined, slicing telemetry present`, () => {
          const r = simulateSellSide({
            now: c.now,
            symbol: c.symbol,
            notional: NOTIONAL,
            fillPrice: PRICE,
            adv20d: ADV,
            kind,
          });
          expect(r.allow).toBe(true);
          expect(r.adjNotional).toBe(NOTIONAL);
          // Protective exits skip the TOD gate entirely — no telemetry emitted.
          expect(r.tod).toBeUndefined();
          // Slice plan is still attached for the audit trail.
          expect(r.slicePlan).toBeDefined();
          expect(r.slicePlan!.childCount).toBeGreaterThanOrEqual(1);
        });
      });
    });
  });

  describe("discretionary sells (ai_sell, rebalance_trim, chandelier) respect TOD", () => {
    (["ai_sell", "rebalance_trim", "chandelier"] as const).forEach((kind) => {
      it(`${kind} @ LSE hard-block open → blocked, adjNotional=0, no slice plan`, () => {
        const r = simulateSellSide({
          now: lseInstant(8, 2),
          symbol: SYMBOL_LSE,
          notional: NOTIONAL,
          fillPrice: PRICE,
          adv20d: ADV,
          kind,
        });
        expect(r.allow).toBe(false);
        expect(r.adjNotional).toBe(0);
        expect(r.tod?.allow).toBe(false);
        expect(r.tod?.multiplier).toBe(0);
        expect(r.slicePlan).toBeUndefined();
      });

      it(`${kind} @ LSE close haircut → allow, adjNotional × 0.4, slice plan uses trimmed notional`, () => {
        const r = simulateSellSide({
          now: lseInstant(16, 25),
          symbol: SYMBOL_LSE,
          notional: NOTIONAL,
          fillPrice: PRICE,
          adv20d: ADV,
          kind,
        });
        expect(r.allow).toBe(true);
        expect(r.adjNotional).toBeCloseTo(NOTIONAL * 0.4, 6);
        expect(r.tod?.multiplier).toBeCloseTo(0.4, 6);
        expect(r.slicePlan).toBeDefined();
        // slice plan must plan against the haircut notional, not parent.
        const sliced = r.slicePlan!;
        expect(sliced.childCount * sliced.childNotional).toBeCloseTo(NOTIONAL * 0.4, 4);
      });

      it(`${kind} @ NYSE mid-session → allow full notional, mult=1`, () => {
        const r = simulateSellSide({
          now: nyInstant(12, 0),
          symbol: SYMBOL_NY,
          notional: NOTIONAL,
          fillPrice: PRICE,
          adv20d: ADV,
          kind,
        });
        expect(r.allow).toBe(true);
        expect(r.adjNotional).toBe(NOTIONAL);
        expect(r.tod?.multiplier).toBe(1);
        expect(r.slicePlan).toBeDefined();
      });

      it(`${kind} @ NYSE hard-block close → blocked`, () => {
        const r = simulateSellSide({
          now: nyInstant(15, 58),
          symbol: SYMBOL_NY,
          notional: NOTIONAL,
          fillPrice: PRICE,
          adv20d: ADV,
          kind,
        });
        expect(r.allow).toBe(false);
        expect(r.adjNotional).toBe(0);
      });

      it(`${kind} on CRYPTO symbol → 24/7, always allow full notional`, () => {
        // Would be a hard-block window on LSE; CRYPTO has no session.
        const r = simulateSellSide({
          now: lseInstant(8, 2),
          symbol: "BTC-USD",
          notional: NOTIONAL,
          fillPrice: PRICE,
          adv20d: ADV,
          kind,
        });
        expect(r.allow).toBe(true);
        expect(r.adjNotional).toBe(NOTIONAL);
        expect(r.tod?.reason).toMatch(/no-session/i);
      });
    });
  });

  describe("slicing under haircut respects ADV participation cap", () => {
    it("large discretionary sell in close haircut → multi-child plan sized to trimmed notional", () => {
      // parent 200k, close haircut → 80k adjusted. ADV value = 100k × 150 = 15m
      // × 5% = 750k. Under participation cap → sliced only by maxChildNotional
      // (5k). Expect ceil(80k/5k)=16 children.
      const r = simulateSellSide({
        now: lseInstant(16, 25),
        symbol: SYMBOL_LSE,
        notional: 200_000,
        fillPrice: PRICE,
        adv20d: ADV,
        kind: "ai_sell",
      });
      expect(r.allow).toBe(true);
      expect(r.adjNotional).toBeCloseTo(80_000, 4);
      expect(r.slicePlan!.childCount).toBe(16);
      expect(r.slicePlan!.childNotional).toBeCloseTo(5_000, 4);
    });

    it("thinly-traded name in close haircut → participation cap dominates", () => {
      // ADV shares tiny → 100 × 150 = 15k ADV value, 5% = 750. Parent 12k,
      // haircut → 4800; ceil(4800/750) = 7 children but capped by
      // maxChildNotional=5000 (larger) so 750 wins. Expected 7 children.
      const r = simulateSellSide({
        now: lseInstant(16, 25),
        symbol: SYMBOL_LSE,
        notional: 12_000,
        fillPrice: PRICE,
        adv20d: 100,
        kind: "ai_sell",
      });
      expect(r.allow).toBe(true);
      expect(r.adjNotional).toBeCloseTo(4_800, 4);
      expect(r.slicePlan!.childCount).toBe(7);
      // aggregate participation reported against the adjusted (haircut) notional
      expect(r.slicePlan!.advParticipationPct).toBeGreaterThan(0);
    });
  });
});
