// Regression tests locking in the invariant:
//   Real-money equity must NEVER show a value for any date before the live
//   portfolio's first equity snapshot (or before its own `created_at`, if the
//   caller passes that as the earliest allowed date). The dashboard's
//   "Real-money equity" tile and the merged `total_real` series are derived
//   from these rows, so a single phantom value here produces the fake losses
//   the user has reported multiple times (£300 shown as -9%, etc.).
//
// These tests exercise ONLY `buildAllPortfoliosEquity` — the pure selector
// that feeds `getAllPortfoliosEquity`. Data-fetching regressions belong in
// the server-fn integration suite; keeping this file pure means it fails
// loudly the moment somebody reintroduces starting_cash/current_cash
// backfill for real-money portfolios.

import { describe, expect, it } from "vitest";
import {
  buildAllPortfoliosEquity,
  type EquitySnapshotInput,
  type PortfolioEquityInput,
} from "../all-portfolios-equity";

const SIM = "11111111-1111-4111-8111-111111111111";
const REAL = "22222222-2222-4222-8222-222222222222";
const REAL2 = "33333333-3333-4333-8333-333333333333";

function realPortfolio(over: Partial<PortfolioEquityInput> = {}): PortfolioEquityInput {
  return {
    id: REAL,
    name: "Live Saxo",
    currency: "GBP",
    mode: "live_prod",
    starting_cash: 300,
    current_cash: 300,
    ...over,
  };
}
function simPortfolio(over: Partial<PortfolioEquityInput> = {}): PortfolioEquityInput {
  return {
    id: SIM,
    name: "Sim",
    currency: "GBP",
    mode: "paper",
    starting_cash: 1000,
    current_cash: 1040,
    ...over,
  };
}

function realValuesInSeries(result: ReturnType<typeof buildAllPortfoliosEquity>, id: string) {
  return result.series
    .filter((row) => id in row)
    .map((row) => ({ date: String(row.date), value: Number(row[id]) }));
}

