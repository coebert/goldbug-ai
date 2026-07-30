// Guards against division-by-zero and formatting regressions when the
// prior real-money equity baseline is 0 (e.g. brand-new portfolio, or a
// portfolio that was fully liquidated between the two snapshots we're
// comparing).
//
// Requirements verified:
//   1. computeModeSummary never emits a non-finite `pct` when previous <= 0.
//   2. The `pnl` sign is preserved (positive for gains from zero, negative
//      for losses that landed us at zero, zero when both are zero).
//   3. Deposits that arrive between prev(=0) and last are still netted
//      out of pnl — a first-time deposit must not read as profit.
//   4. The ModeSummaryTile formatter renders a safe "0.00%" pct (no NaN,
//      no Infinity, no "£NaN") when the baseline is 0.

import { renderToString } from "react-dom/server";
import React from "react";
import { describe, expect, it } from "vitest";
import { computeModeSummary } from "../mode-summary";
import { ModeSummaryTile } from "@/routes/index";

const REAL = "11111111-1111-4111-8111-111111111111";
const portfolios = [{ id: REAL, mode: "live_prod" }];

describe("computeModeSummary — prior baseline = 0", () => {
  it("previous=0, now=0 → pct=0, pnl=0 (no division error)", () => {
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL]: 0 },
        { date: "2026-07-23", [REAL]: 0 },
      ],
      portfolios,
    )!;
    expect(s.real.now).toBe(0);
    expect(s.real.pnl).toBe(0);
    expect(s.real.pct).toBe(0);
    expect(Number.isFinite(s.real.pct)).toBe(true);
  });

  it("previous=0, now=+150 with no deposits → pnl positive, pct safely 0 (avoids +Infinity)", () => {
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL]: 0 },
        { date: "2026-07-23", [REAL]: 150 },
      ],
      portfolios,
    )!;
    expect(s.real.now).toBe(150);
    expect(s.real.pnl).toBe(150);
    expect(s.real.pct).toBe(0);
    expect(Number.isFinite(s.real.pct)).toBe(true);
  });

  it("previous=0, now=-50 → pnl preserves negative sign, pct safely 0", () => {
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL]: 0 },
        { date: "2026-07-23", [REAL]: -50 },
      ],
      portfolios,
    )!;
    expect(s.real.pnl).toBe(-50);
    expect(s.real.pct).toBe(0);
    expect(Number.isFinite(s.real.pct)).toBe(true);
  });

  it("previous=0, first-ever £300 deposit lands between snapshots → pnl=0, pct=0 (deposit is NOT profit)", () => {
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL]: 0 },
        { date: "2026-07-23", [REAL]: 300 },
      ],
      portfolios,
      [{ portfolio_id: REAL, date: "2026-07-23", amount: 300 }],
    )!;
    expect(s.real.now).toBe(300);
    expect(s.real.pnl).toBe(0);
    expect(s.real.pct).toBe(0);
  });

  it("previous negative (edge case, e.g. bad snapshot) → pct=0, no NaN", () => {
    const s = computeModeSummary(
      [
        { date: "2026-07-22", [REAL]: -10 },
        { date: "2026-07-23", [REAL]: 20 },
      ],
      portfolios,
    )!;
    expect(s.real.pct).toBe(0);
    expect(Number.isFinite(s.real.pct)).toBe(true);
  });
});

describe("ModeSummaryTile — renders zero-baseline pct safely", () => {
  const baseProps = {
    label: "Real-money equity",
    sublabel: "today",
    tone: "real" as const,
    count: 1,
  };

  it("renders +0.00% (never NaN%, never Infinity%) when pct=0 and pnl positive", () => {
    const html = renderToString(
      React.createElement(ModeSummaryTile, { ...baseProps, money: 150, pnl: 150, pct: 0 }),
    );
    expect(html).toMatch(/\+(<!-- -->)?0\.00(<!-- -->)?%/);
    expect(html).not.toMatch(/NaN/);
    expect(html).not.toMatch(/Infinity/);
    // Positive pnl → emerald tone.
    expect(html).toContain("text-success");
  });

  it("renders 0.00% with red tone when pnl is negative (loss from baseline 0)", () => {
    const html = renderToString(
      React.createElement(ModeSummaryTile, { ...baseProps, money: 0, pnl: -50, pct: 0 }),
    );
    expect(html).toMatch(/0\.00(<!-- -->)?%/);
    expect(html).toContain("text-destructive");
    expect(html).not.toMatch(/NaN/);
  });

  it("coerces a non-finite pct (Infinity) coming from an upstream bug to a safe 0.00%", () => {
    // If a regression ever lets Infinity leak into the tile, the safePct
    // guard must catch it — otherwise Intl formatting/tooltips render
    // "Infinity%" to the user.
    const html = renderToString(
      React.createElement(ModeSummaryTile, {
        ...baseProps,
        money: 300,
        pnl: 300,
        pct: Number.POSITIVE_INFINITY,
      }),
    );
    // React SSR inserts <!-- --> markers between adjacent expressions,
    // so match the digits and % separately.
    expect(html).toMatch(/0\.00(<!-- -->)?%/);
    expect(html).not.toMatch(/Infinity/);
    expect(html).not.toMatch(/NaN/);
  });

  it("coerces NaN pct to a safe 0.00% and renders a valid £ money value", () => {
    const html = renderToString(
      React.createElement(ModeSummaryTile, {
        ...baseProps,
        money: 300,
        pnl: 0,
        pct: Number.NaN,
      }),
    );
    expect(html).toMatch(/0\.00(<!-- -->)?%/);
    expect(html).toContain("£300");
    expect(html).not.toMatch(/£NaN/);
    expect(html).not.toMatch(/NaN(<!-- -->)?%/);
  });
});
