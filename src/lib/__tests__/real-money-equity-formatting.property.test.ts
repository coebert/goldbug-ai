// Property-based tests: the real-money equity tile's formatted output
// must NEVER contain "NaN", "Infinity", or scientific notation
// (e.g. "1e+21", "2.5E-7"), regardless of the numeric inputs it
// receives from upstream snapshot pipelines.
//
// We stress the ModeSummaryTile — the single component that renders
// the headline equity, delta £, and delta % — across a wide random
// distribution of money / pnl / pct values including edge magnitudes
// (sub-penny, trillions, negatives) and pathological inputs
// (NaN, ±Infinity, MAX_VALUE, MIN_VALUE, subnormals).
//
// Also fuzzes computeModeSummary end-to-end with random per-portfolio
// snapshot totals + random deposit events, asserting that every
// derived field it produces (now, pnl, pct) formats cleanly.

import { renderToString } from "react-dom/server";
import React from "react";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeModeSummary } from "../mode-summary";
import { ModeSummaryTile } from "@/routes/index";

const FORBIDDEN = /NaN|Infinity|[0-9](?:\.[0-9]+)?[eE][+-]?[0-9]/;

const REAL = "11111111-1111-4111-8111-111111111111";
const SIM = "22222222-2222-4222-8222-222222222222";
const portfolios = [
  { id: REAL, mode: "live_prod" },
  { id: SIM, mode: "paper" },
];

function renderTile(money: number, pnl: number, pct: number, tone: "real" | "sim" = "real") {
  return renderToString(
    React.createElement(ModeSummaryTile, {
      label: "Real-money equity",
      sublabel: "today",
      tone,
      count: 1,
      money,
      pnl,
      pct,
    }),
  );
}

// A generator that mixes ordinary finite numbers with the pathological
// values most likely to trip Intl.NumberFormat / toFixed.
const anyNumberArb = fc.oneof(
  { weight: 8, arbitrary: fc.double({ noDefaultInfinity: true, noNaN: true, min: -1e15, max: 1e15 }) },
  { weight: 2, arbitrary: fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }) },
  { weight: 1, arbitrary: fc.constantFrom(
      0, -0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      Number.EPSILON,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
      1e-21,
      1e21,
      1e300,
    ),
  },
);

describe("ModeSummaryTile — property: no NaN / Infinity / scientific notation in rendered output", () => {
  it("holds for arbitrary money/pnl/pct triples", () => {
    fc.assert(
      fc.property(anyNumberArb, anyNumberArb, anyNumberArb, (money, pnl, pct) => {
        const html = renderTile(money, pnl, pct);
        // The tile guards non-finite values at the boundary, and its
        // money formatter uses maximumFractionDigits: 0 (never emits
        // exponential form for finite inputs the guard preserves).
        expect(html, `bad tile output for money=${money}, pnl=${pnl}, pct=${pct}`).not.toMatch(
          FORBIDDEN,
        );
      }),
      { numRuns: 500 },
    );
  });

  it("holds for both real and sim tone", () => {
    fc.assert(
      fc.property(
        anyNumberArb,
        anyNumberArb,
        anyNumberArb,
        fc.constantFrom<"real" | "sim">("real", "sim"),
        (money, pnl, pct, tone) => {
          const html = renderTile(money, pnl, pct, tone);
          expect(html).not.toMatch(FORBIDDEN);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("computeModeSummary → ModeSummaryTile — property: end-to-end formatting is always safe", () => {
  // Generate 1–8 chronological snapshot rows, each with independently
  // random real- and sim-mode totals, plus 0–5 deposit events dated
  // within the same window. Feed the derived summary straight into the
  // tile and assert forbidden tokens never appear.
  const rowArb = fc.record({
    real: fc.oneof(anyNumberArb, fc.constant(0)),
    sim: fc.oneof(anyNumberArb, fc.constant(0)),
  });

  const depositArb = fc.record({
    portfolio_id: fc.constantFrom(REAL, SIM),
    dayOffset: fc.integer({ min: 0, max: 7 }),
    amount: fc.oneof(
      fc.double({ noDefaultInfinity: true, noNaN: true, min: -1e9, max: 1e9 }),
      fc.constantFrom(0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
    ),
  });

  it("never surfaces NaN, Infinity, or scientific notation in either tile", () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { minLength: 1, maxLength: 8 }),
        fc.array(depositArb, { minLength: 0, maxLength: 5 }),
        (rowSpecs, depositSpecs) => {
          const series = rowSpecs.map((r, i) => ({
            date: `2026-07-${String(10 + i).padStart(2, "0")}`,
            [REAL]: r.real,
            [SIM]: r.sim,
          }));
          const deposits = depositSpecs.map((d) => ({
            portfolio_id: d.portfolio_id,
            date: `2026-07-${String(10 + Math.min(d.dayOffset, rowSpecs.length - 1)).padStart(2, "0")}`,
            amount: d.amount,
          }));
          const summary = computeModeSummary(series, portfolios, deposits);
          if (!summary) return; // null is a valid, safe outcome.

          for (const [tone, s] of [
            ["real", summary.real] as const,
            ["sim", summary.sim] as const,
          ]) {
            const html = renderTile(s.now, s.pnl, s.pct, tone);
            expect(
              html,
              `bad tile for tone=${tone}, now=${s.now}, pnl=${s.pnl}, pct=${s.pct}`,
            ).not.toMatch(FORBIDDEN);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
