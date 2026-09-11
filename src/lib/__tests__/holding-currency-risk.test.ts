import { describe, expect, it } from "vitest";
import {
  buildHoldingCurrencyRisk,
  dailyVolFromRates,
  fallbackDailyVol,
} from "../holding-currency-risk";

describe("buildHoldingCurrencyRisk", () => {
  const dailyVolByCcy = { USD: 0.005, JPY: 0.01 };

  it("marks base-currency holdings as carrying no FX risk", () => {
    const r = buildHoldingCurrencyRisk({
      baseCcy: "GBP",
      equityBase: 10_000,
      holdings: [{ symbol: "VWRL.L", currency: "GBP", valueBase: 5_000 }],
      dailyVolByCcy,
    });
    const row = r.rows[0]!;
    expect(row.band).toBe("none");
    expect(row.oneDayVarBase).toBe(0);
    expect(r.foreignValueBase).toBe(0);
    expect(r.topCurrency).toBeNull();
  });

  it("prices a foreign holding's one-day and 5% move", () => {
    const r = buildHoldingCurrencyRisk({
      baseCcy: "GBP",
      equityBase: 10_000,
      holdings: [{ symbol: "AAPL:xnas", currency: "USD", valueBase: 2_000 }],
      dailyVolByCcy,
    });
    const row = r.rows[0]!;
    expect(row.unhedgedBase).toBe(2_000);
    expect(row.adverse5PctBase).toBeCloseTo(100, 6);
    expect(row.oneDayVarBase).toBeCloseTo(2_000 * 0.005 * 1.645, 6);
    expect(r.topCurrency).toBe("USD");
  });

  it("shares a funding leg across the holdings in that currency", () => {
    const r = buildHoldingCurrencyRisk({
      baseCcy: "GBP",
      equityBase: 10_000,
      holdings: [
        { symbol: "AAPL:xnas", currency: "USD", valueBase: 3_000 },
        { symbol: "MSFT:xnas", currency: "USD", valueBase: 1_000 },
      ],
      dailyVolByCcy,
      hedgedBaseByCcy: { USD: 2_000 },
    });
    const aapl = r.rows.find((x) => x.symbol === "AAPL:xnas")!;
    const msft = r.rows.find((x) => x.symbol === "MSFT:xnas")!;
    expect(aapl.unhedgedBase).toBeCloseTo(1_500, 6);
    expect(msft.unhedgedBase).toBeCloseTo(500, 6);
    expect(aapl.hedgedShare).toBeCloseTo(0.5, 6);
    expect(r.unhedgedValueBase).toBeCloseTo(2_000, 6);
  });

  it("never reports more cover than the position is worth", () => {
    const r = buildHoldingCurrencyRisk({
      baseCcy: "GBP",
      equityBase: 5_000,
      holdings: [{ symbol: "7203:xtks", currency: "JPY", valueBase: 500 }],
      dailyVolByCcy,
      hedgedBaseByCcy: { JPY: 5_000 },
    });
    expect(r.rows[0]!.unhedgedBase).toBe(0);
    expect(r.rows[0]!.band).toBe("none");
  });

  it("bands by how much of the account a bad day costs", () => {
    const r = buildHoldingCurrencyRisk({
      baseCcy: "GBP",
      equityBase: 10_000,
      holdings: [
        { symbol: "BIG:xnas", currency: "USD", valueBase: 8_000 },
        { symbol: "SMALL:xnas", currency: "USD", valueBase: 100 },
      ],
      dailyVolByCcy,
    });
    expect(r.rows[0]!.band).toBe("high");
    expect(r.rows.find((x) => x.symbol === "SMALL:xnas")!.band).toBe("low");
  });

  it("falls back to a sane volatility when none is supplied", () => {
    const r = buildHoldingCurrencyRisk({
      baseCcy: "GBP",
      equityBase: 10_000,
      holdings: [{ symbol: "AAPL:xnas", currency: "USD", valueBase: 1_000 }],
      dailyVolByCcy: {},
    });
    expect(r.rows[0]!.dailyVolPct).toBe(fallbackDailyVol("USD"));
  });
});

describe("dailyVolFromRates", () => {
  it("returns null on a series too short to measure", () => {
    expect(dailyVolFromRates([1.27, 1.28])).toBeNull();
  });

  it("measures the spread of daily moves", () => {
    const rates = Array.from({ length: 40 }, (_, i) => 1.27 * (1 + (i % 2 === 0 ? 0.004 : -0.004)));
    const vol = dailyVolFromRates(rates);
    expect(vol).not.toBeNull();
    expect(vol!).toBeGreaterThan(0.005);
    expect(vol!).toBeLessThan(0.02);
  });
});
