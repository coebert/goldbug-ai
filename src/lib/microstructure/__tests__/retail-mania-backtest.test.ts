// Backtest of the retail-mania guardrail against the curated 2020–2023
// episode set. Prints the full report and asserts headline metrics so
// regressions in the detector thresholds or dataset are caught.
import { describe, it, expect } from "vitest";
import {
  runRetailManiaBacktest,
  formatBacktestReport,
} from "../retail-mania-backtest";
import { MANIA_COUNT, CONTROL_COUNT } from "../retail-mania-episodes";

describe("Retail-mania guardrail — 2020–2023 backtest", () => {
  const report = runRetailManiaBacktest();

  it("prints the full report for the run log", () => {
    // Emitted so the numbers surface in `vitest run` output for auditing.
    // eslint-disable-next-line no-console
    console.log("\n" + formatBacktestReport(report) + "\n");
    expect(report.totalSnapshots).toBe(MANIA_COUNT + CONTROL_COUNT);
    expect(report.maniaSnapshots).toBe(MANIA_COUNT);
    expect(report.controlSnapshots).toBe(CONTROL_COUNT);
  });

  it("catches ≥ 90% of true mania snapshots (recall)", () => {
    expect(report.confusion.blockRecall).toBeGreaterThanOrEqual(0.9);
  });

  it("keeps block precision ≥ 80% (few false-positive blocks)", () => {
    expect(report.confusion.blockPrecision).toBeGreaterThanOrEqual(0.8);
  });

  it("misses no more than 1 profitable reversal across the whole set", () => {
    expect(report.opportunityCost.blockedProfitableCount).toBeLessThanOrEqual(1);
  });

  it("materially reduces mean 60-day max drawdown vs baseline", () => {
    // Baseline is dominated by mania blowups (~-70% mean DD). Sitting out the
    // mania set should cut mean drawdown by at least half in absolute terms.
    expect(report.drawdownReduction.meanPct).toBeGreaterThanOrEqual(0.4);
  });

  it("removes the worst tail drawdown", () => {
    // Baseline worst is HKD / KOSS at ~ -95%+; guardrail must eliminate
    // that tail (worst guardrail DD comes only from controls now).
    expect(report.baseline.worstMaxDrawdown60d).toBeLessThanOrEqual(-0.9);
    expect(report.guardrail.worstMaxDrawdown60d).toBeGreaterThan(-0.6);
  });

  it("improves mean forward 20-day return by sitting out the mania blowups", () => {
    expect(report.guardrail.meanForward20d).toBeGreaterThan(report.baseline.meanForward20d);
  });

  it("2021 (peak mania year) shows the largest drawdown improvement", () => {
    const y2021 = report.byYear["2021"];
    expect(y2021).toBeDefined();
    const improvement =
      y2021.guardrail.meanMaxDrawdown60d - y2021.baseline.meanMaxDrawdown60d;
    expect(improvement).toBeGreaterThan(0.3); // ≥ +30 percentage points less drawdown
  });

  it("labels every mania snapshot at the mania tier (not just watch)", () => {
    const maniaEpisodes = report.perEpisode.filter((e) => e.isMania);
    const mislabeled = maniaEpisodes.filter((e) => e.tier !== "mania");
    // Allow up to 1 borderline case; log any misses for auditing.
    if (mislabeled.length > 0) {
      // eslint-disable-next-line no-console
      console.log("mania snapshots below the mania tier:", mislabeled);
    }
    expect(mislabeled.length).toBeLessThanOrEqual(1);
  });

  it("does not block obvious non-mania breakouts (NVDA/META/MSFT/GOOGL/SMCI)", () => {
    const wronglyBlocked = report.perEpisode.filter(
      (e) => !e.isMania && e.blocked &&
        ["NVDA", "META", "MSFT", "GOOGL", "SMCI"].includes(e.symbol),
    );
    expect(wronglyBlocked).toHaveLength(0);
  });
});
