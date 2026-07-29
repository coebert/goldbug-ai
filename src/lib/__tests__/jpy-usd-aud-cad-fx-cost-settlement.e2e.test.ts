// End-to-end test: JPY/USD and AUD/CAD spread + wallet-bps + settlement.
//
// Extends the JPY / AUD coverage to two additional pairs that touch the
// same liquid-minor bucket in `fx-cost-model.ts`:
//   - JPY/USD (USD → JPY funding a Tokyo buy from a USD-base account)
//   - AUD/CAD (CAD → AUD funding a Sydney buy from a CAD-base account)
//
// Verifies the whole slice: the cost model returns cross-minor spread +
// wallet markup, `applyFxCost` deflates the mid rate, `feeInFromCcy`
// respects per-currency minimums, `trimBuysToBudgetByCurrency` inflates
// the base debit by the same bps at trim time, and the FX spot leg
// settles T+2 (USDCAD would settle T+1 — cross-checked here as a control
// so a regression that swaps the pair convention gets caught).

import { describe, it, expect } from "vitest";
import {
  quoteFxCost,
  applyFxCost,
  feeInFromCcy,
  roundTripFxBps,
} from "@/lib/fx-cost-model";
import {
  trimBuysToBudgetByCurrency,
  type FxResolver,
  type MultiCcyBudgetOrder,
} from "@/lib/pre-place-budget-multi-ccy";
import { fxSettlementDate, settlementDate } from "@/lib/settlement";

