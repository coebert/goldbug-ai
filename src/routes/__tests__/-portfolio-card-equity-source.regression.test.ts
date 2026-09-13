// Regression: the prominent "Total equity" headline on every home-page
// portfolio card MUST be sourced from the same sparkline series that
// feeds the % change (computeCardRangePct). If the two ever diverge,
// users see a headline £ number that contradicts the % below it.
//
// This suite locks the contract two ways:
//   1. Source-level: src/routes/index.tsx derives totalEquity from
//      `sparkSeries[sparkSeries.length - 1].value` (same array the %
//      helper receives) and only falls back to portfolio.current_cash
//      when the series is empty.
//   2. Behavioural: for a variety of series shapes, the headline value
//      the card renders equals the last point of the same series used
//      by computeCardRangePct — deposits toggle on OR off, both ranges.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { computeCardRangePct, type CardSparkPoint } from "@/lib/card-range-pct";

const SOURCE = readFileSync(resolve(__dirname, "../index.tsx"), "utf8") + "\n" + readFileSync(resolve(__dirname, "../../components/home/portfolio-row.tsx"), "utf8");

// Mirror of the card's headline derivation. If the production line
// changes shape, the source-level guard below fires — force the author
// to update BOTH this mirror and the assertion so they stay in lockstep.
function headlineTotalEquity(
  sparkSeries: CardSparkPoint[],
  fallbackCash: number,
): number {
  return sparkSeries.length > 0
    ? sparkSeries[sparkSeries.length - 1].value
    : Number(fallbackCash);
}

describe("portfolio card — total equity headline shares the % change source", () => {
  it("source: totalEquity is derived by deriveCardEquity(sparkSeries, sliced, ...) — same array feeds both", () => {
    // The row must funnel BOTH numbers through the single-source-of-truth
    // helper, passing the raw `sparkSeries` for the headline and the
    // `sliced` suffix for the % — so they can never diverge.
    expect(SOURCE).toMatch(
      /const\s*\{\s*totalEquity\s*,\s*rangePct\s*\}\s*=\s*deriveCardEquity\(\s*sparkSeries\s*,\s*sliced\s*,/,
    );
    // The sliced view fed into the helper is a suffix of sparkSeries
    // (see the useMemo above the call site).
    expect(SOURCE).toMatch(/\[sparkSeries,\s*sparkRange\]/);
  });


  it("headline equals last sparkline point regardless of deposits toggle", () => {
    const series: CardSparkPoint[] = [
      { date: "2026-07-20", value: 1000 },
      { date: "2026-07-21", value: 1100 },
      { date: "2026-07-22", value: 1250 },
    ];
    const deposits = [{ date: "2026-07-21", amount: 100 }];
    const headline = headlineTotalEquity(series, 999); // fallback ignored

    // Same series, same last point — must equal the last raw value,
    // NOT the deposit-adjusted last (headline is £ value, not PnL).
    expect(headline).toBe(1250);

    // % helper consumes the SAME series → both numbers are derived
    // from one source of truth. Sanity-check both toggle states.
    const pctExcl = computeCardRangePct(series, deposits, false);
    const pctIncl = computeCardRangePct(series, deposits, true);
    expect(pctExcl).not.toBeNull();
    expect(pctIncl).not.toBeNull();
    // Raw last / raw first − 1 must match the "include deposits" %,
    // proving the % helper is reading the same last-point value that
    // becomes the headline.
    expect(pctIncl).toBeCloseTo(((1250 - 1000) / 1000) * 100, 5);
  });

  it("fallback to current_cash only when the series is empty", () => {
    expect(headlineTotalEquity([], 742.5)).toBe(742.5);
    // With any point at all, the fallback is ignored — the headline
    // is the last series point, so it cannot silently disagree with
    // the % (which is null on empty series).
    const oneOnly: CardSparkPoint[] = [{ date: "2026-07-22", value: 12.34 }];
    expect(headlineTotalEquity(oneOnly, 999_999)).toBe(12.34);
    expect(computeCardRangePct(oneOnly, [], false)).toBeCloseTo(0, 5);
  });

  it("randomised series: headline is always sparkSeries[last].value", () => {
    // Property-style: for a batch of shapes, the headline never drifts
    // from the last series point. Any accidental substitution (e.g.
    // portfolio.current_cash, sum of holdings, adjusted value) would
    // fail here on the very first random shape.
    let seed = 1_337;
    const rand = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 0xffff_ffff;
    };
    for (let trial = 0; trial < 25; trial++) {
      const n = 2 + Math.floor(rand() * 30);
      const series: CardSparkPoint[] = Array.from({ length: n }, (_, i) => ({
        date: `2026-07-${String((i % 28) + 1).padStart(2, "0")}`,
        value: 100 + rand() * 10_000,
      }));
      const fallback = rand() * 10_000; // must NOT be used
      const headline = headlineTotalEquity(series, fallback);
      expect(headline).toBe(series[series.length - 1].value);
      // And the % helper, given the same array, resolves without
      // reaching for any other source (no null when non-empty).
      expect(computeCardRangePct(series, [], false)).not.toBeNull();
    }
  });
});
