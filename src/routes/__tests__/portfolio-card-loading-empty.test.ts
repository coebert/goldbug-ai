// Locks the dedicated loading/empty rendering contract for the portfolio
// card's equity slots. The headline £ and the % pill MUST switch modes
// in lockstep so users never see a loaded £ number beside a stale %
// (or vice versa). Both slots pivot on the same (isLoadingEquity,
// sparkSeries.length === 0) inputs — this test proves that at the
// source level so a future edit cannot silently split them.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(resolve(__dirname, "../../components/home/portfolio-row.tsx"), "utf8");

describe("portfolio card — dedicated loading/empty rendering", () => {
  it("derives equityLoading and equityEmpty from the same inputs", () => {
    // Single source of truth: both slots MUST read these two flags,
    // not re-derive their own (which is how the two used to drift).
    expect(SOURCE).toMatch(
      /const\s+equityLoading\s*=\s*isLoadingEquity\s*&&\s*sparkSeries\.length\s*===\s*0/,
    );
    expect(SOURCE).toMatch(
      /const\s+equityEmpty\s*=\s*!isLoadingEquity\s*&&\s*sparkSeries\.length\s*===\s*0/,
    );
  });

  it("% pill renders a dedicated skeleton while loading (never a stale number)", () => {
    expect(SOURCE).toMatch(/data-testid="range-pct-skeleton"/);
    expect(SOURCE).toMatch(/aria-label="Loading equity change"/);
    // Skeleton branch is gated on equityLoading — same flag as the
    // headline skeleton — so the two cannot render out of phase.
    expect(SOURCE).toMatch(
      /[{:]\s*equityLoading \? \(\s*<Skeleton\s+variant="shimmer"\s+data-testid="range-pct-skeleton"/,
    );
  });

  it("% pill renders an em-dash empty state when there's no data (never a stale +0.0%)", () => {
    expect(SOURCE).toMatch(/data-testid="range-pct-empty"/);
    expect(SOURCE).toMatch(/aria-label="No equity change data"/);
    // Empty branch fires for equityEmpty OR a null rangePct (e.g. a
    // series too short to compute a %). Prevents phantom "+0.0%".
    expect(SOURCE).toMatch(/equityEmpty \|\| rangePct == null/);
  });

  it("headline renders an em-dash empty state with an explanatory sub-line", () => {
    expect(SOURCE).toMatch(/data-testid="total-equity-empty"/);
    expect(SOURCE).toMatch(/aria-label="Total equity unavailable"/);
    // Empty headline shows the currency + em-dash so column width
    // stays stable and the muted colour signals "no data" (not "£0").
    expect(SOURCE).toMatch(
      /\{portfolio\.currency\}\s+—\s*<\/div>[\s\S]{0,120}No equity snapshots yet/,
    );
  });

  it("headline skeleton is still gated on the shared equityLoading flag", () => {
    // Guards against a regression where the headline used a bespoke
    // condition (e.g. `isLoadingEquity && !sparkSeries.length`) that
    // could disagree with the % pill's condition.
    expect(SOURCE).toMatch(
      /[{:]\s*equityLoading \? \(\s*<div[\s\S]{0,400}data-testid="total-equity-loading"[\s\S]{0,600}data-testid="total-equity-skeleton"/,
    );
  });

  it("neither slot has a fourth code path — three exhaustive branches only", () => {
    // Sanity check: each slot has exactly one loading branch, one
    // empty branch, and one loaded branch. Anything else risks the
    // two slots showing different content for the same state.
    const rangeBranches =
      (SOURCE.match(/data-testid="range-pct-(skeleton|empty)"/g) ?? []).length;
    const totalBranches =
      (SOURCE.match(/data-testid="total-equity-(skeleton|empty)"/g) ?? []).length;
    expect(rangeBranches).toBe(2);
    expect(totalBranches).toBe(2);
  });
});