// Rounded mid rates for exact-arithmetic assertions.
const MID: Record<string, number> = {
  USDJPY: 150, // 1 USD = 150 JPY
  JPYUSD: 1 / 150,
  CADAUD: 1.1, // 1 CAD = 1.10 AUD
  AUDCAD: 1 / 1.1,
};
const fx: FxResolver = (from, to) =>
  from === to ? 1 : (MID[`${from}${to}`] ?? null);

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe("Additional JPY/USD and AUD/CAD pairs: spread, wallet bps, settlement", () => {
  describe("cost model", () => {
    it("classifies USD/JPY and AUD/CAD as cross-minor with the right bps", () => {
      // Wallet execution is the default in the codebase.
      const usdJpy = quoteFxCost("USD", "JPY", "wallet");
      const jpyUsd = quoteFxCost("JPY", "USD", "wallet");
      const cadAud = quoteFxCost("CAD", "AUD", "wallet");
      const audCad = quoteFxCost("AUD", "CAD", "wallet");

      for (const q of [usdJpy, jpyUsd, cadAud, audCad]) {
        expect(q.pairClass).toBe("cross-minor");
        // 8 bps half-spread + 32 bps wallet markup per fx-cost-model.
        expect(q.spreadBps).toBe(8);
        expect(q.walletMarkupBps).toBe(32);
        expect(q.totalBps).toBe(40);
        expect(q.execution).toBe("wallet");
      }

      // Spot execution drops the wallet markup.
      expect(quoteFxCost("USD", "JPY", "spot").totalBps).toBe(8);
      expect(quoteFxCost("AUD", "CAD", "spot").totalBps).toBe(8);
    });

    it("applyFxCost deflates mid rate by exactly totalBps and preserves ratios", () => {
      const q = quoteFxCost("USD", "JPY", "wallet");
      const effective = applyFxCost(MID.USDJPY, q);
      // 40 bps off 150 = 150 * (1 - 0.004) = 149.4
      expect(effective).toBeCloseTo(149.4, 9);

      // AUD/CAD symmetry: same bps in either direction under wallet exec.
      const cadAud = applyFxCost(MID.CADAUD, quoteFxCost("CAD", "AUD"));
      const audCad = applyFxCost(MID.AUDCAD, quoteFxCost("AUD", "CAD"));
      // (1 - 0.004) applied to each mid.
      expect(cadAud).toBeCloseTo(MID.CADAUD * 0.996, 9);
      expect(audCad).toBeCloseTo(MID.AUDCAD * 0.996, 9);
    });

    it("feeInFromCcy respects per-currency minimums for tiny conversions", () => {
      // JPY min fee is 150 (not 1). A ¥1,000 sweep should be priced at
      // the minimum, not at 40 bps of ¥1,000 = ¥4.
      const tiny = feeInFromCcy(1_000, "JPY", "USD");
      expect(tiny.quote.pairClass).toBe("cross-minor");
      expect(tiny.fee).toBe(150);

      // AUD min fee is 2 — a small A$100 sweep is priced at 40 bps
      // (A$0.40) which is below 2, so min kicks in.
      const smallAud = feeInFromCcy(100, "AUD", "CAD");
      expect(smallAud.fee).toBe(2);

      // A meaningful A$100,000 sweep clears the minimum and prices at
      // 40 bps = A$400.
      const bigAud = feeInFromCcy(100_000, "AUD", "CAD");
      expect(bigAud.fee).toBe(400);
    });

    it("roundTripFxBps doubles the one-way wallet cost for both pairs", () => {
      const usdJpy = roundTripFxBps("USD", "JPY");
      expect(usdJpy).toMatchObject({
        entryBps: 40,
        exitBps: 40,
        totalBps: 80,
        pairClass: "cross-minor",
      });
      const cadAud = roundTripFxBps("CAD", "AUD");
      expect(cadAud).toMatchObject({
        entryBps: 40,
        exitBps: 40,
        totalBps: 80,
        pairClass: "cross-minor",
      });
    });
  });

  describe("wallet trim: base debit inflated by fxCostBps", () => {
    it("USD-base account funding a JPY buy inflates the USD debit by 40 bps", () => {
      const buy: MultiCcyBudgetOrder = {
        symbol: "7203.T",
        side: "buy",
        quantity: 100,
        price: 3_000, // ¥300,000
        instrument_ccy: "JPY",
      };
      const bps = quoteFxCost("USD", "JPY", "wallet").totalBps; // 40
      const result = trimBuysToBudgetByCurrency(
        [buy],
        { USD: 10_000 },
        "USD",
        fx,
        { safetyBufferPct: 0, fxCostBps: () => bps },
      );

      expect(result.decisions.map((d) => d.kind)).toEqual(["allow"]);
      const leg = result.fxLegs[0];
      expect(leg.fromCcy).toBe("USD");
      expect(leg.toCcy).toBe("JPY");
      // Native credit unchanged.
      expect(leg.amountTo).toBeCloseTo(300_000, 6);
      // Base debit inflated by (1 + 40/10_000) over the naive 300k/150.
      expect(leg.amountFrom).toBeCloseTo((300_000 / 150) * 1.004, 6);

      // Wallet reconciles: USD reduced by inflated debit, JPY nets to 0.
      expect(result.finalWallet.USD).toBeCloseTo(
        10_000 - (300_000 / 150) * 1.004,
        6,
      );
      expect(result.finalWallet.JPY).toBeCloseTo(0, 9);
    });

    it("CAD-base account funding an AUD buy inflates the CAD debit by 40 bps", () => {
      const buy: MultiCcyBudgetOrder = {
        symbol: "BHP.AX",
        side: "buy",
        quantity: 50,
        price: 40, // A$2,000
        instrument_ccy: "AUD",
      };
      const bps = quoteFxCost("CAD", "AUD", "wallet").totalBps; // 40
      const result = trimBuysToBudgetByCurrency(
        [buy],
        { CAD: 5_000 },
        "CAD",
        fx,
        { safetyBufferPct: 0, fxCostBps: () => bps },
      );

      const leg = result.fxLegs[0];
      expect(leg.fromCcy).toBe("CAD");
      expect(leg.toCcy).toBe("AUD");
      expect(leg.amountTo).toBeCloseTo(2_000, 6);
      // 1 CAD = 1.10 AUD → CAD needed = 2000/1.1 ≈ C$1,818.18, then +40 bps.
      expect(leg.amountFrom).toBeCloseTo((2_000 / 1.1) * 1.004, 6);

      expect(result.finalWallet.CAD).toBeCloseTo(
        5_000 - (2_000 / 1.1) * 1.004,
        6,
      );
      expect(result.finalWallet.AUD).toBeCloseTo(0, 9);
    });

    it("rejects the buy when 40bps inflation tips base wallet over the edge", () => {
      // Base wallet is exactly enough at the mid rate but not after the
      // 40bps wallet markup — trim must skip cleanly.
      const buy: MultiCcyBudgetOrder = {
        symbol: "7203.T",
        side: "buy",
        quantity: 100,
        price: 3_000,
        instrument_ccy: "JPY",
      };
      const midBaseNeeded = 300_000 / 150; // $2,000
      const result = trimBuysToBudgetByCurrency(
        [buy],
        { USD: midBaseNeeded + 1 }, // clearly < 2000 * 1.004 = 2008
        "USD",
        fx,
        { safetyBufferPct: 0, fxCostBps: () => 40 },
      );
      const d = result.decisions[0];
      expect(d.kind).toBe("skip");
      if (d.kind === "skip") expect(d.reason).toMatch(/insufficient USD to convert/);
      expect(result.fxLegs).toHaveLength(0);
    });
  });

  describe("FX settlement", () => {
    it("USD/JPY spot settles T+2; USD/CAD is the T+1 exception (regression control)", () => {
      // Monday 2026-03-02 — plain business-day walk.
      const trade = new Date(Date.UTC(2026, 2, 2));
      expect(ymd(fxSettlementDate(trade, "USD", "JPY"))).toBe("2026-03-04");
      expect(ymd(fxSettlementDate(trade, "JPY", "USD"))).toBe("2026-03-04");

      // Equity T+2 (TSE) also lands 2026-03-04, so cash clears in time.
      expect(ymd(settlementDate(trade, "TSE_JP"))).toBe("2026-03-04");

      // USD/CAD is the documented T+1 exception in `fxSettlementDate`.
      // If a future refactor removes the special case this test flags it.
      expect(ymd(fxSettlementDate(trade, "USD", "CAD"))).toBe("2026-03-03");
      expect(ymd(fxSettlementDate(trade, "CAD", "USD"))).toBe("2026-03-03");
    });

    it("AUD/CAD spot settles T+2 alongside ASX equity", () => {
      const trade = new Date(Date.UTC(2026, 2, 2));
      expect(ymd(fxSettlementDate(trade, "CAD", "AUD"))).toBe("2026-03-04");
      expect(ymd(fxSettlementDate(trade, "AUD", "CAD"))).toBe("2026-03-04");
      expect(ymd(settlementDate(trade, "ASX"))).toBe("2026-03-04");
    });

    it("settlement rolls over weekends and venue holidays", () => {
      // Thu 2026-03-05 + T+2 = Mon 2026-03-09.
      const trade = new Date(Date.UTC(2026, 2, 5));
      expect(ymd(fxSettlementDate(trade, "USD", "JPY"))).toBe("2026-03-09");
      expect(ymd(fxSettlementDate(trade, "CAD", "AUD"))).toBe("2026-03-09");

      const hol = new Set<string>(["2026-03-06"]);
      expect(ymd(fxSettlementDate(trade, "USD", "JPY", hol))).toBe("2026-03-10");
      expect(ymd(fxSettlementDate(trade, "CAD", "AUD", hol))).toBe("2026-03-10");
    });
  });
});
