// Visual regression test for the portfolio performance chart's
// formatting + label surface. The chart's tick labels, tooltip
// numbers, y-axis title, and metric-row headers are pure functions
// exported from `portfolio-performance-format` and reused by the
// route. This suite locks their output down with Vitest snapshots
// so any accidental change to on-screen text or number formatting
// fails loudly during CI.

import { describe, expect, it } from "vitest";

import {
  COMPARE_METRIC_ROWS,
  compactChartNum,
  compareGridHeader,
  formatDateTick,
  formatMetric,
  formatSignedNum,
  formatSignedPct,
  formatTooltipValue,
  formatValueTick,
  heroMetricRows,
  shortChartDate,
  tooltipModeChip,
  yAxisLabel,
} from "../portfolio-performance-format";

// Fixed locale + timezone so `toLocaleDateString` output in
// `shortChartDate` is stable across CI hosts.
process.env.TZ = "UTC";

describe("portfolio performance chart — visual regression", () => {
  it("hero metric row labels stay consistent", () => {
    expect({
      rf_0: heroMetricRows(0),
      rf_2: heroMetricRows(2),
      rf_425: heroMetricRows(4.25),
    }).toMatchSnapshot();
  });

  it("compare-grid metric row labels stay consistent", () => {
    expect(COMPARE_METRIC_ROWS).toMatchSnapshot();
  });

  it("compare-grid header text stays consistent for named / none benchmark", () => {
    expect({
      none: compareGridHeader("none"),
      spy: compareGridHeader("SPY"),
      qqq: compareGridHeader("QQQ"),
    }).toMatchSnapshot();
  });

  it("y-axis title text stays consistent across raw/pct + currency", () => {
    expect({
      raw_gbp: yAxisLabel("raw", "£"),
      raw_usd: yAxisLabel("raw", "$"),
      pct: yAxisLabel("pct", "£"),
    }).toMatchSnapshot();
  });

  it("tooltip mode chip stays consistent", () => {
    expect({ raw: tooltipModeChip(false), pct: tooltipModeChip(true) }).toMatchSnapshot();
  });

  it("x-axis date tick uses raw ISO on desktop and short label on mobile", () => {
    const cases = ["2024-01-04", "2024-06-15", "2024-12-31", "not-a-date"];
    expect({
      desktop: cases.map((d) => formatDateTick(d, false)),
      mobile: cases.map((d) => formatDateTick(d, true)),
    }).toMatchSnapshot();
  });

  it("compactChartNum formats k / M thresholds consistently", () => {
    expect([0, 500, 999, 1_000, 9_999, 10_000, 999_999, 1_000_000, 9_999_999, 10_000_000, -1_500, -1_500_000]
      .map((v) => `${v} → ${compactChartNum(v)}`))
      .toMatchSnapshot();
  });

  it("shortChartDate handles invalid strings without throwing", () => {
    expect({
      valid: shortChartDate("2024-03-15"),
      invalid: shortChartDate("not-a-date"),
      empty: shortChartDate(""),
    }).toMatchSnapshot();
  });

  it("y-axis value tick formats raw currency (desktop + mobile) and pct", () => {
    const values = [0, 250, 1_000, 12_345.67, 1_500_000, -750];
    expect({
      raw_desktop_gbp: values.map((v) => formatValueTick(v, { currency: "£", isPct: false, isMobile: false })),
      raw_mobile_gbp: values.map((v) => formatValueTick(v, { currency: "£", isPct: false, isMobile: true })),
      raw_desktop_usd: values.map((v) => formatValueTick(v, { currency: "$", isPct: false, isMobile: false })),
      pct_desktop: values.map((v) => formatValueTick(v, { currency: "£", isPct: true, isMobile: false })),
      pct_mobile: values.map((v) => formatValueTick(v, { currency: "£", isPct: true, isMobile: true })),
    }).toMatchSnapshot();
  });

  it("tooltip value formatter renders raw currency and pct with 2dp", () => {
    const values = [0, 12.5, 1_234.567, -50.25];
    expect({
      raw_gbp: values.map((v) => formatTooltipValue(v, { currency: "£", isPct: false })),
      pct: values.map((v) => formatTooltipValue(v, { currency: "£", isPct: true })),
    }).toMatchSnapshot();
  });

  it("signed pct + signed number helpers keep +/- prefix consistent", () => {
    const values = [0, 5.4321, -3.1, 100];
    expect({
      signedPct: values.map((v) => formatSignedPct(v)),
      signedPct_0dp: values.map((v) => formatSignedPct(v, 0)),
      signedNum: values.map((v) => formatSignedNum(v)),
    }).toMatchSnapshot();
  });

  it("metric-tile formatter handles finite / null / NaN / Infinity + signed/unsigned", () => {
    const rows = [
      { label: "signed pct positive", v: 12.3456, opts: { signed: true, suffix: "%" } },
      { label: "signed pct negative", v: -4.2, opts: { signed: true, suffix: "%" } },
      { label: "signed pct zero", v: 0, opts: { signed: true, suffix: "%" } },
      { label: "unsigned pct", v: 12.3, opts: { signed: false, suffix: "%" } },
      { label: "unitless signed", v: 1.5, opts: { signed: true, suffix: "" } },
      { label: "null", v: null, opts: { signed: true, suffix: "%" } },
      { label: "undefined", v: undefined, opts: { signed: true, suffix: "%" } },
      { label: "NaN", v: Number.NaN, opts: { signed: true, suffix: "%" } },
      { label: "Infinity", v: Number.POSITIVE_INFINITY, opts: { signed: true, suffix: "%" } },
    ] as const;
    expect(rows.map((r) => ({ label: r.label, out: formatMetric(r.v, r.opts) }))).toMatchSnapshot();
  });
});
