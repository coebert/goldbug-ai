import { describe, it, expect } from "vitest";
import {
  checkStartingCashIntegrity,
  buildStartingCashIntegrityReport,
} from "../starting-cash-integrity";

const base = {
  portfolioId: "p1",
  portfolioName: "Sim",
  currency: "GBP",
  mode: "paper",
  currentCash: 100,
};

describe("checkStartingCashIntegrity", () => {
  it("passes when starting_cash = seed + Σ deposits and snapshot agrees", () => {
    const r = checkStartingCashIntegrity({
      ...base,
      startingCash: 300,
      deposits: [
        { date: "2026-01-05", amount: 100 },
        { date: "2026-02-10", amount: 100 },
      ],
      earliestSnapshot: { date: "2026-01-01", totalValue: 100 },
    });
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
    expect(r.impliedSeed).toBe(100);
    expect(r.totalDeposits).toBe(200);
  });

  it("flags implied_seed_negative when deposits exceed starting_cash", () => {
    const r = checkStartingCashIntegrity({
      ...base,
      startingCash: 50,
      deposits: [{ date: "2026-01-05", amount: 100 }],
    });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.code)).toContain("implied_seed_negative");
  });

  it("warns on snapshot_seed_mismatch when implied seed disagrees with first snapshot", () => {
    const r = checkStartingCashIntegrity({
      ...base,
      startingCash: 300,
      deposits: [{ date: "2026-01-05", amount: 200 }],
      earliestSnapshot: { date: "2026-01-01", totalValue: 190.38 },
    });
    // implied seed = 100, snapshot seed = 190.38 → mismatch
    const codes = r.violations.map((v) => v.code);
    expect(codes).toContain("snapshot_seed_mismatch");
    expect(r.ok).toBe(false);
  });

  it("tolerates sub-£0.50 drift between implied and snapshot seed", () => {
    const r = checkStartingCashIntegrity({
      ...base,
      startingCash: 300,
      deposits: [{ date: "2026-01-05", amount: 200 }],
      earliestSnapshot: { date: "2026-01-01", totalValue: 100.3 },
    });
    expect(r.ok).toBe(true);
  });

  it("flags non_finite starting_cash", () => {
    const r = checkStartingCashIntegrity({
      ...base,
      startingCash: Number.NaN,
      deposits: [],
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0].code).toBe("non_finite");
  });

  it("flags current_cash_below_zero", () => {
    const r = checkStartingCashIntegrity({
      ...base,
      startingCash: 300,
      currentCash: -5,
      deposits: [],
      earliestSnapshot: { date: "2026-01-01", totalValue: 300 },
    });
    expect(r.violations.map((v) => v.code)).toContain("current_cash_below_zero");
  });

  it("detects same-day deposit chain drift", () => {
    const r = checkStartingCashIntegrity({
      ...base,
      startingCash: 300,
      deposits: [
        { date: "2026-01-05", amount: 100, balanceAfter: 200 },
        { date: "2026-01-05", amount: 100, balanceAfter: 999 }, // should be 300
      ],
      earliestSnapshot: { date: "2026-01-01", totalValue: 100 },
    });
    expect(r.violations.map((v) => v.code)).toContain("deposit_chain_drift");
  });

  it("does not flag drift across different days (trading PnL may explain gap)", () => {
    const r = checkStartingCashIntegrity({
      ...base,
      startingCash: 300,
      deposits: [
        { date: "2026-01-05", amount: 100, balanceAfter: 200 },
        { date: "2026-02-10", amount: 100, balanceAfter: 350 },
      ],
      earliestSnapshot: { date: "2026-01-01", totalValue: 100 },
    });
    expect(r.violations.filter((v) => v.code === "deposit_chain_drift")).toHaveLength(0);
  });
});

describe("buildStartingCashIntegrityReport", () => {
  it("aggregates flagged count and preserves per-portfolio results", () => {
    const report = buildStartingCashIntegrityReport([
      {
        ...base,
        portfolioId: "ok",
        startingCash: 300,
        deposits: [{ date: "2026-01-05", amount: 200 }],
        earliestSnapshot: { date: "2026-01-01", totalValue: 100 },
      },
      {
        ...base,
        portfolioId: "bad",
        startingCash: 50,
        deposits: [{ date: "2026-01-05", amount: 100 }],
      },
    ]);
    expect(report.totalPortfolios).toBe(2);
    expect(report.flaggedPortfolios).toBe(1);
    expect(report.results.find((r) => r.portfolioId === "ok")!.ok).toBe(true);
    expect(report.results.find((r) => r.portfolioId === "bad")!.ok).toBe(false);
  });
});
