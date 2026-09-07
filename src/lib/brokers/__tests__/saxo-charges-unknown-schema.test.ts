import { describe, expect, it } from "vitest";
import { harvestFeeLikeAmounts, mapSaxoChargeRow, mapSaxoChargeRows } from "@/lib/brokers/saxo-charges";

/**
 * The named-column list is a guess at Saxo's schema, and it has already been
 * wrong in production (a real BP.L buy booked as free). These lock the
 * fallback harvest: it must catch money under names we never enumerated, and
 * it must never inflate a charge by counting the same money twice.
 */
describe("saxo charge mapping — unfamiliar report schemas", () => {
  it("harvests fee-like columns we never enumerated", () => {
    const charge = mapSaxoChargeRow({
      TradeId: "6838184709",
      Symbol: "BP:xlon",
      BuySell: "Buy",
      Amount: 154,
      Price: 5.5,
      Currency: "GBP",
      TradeCommissionsAccountCurrency: 8,
      StampDutyChargeAccountCurrency: 4.24,
    });
    expect(charge?.total).toBeCloseTo(12.24, 6);
    expect(charge?.other).toBeCloseTo(12.24, 6);
  });

  it("does not double count when named columns already carry the charge", () => {
    const charge = mapSaxoChargeRow({
      TradeId: "1",
      Commission: 8,
      CommissionAccountCurrency: 8,
      StampDuty: 4,
    });
    expect(charge?.total).toBeCloseTo(12, 6);
  });

  it("ignores money that is not a charge", () => {
    const charge = mapSaxoChargeRow({ TradeId: "2", TradedValue: 8470, Price: 5.5, Amount: 154 });
    expect(charge?.total).toBe(0);
  });

  it("derives a US trade's billed cost from its all-in account settlement", () => {
    const buy = mapSaxoChargeRow({
      TradeId: "6852880685",
      InstrumentSymbol: "TSLA:xnas",
      TradeEventType: "Bought",
      Amount: 2,
      Price: 379.89,
      TradedValue: -759.78,
      BookedAmountUSD: -765.16,
      BookedAmountAccountCurrency: -565.76,
      AccountCurrency: "GBP",
    });
    const sell = mapSaxoChargeRow({
      TradeId: "6854799886",
      InstrumentSymbol: "TSLA:xnas",
      TradeEventType: "Sold",
      Amount: -2,
      Price: 355.06,
      TradedValue: 710.12,
      BookedAmountUSD: 705.46,
      BookedAmountAccountCurrency: 521.9,
      AccountCurrency: "GBP",
    });

    expect(buy?.currency).toBe("USD");
    expect(buy?.other).toBeCloseTo(5.38, 3);
    expect(buy?.total).toBeCloseTo(5.38, 3);
    expect(sell?.currency).toBe("USD");
    expect(sell?.other).toBeCloseTo(4.66, 3);
    expect(sell?.total).toBeCloseTo(4.66, 3);
  });

  it("harvests nested cost blocks and charge arrays", () => {
    const charge = mapSaxoChargeRow({
      TransactionId: "abc-1",
      Symbol: "AAPL:xnas",
      Costs: { BrokerageFeeAccountCurrency: 5, RegulatorFeeAccountCurrency: 0.31 },
      RegulatoryCharges: [{ SecLevyAmount: 0.12 }],
    });
    expect(charge?.total).toBeCloseTo(5.43, 6);
  });

  it("reads numeric strings, magnitudes of signed debits, and skips zeroes", () => {
    const charge = mapSaxoChargeRow({
      ActivityId: "act-9",
      SettlementFeeInAccountCurrency: "-3.25",
      MarketplaceChargeAccountCurrency: 0,
      TransferDutyClientCurrency: "1.75",
    });
    expect(charge?.total).toBeCloseTo(5, 6);
  });

  it("collapses same-concept aliases of one charge to a single contribution", () => {
    const charge = mapSaxoChargeRow({
      TradeId: "3",
      TradeCommissionsAccountCurrency: 8,
      TradeCommissionsSum: 8,
      TradeCommissionsTotal: 8,
    });
    expect(charge?.total).toBeCloseTo(8, 6);
  });

  it("takes the larger figure when aliases of one charge disagree", () => {
    const charge = mapSaxoChargeRow({
      TradeId: "4",
      ExecutionChargeAccountCurrency: 6.4,
      ExecutionChargeInstrumentCurrency: 5.1,
    });
    expect(charge?.total).toBeCloseTo(6.4, 6);
  });

  it("never harvests on top of a named charge, even a partial one", () => {
    // Named `Commission` fires, so the unknown `SettlementChargeAccountCurrency`
    // is deliberately left out rather than stacked on the same trade.
    const charge = mapSaxoChargeRow({
      TradeId: "5",
      Commission: 8,
      SettlementChargeAccountCurrency: 2,
    });
    expect(charge?.commission).toBeCloseTo(8, 6);
    expect(charge?.other).toBe(0);
    expect(charge?.total).toBeCloseTo(8, 6);
  });

  it("keeps the broker's published total authoritative and skips the harvest", () => {
    const charge = mapSaxoChargeRow({
      TradeId: "6",
      Commission: 8,
      TotalChargesAccountCurrency: 12.5,
      MysteryLevyAccountCurrency: 99,
    });
    expect(charge?.total).toBeCloseTo(12.5, 6);
    expect(charge?.other).toBeCloseTo(4.5, 6);
  });

  it("rejects rate, percentage and cost-basis columns that merely look like fees", () => {
    const charge = mapSaxoChargeRow({
      TradeId: "7",
      CommissionRate: 0.15,
      EstimatedCommissionAccountCurrency: 9,
      CostBasisAccountCurrency: 8470,
      CostPrice: 55,
      FeePercent: 0.4,
      CommissionCurrency: "GBP",
      CommissionDecimals: 2,
      CommissionType: "PerTrade",
      FeeDescription: "None",
    });
    expect(charge?.total).toBe(0);
  });

  it("counts a charge echoed in a nested breakdown only once", () => {
    const row = { BrokerageFee: 4, Detail: { Breakdown: { BrokerageFee: 4 } } };
    // The walk sees both paths...
    expect([...harvestFeeLikeAmounts(row).keys()]).toEqual([
      "brokeragefee",
      "detail.breakdown.brokeragefee",
    ]);
    // ...but the same leaf name is one charge, not two.
    expect(mapSaxoChargeRow({ TradeId: "8", ...row })?.total).toBeCloseTo(4, 6);
  });


  it("de-duplicates repeated rows for one trade across a report", () => {
    const charges = mapSaxoChargeRows([
      { TradeId: "dup-1", ClearingChargeAccountCurrency: 3 },
      { TradeId: "dup-1", ClearingChargeAccountCurrency: 3 },
      null,
      "not-a-row",
      { NoIdentityHere: true, CommissionSum: 5 },
    ]);
    expect(charges).toHaveLength(1);
    expect(charges[0]!.total).toBeCloseTo(3, 6);
  });
});
