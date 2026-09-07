import { describe, expect, it } from "vitest";
import { buildAllPortfoliosEquity } from "../all-portfolios-equity";

const REAL = "11111111-1111-4111-8111-111111111111";
const SIM = "22222222-2222-4222-8222-222222222222";

describe("buildAllPortfoliosEquity", () => {
  it("does not backfill real-money portfolios onto older simulated snapshot dates", () => {
    const result = buildAllPortfoliosEquity({
      today: "2026-07-24",
      portfolios: [
        { id: SIM, name: "Sim", currency: "GBP", mode: "paper", starting_cash: 1000, current_cash: 1040 },
        { id: REAL, name: "Real", currency: "GBP", mode: "live_prod", starting_cash: 329.75, current_cash: 124.6 },
      ],
      snapshots: [
        { portfolio_id: SIM, snapshot_date: "2026-07-20", total_value: 1000 },
        { portfolio_id: SIM, snapshot_date: "2026-07-21", total_value: 1010 },
        { portfolio_id: SIM, snapshot_date: "2026-07-24", total_value: 1040 },
        { portfolio_id: REAL, snapshot_date: "2026-07-24", total_value: 300.46 },
      ],
    });

    expect(result.series).toEqual([
      { date: "2026-07-20", [SIM]: 1000, total_sim: 1000 },
      { date: "2026-07-21", [SIM]: 1010, total_sim: 1010 },
      { date: "2026-07-24", [SIM]: 1040, [REAL]: 300.46, total_sim: 1040, total_real: 300.46 },
    ]);
    expect(result.series.some((row) => row[REAL] === 329.75)).toBe(false);
  });

  it("uses current cash only on today's date for portfolios without snapshots", () => {
    const result = buildAllPortfoliosEquity({
      today: "2026-07-24",
      portfolios: [
        { id: SIM, name: "Sim", currency: "GBP", mode: "paper", starting_cash: 1000, current_cash: 1010 },
        { id: REAL, name: "Real", currency: "GBP", mode: "live_prod", starting_cash: 300, current_cash: 300 },
      ],
      snapshots: [
        { portfolio_id: SIM, snapshot_date: "2026-07-20", total_value: 1000 },
        { portfolio_id: SIM, snapshot_date: "2026-07-24", total_value: 1010 },
      ],
    });

    expect(result.series).toEqual([
      { date: "2026-07-20", [SIM]: 1000, total_sim: 1000 },
      { date: "2026-07-24", [SIM]: 1010, [REAL]: 300, total_sim: 1010, total_real: 300 },
    ]);
  });

  it("converts every monetary series to GBP before summing mixed-currency equity", () => {
    const result = buildAllPortfoliosEquity({
      today: "2026-07-24",
      displayCurrency: "GBP",
      fxRates: { GBP: 1, EUR: 0.85 },
      portfolios: [
        { id: SIM, name: "Euro sim", currency: "EUR", mode: "paper", starting_cash: 1000, current_cash: 1100 },
        { id: REAL, name: "Real", currency: "GBP", mode: "live_prod", starting_cash: 300, current_cash: 300 },
      ],
      snapshots: [
        { portfolio_id: SIM, snapshot_date: "2026-07-24", total_value: 1100 },
        { portfolio_id: REAL, snapshot_date: "2026-07-24", total_value: 300 },
      ],
    });

    expect(result.currency).toBe("GBP");
    expect(result.mixedCurrency).toBe(true);
    expect(result.portfolios[0].currency).toBe("GBP");
    expect(result.series[0]).toEqual({
      date: "2026-07-24",
      [SIM]: 935,
      [REAL]: 300,
      total_sim: 935,
      total_real: 300,
    });
    expect(result.perPortfolioSeries[SIM]).toEqual([{ date: "2026-07-24", value: 935 }]);
  });
});