describe("real-money equity — no phantom backfill (regression)", () => {
  it("never emits a real-money value on a date before the live portfolio's first snapshot", () => {
    const result = buildAllPortfoliosEquity({
      today: "2026-07-24",
      portfolios: [simPortfolio(), realPortfolio()],
      snapshots: [
        { portfolio_id: SIM, snapshot_date: "2026-06-01", total_value: 1000 },
        { portfolio_id: SIM, snapshot_date: "2026-07-01", total_value: 1020 },
        { portfolio_id: SIM, snapshot_date: "2026-07-24", total_value: 1040 },
        { portfolio_id: REAL, snapshot_date: "2026-07-24", total_value: 300 },
      ],
    });

    const realPoints = realValuesInSeries(result, REAL);
    expect(realPoints).toEqual([{ date: "2026-07-24", value: 300 }]);
    // total_real must only appear on the same date.
    const totalRealDates = result.series
      .filter((row) => "total_real" in row)
      .map((row) => row.date);
    expect(totalRealDates).toEqual(["2026-07-24"]);
  });

  it("never fabricates real-money history from starting_cash on older sim dates", () => {
    const result = buildAllPortfoliosEquity({
      today: "2026-07-24",
      portfolios: [
        simPortfolio(),
        // starting_cash 329.75 was the historical bug's phantom value.
        realPortfolio({ starting_cash: 329.75, current_cash: 124.6 }),
      ],
      snapshots: [
        { portfolio_id: SIM, snapshot_date: "2026-07-20", total_value: 1000 },
        { portfolio_id: SIM, snapshot_date: "2026-07-21", total_value: 1010 },
        { portfolio_id: SIM, snapshot_date: "2026-07-23", total_value: 1030 },
        { portfolio_id: REAL, snapshot_date: "2026-07-24", total_value: 300.46 },
      ],
    });

    // The banned phantom values must never appear on any row.
    for (const row of result.series) {
      expect(row[REAL]).not.toBe(329.75);
      expect(row[REAL]).not.toBe(124.6);
    }
    expect(realValuesInSeries(result, REAL)).toEqual([
      { date: "2026-07-24", value: 300.46 },
    ]);
  });

  it("only uses current_cash on today, never on historical dates", () => {
    const result = buildAllPortfoliosEquity({
      today: "2026-07-24",
      portfolios: [simPortfolio(), realPortfolio({ current_cash: 315 })],
      snapshots: [
        { portfolio_id: SIM, snapshot_date: "2026-07-20", total_value: 1000 },
        { portfolio_id: SIM, snapshot_date: "2026-07-24", total_value: 1040 },
        // Real has NO snapshots yet.
      ],
    });

    const realPoints = realValuesInSeries(result, REAL);
    // Exactly one point, dated today, equal to current_cash — no others.
    expect(realPoints).toEqual([{ date: "2026-07-24", value: 315 }]);
    // The historical sim date must NOT have a real-money entry.
    const row2020 = result.series.find((r) => r.date === "2026-07-20")!;
    expect(REAL in row2020).toBe(false);
    expect("total_real" in row2020).toBe(false);
  });

  it("does not backfill real-money zeros on days sim traded but real did not", () => {
    // Zero is just as damaging as starting_cash: it drags total_real into a
    // fake drawdown. Ensure real-money is simply absent on days without data.
    const result = buildAllPortfoliosEquity({
      today: "2026-07-24",
      portfolios: [simPortfolio(), realPortfolio({ current_cash: 0 })],
      snapshots: [
        { portfolio_id: SIM, snapshot_date: "2026-07-20", total_value: 1000 },
        { portfolio_id: SIM, snapshot_date: "2026-07-21", total_value: 1010 },
        { portfolio_id: REAL, snapshot_date: "2026-07-22", total_value: 300 },
        { portfolio_id: REAL, snapshot_date: "2026-07-23", total_value: 305 },
      ],
    });

    for (const row of result.series) {
      const date = String(row.date);
      if (date < "2026-07-22") {
        expect(REAL in row).toBe(false);
        expect("total_real" in row).toBe(false);
      }
    }
  });

  it("keeps sim and real totals independent — total_real never inherits sim history", () => {
    const result = buildAllPortfoliosEquity({
      today: "2026-07-24",
      portfolios: [simPortfolio(), realPortfolio()],
      snapshots: [
        { portfolio_id: SIM, snapshot_date: "2026-06-01", total_value: 800 },
        { portfolio_id: SIM, snapshot_date: "2026-07-24", total_value: 1040 },
        { portfolio_id: REAL, snapshot_date: "2026-07-24", total_value: 300 },
      ],
    });

    const totalReals = result.series
      .filter((row) => "total_real" in row)
      .map((row) => ({ date: row.date, value: row.total_real }));
    expect(totalReals).toEqual([{ date: "2026-07-24", value: 300 }]);
    // total_real must never equal the sim total on any date.
    for (const row of result.series) {
      if ("total_real" in row && "total_sim" in row) {
        // Same day is allowed to differ; ensure real matches only real inputs.
        expect(row.total_real).toBe(300);
      }
    }
  });

  it("does not backfill even when multiple real portfolios start on different days", () => {
    const result = buildAllPortfoliosEquity({
      today: "2026-07-24",
      portfolios: [
        realPortfolio({ id: REAL, starting_cash: 300, current_cash: 300 }),
        realPortfolio({ id: REAL2, name: "Live #2", starting_cash: 500, current_cash: 500 }),
      ],
      snapshots: [
        { portfolio_id: REAL, snapshot_date: "2026-07-20", total_value: 300 },
        { portfolio_id: REAL, snapshot_date: "2026-07-24", total_value: 310 },
        { portfolio_id: REAL2, snapshot_date: "2026-07-24", total_value: 500 },
      ],
    });

    // REAL2 must not appear on 2026-07-20 (it didn't exist yet).
    const row0720 = result.series.find((r) => r.date === "2026-07-20")!;
    expect(REAL2 in row0720).toBe(false);
    // total_real on 2026-07-20 is just REAL alone.
    expect(row0720.total_real).toBe(300);
    // On today, both contribute.
    const row0724 = result.series.find((r) => r.date === "2026-07-24")!;
    expect(row0724.total_real).toBe(810);
  });

  it("ignores non-finite snapshot values instead of forward-filling starting_cash", () => {
    const snapshots: EquitySnapshotInput[] = [
      { portfolio_id: REAL, snapshot_date: "2026-07-24", total_value: "not-a-number" },
    ];
    const result = buildAllPortfoliosEquity({
      today: "2026-07-24",
      portfolios: [realPortfolio({ current_cash: 300 })],
      snapshots,
    });
    // Because the snapshot exists (even if unparseable), the selector must
    // NOT fall back to current_cash — that would silently hide broken data.
    // A REAL entry may or may not be present, but if present it must not be
    // starting_cash / current_cash.
    for (const row of result.series) {
      if (REAL in row) {
        expect(row[REAL]).not.toBe(300);
      }
    }
  });
});
