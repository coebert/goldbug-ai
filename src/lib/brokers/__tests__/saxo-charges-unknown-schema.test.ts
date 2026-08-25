import { describe, expect, it } from "vitest";
import { mapSaxoChargeRow } from "@/lib/brokers/saxo-charges";

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
});
