// End-to-end: the portfolio-card "Total equity" headline must render a
// shimmer Skeleton while the equity series is loading, and then swap
// to the correctly formatted GBP amount (via `formatMoneyAmount`) as
// soon as the series arrives — with no interim blank / mismatched
// state and no leftover skeleton chrome.
//
// The environment here is `node` (no jsdom), matching the rest of the
// e2e suite. We therefore express the transition as two successive
// `renderToStaticMarkup` calls of a harness component that mirrors the
// exact loading / loaded branch structure the production PortfolioRow
// renders in `src/routes/index.tsx` — plus a source-level guard so
// the harness is kept honest if the real branch ever drifts.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney, formatMoneyAmount } from "@/lib/format-money";

// Mirrors the JSX in src/routes/index.tsx around the equityLoading /
// equityEmpty / loaded branches. The source-level test below asserts
// this stays in lockstep with production.
function HeadlineHarness({
  currency,
  totalEquity,
  currentCash,
  equityDecimals = 2,
  isLoading,
}: {
  currency: string;
  totalEquity: number;
  currentCash: number;
  equityDecimals?: number;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading total equity"
        data-testid="total-equity-loading"
        className="flex flex-col items-end gap-1"
      >
        <Skeleton
          variant="shimmer"
          data-testid="total-equity-skeleton"
          className="mt-1 h-8 w-40"
        />
        <Skeleton variant="shimmer" className="h-4 w-24" />
        <Skeleton variant="shimmer" className="h-4 w-16" />
      </div>
    );
  }
  return (
    <div data-testid="total-equity-loaded">
      <div
        data-testid="total-equity-value"
        className="text-2xl font-bold leading-tight tabular-nums"
      >
        {currency} {formatMoneyAmount(totalEquity, equityDecimals)}
      </div>
      <div
        data-testid="total-equity-cash"
        className="mt-1 text-xs tabular-nums text-muted-foreground"
      >
        {formatMoney(currentCash, currency, equityDecimals)}
        <span className="ml-1 text-[10px]">cash</span>
      </div>
    </div>
  );
}

describe("Portfolio card headline: Skeleton → formatted GBP transition", () => {
  const scenario = {
    currency: "GBP",
    totalEquity: 1_234_567.895, // rounds to .90 with halfExpand
    currentCash: 1000,
  };

  it("shows a shimmer Skeleton (no value, no '—') while equity is loading", () => {
    const html = renderToStaticMarkup(
      <HeadlineHarness
        currency={scenario.currency}
        totalEquity={scenario.totalEquity}
        currentCash={scenario.currentCash}
        isLoading
      />,
    );
    // Loading chrome present.
    expect(html).toContain('data-testid="total-equity-loading"');
    expect(html).toContain('data-testid="total-equity-skeleton"');
    expect(html).toContain('data-variant="shimmer"');
    expect(html).toMatch(/role="status"/);
    expect(html).toMatch(/aria-busy="true"/);
    // Headline box height matches the final text-2xl typography.
    expect(html).toMatch(/<[^>]*data-testid="total-equity-skeleton"[^>]*>/);
    expect(html).toMatch(/class="[^"]*\bh-8\b[^"]*"[^>]*data-testid="total-equity-skeleton"|data-testid="total-equity-skeleton"[^>]*class="[^"]*\bh-8\b/);
    // No formatted value, no empty-state em-dash, no currency prefix leaks.
    expect(html).not.toMatch(/GBP\s*[\d,]/);
    expect(html).not.toContain("—");
    expect(html).not.toContain('data-testid="total-equity-loaded"');
  });

  it("swaps to the correctly formatted GBP amount once the series arrives", () => {
    const html = renderToStaticMarkup(
      <HeadlineHarness
        currency={scenario.currency}
        totalEquity={scenario.totalEquity}
        currentCash={scenario.currentCash}
        isLoading={false}
      />,
    );
    // Skeleton chrome fully torn down.
    expect(html).not.toContain('data-testid="total-equity-loading"');
    expect(html).not.toContain('data-testid="total-equity-skeleton"');
    expect(html).not.toContain("skeleton-shimmer");
    expect(html).not.toContain('aria-busy="true"');
    // Loaded structure present with the exact formatter output.
    expect(html).toContain('data-testid="total-equity-loaded"');
    const expected = `GBP ${formatMoneyAmount(scenario.totalEquity)}`;
    expect(expected).toBe("GBP 1,234,567.90"); // formatter contract sanity
    expect(html).toContain(expected);
    // Cash sub-line uses the same formatter + currency prefix.
    expect(html).toContain(formatMoney(scenario.currentCash, "GBP"));
  });

  it("respects the user's equityDecimals preference on the loaded headline", () => {
    for (const digits of [0, 1, 3, 4] as const) {
      const html = renderToStaticMarkup(
        <HeadlineHarness
          currency="GBP"
          totalEquity={scenario.totalEquity}
          currentCash={scenario.currentCash}
          equityDecimals={digits}
          isLoading={false}
        />,
      );
      expect(html).toContain(
        `GBP ${formatMoneyAmount(scenario.totalEquity, digits)}`,
      );
    }
  });

  it("transition is atomic: loading and loaded markup share zero DOM overlap", () => {
    const loading = renderToStaticMarkup(
      <HeadlineHarness
        currency="GBP"
        totalEquity={scenario.totalEquity}
        currentCash={scenario.currentCash}
        isLoading
      />,
    );
    const loaded = renderToStaticMarkup(
      <HeadlineHarness
        currency="GBP"
        totalEquity={scenario.totalEquity}
        currentCash={scenario.currentCash}
        isLoading={false}
      />,
    );
    // Testids are disjoint — no stale skeleton can survive into the
    // loaded frame, and no half-loaded value can leak into loading.
    expect(loading).toContain('data-testid="total-equity-loading"');
    expect(loaded).not.toContain('data-testid="total-equity-loading"');
    expect(loaded).toContain('data-testid="total-equity-loaded"');
    expect(loading).not.toContain('data-testid="total-equity-loaded"');
  });

  it("harness stays aligned with the production branch in src/routes/index.tsx", () => {
    // Source-level guard: if the real PortfolioRow's loading / loaded
    // branches drift (renamed testid, dropped shimmer, moved
    // formatter), this test fires so the harness can be updated in the
    // same PR — preventing a false-green e2e.
    const src = readFileSync(resolve(__dirname, "../index.tsx"), "utf8") + "\n" + readFileSync(resolve(__dirname, "../../components/home/portfolio-row.tsx"), "utf8") + "\n" + readFileSync(resolve(__dirname, "../../components/home/portfolio-row.tsx"), "utf8");
    // Loading branch: skeleton with h-8, shimmer variant, matching testid.
    expect(src).toMatch(
      /data-testid="total-equity-loading"[\s\S]*?variant="shimmer"[\s\S]*?data-testid="total-equity-skeleton"[\s\S]*?h-8/,
    );
    // Loaded branch: same formatter + decimals prop pair used by the
    // harness above.
    expect(src).toMatch(
      /\{portfolio\.currency\}\s*\{formatMoneyAmount\(totalEquity,\s*equityDecimals\)\}/,
    );
  });
});
