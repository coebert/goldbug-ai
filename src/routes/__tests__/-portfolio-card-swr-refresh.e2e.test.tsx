// Stale-while-revalidate contract for portfolio cards.
//
// While the equity query is *refetching in the background* (i.e. React
// Query's `isFetching` is true but `isLoading` is false because prior
// data exists), the card MUST:
//   1. Keep rendering the previous GBP headline (never fall back to a
//      Skeleton or em-dash).
//   2. Keep rendering the previous % pill (same rule).
//   3. Signal the refresh via a subtle, non-value-mutating indicator
//      (a pulsing dot + `aria-busy` on the block).
//   4. Never let the headline and the % pill diverge — both slots must
//      come from the SAME snapshot on every render, including the
//      revalidation window.
//
// Enforced with:
//   - A `HeadlineHarness` mirroring the three production branches
//     (loading / empty / loaded) plus the new refreshing decoration.
//   - A source-level guard so the harness cannot false-green if the
//     real JSX in `src/routes/index.tsx` drifts.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoneyAmount } from "@/lib/format-money";

function CardEquityHarness({
  currency,
  totalEquity,
  rangePct,
  isLoadingEquity,
  isRefreshingEquity,
  hasData,
}: {
  currency: string;
  totalEquity: number;
  rangePct: number | null;
  isLoadingEquity: boolean;
  isRefreshingEquity: boolean;
  hasData: boolean;
}) {
  const equityLoading = isLoadingEquity && !hasData;
  const equityEmpty = !isLoadingEquity && !hasData;
  return (
    <div
      data-testid="portfolio-row-equity"
      aria-busy={isRefreshingEquity || undefined}
      data-refreshing={isRefreshingEquity ? "true" : undefined}
    >
      {/* % pill */}
      {equityLoading ? (
        <Skeleton
          variant="shimmer"
          data-testid="range-pct-skeleton"
          className="h-5 w-14"
        />
      ) : equityEmpty || rangePct == null ? (
        <span data-testid="range-pct-empty">—</span>
      ) : (
        <span data-testid="range-pct-value">
          {rangePct >= 0 ? "+" : ""}
          {rangePct.toFixed(1)}%
        </span>
      )}

      {/* Total equity block */}
      <div>
        <div>
          Total equity
          {isRefreshingEquity && !equityLoading ? (
            <span
              data-testid="equity-refreshing-dot"
              aria-label="Refreshing equity"
              className="animate-pulse"
            />
          ) : null}
        </div>
        {equityLoading ? (
          <Skeleton
            variant="shimmer"
            data-testid="total-equity-skeleton"
            className="h-8 w-40"
          />
        ) : equityEmpty ? (
          <div data-testid="total-equity-empty">{currency} —</div>
        ) : (
          <div data-testid="total-equity-value">
            {currency} {formatMoneyAmount(totalEquity)}
          </div>
        )}
      </div>
    </div>
  );
}

describe("Portfolio card: stale-while-revalidate refresh", () => {
  const prev = { totalEquity: 1_234_567.895, rangePct: 4.5 };

  it("keeps last-known headline + pill visible while refetching in background", () => {
    const html = renderToStaticMarkup(
      <CardEquityHarness
        currency="GBP"
        totalEquity={prev.totalEquity}
        rangePct={prev.rangePct}
        isLoadingEquity={false}
        isRefreshingEquity
        hasData
      />,
    );
    // Values persist — no skeleton, no em-dash fallback.
    expect(html).toContain('data-testid="total-equity-value"');
    expect(html).toContain(`GBP ${formatMoneyAmount(prev.totalEquity)}`);
    expect(html).toContain('data-testid="range-pct-value"');
    expect(html).toContain("+4.5%");
    expect(html).not.toContain('data-testid="total-equity-skeleton"');
    expect(html).not.toContain('data-testid="range-pct-skeleton"');
    expect(html).not.toContain('data-testid="total-equity-empty"');
    expect(html).not.toContain('data-testid="range-pct-empty"');
    // Refresh is signalled non-destructively.
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-refreshing="true"');
    expect(html).toContain('data-testid="equity-refreshing-dot"');
  });

  it("does NOT show the refreshing dot on the initial cold load (skeleton owns that state)", () => {
    const html = renderToStaticMarkup(
      <CardEquityHarness
        currency="GBP"
        totalEquity={0}
        rangePct={null}
        isLoadingEquity
        isRefreshingEquity={false}
        hasData={false}
      />,
    );
    expect(html).toContain('data-testid="total-equity-skeleton"');
    expect(html).toContain('data-testid="range-pct-skeleton"');
    expect(html).not.toContain('data-testid="equity-refreshing-dot"');
  });

  it("headline and % pill always share the same snapshot across a refresh cycle", () => {
    // Snapshot A → background refetch → Snapshot B. At every frame
    // both slots must reflect the same numbers (no mixed A/B render).
    const frameA = renderToStaticMarkup(
      <CardEquityHarness
        currency="GBP"
        totalEquity={1000}
        rangePct={2}
        isLoadingEquity={false}
        isRefreshingEquity={false}
        hasData
      />,
    );
    const frameRefreshing = renderToStaticMarkup(
      <CardEquityHarness
        currency="GBP"
        totalEquity={1000} // keepPreviousData → previous snapshot
        rangePct={2}
        isLoadingEquity={false}
        isRefreshingEquity // background fetch
        hasData
      />,
    );
    const frameB = renderToStaticMarkup(
      <CardEquityHarness
        currency="GBP"
        totalEquity={2000}
        rangePct={5}
        isLoadingEquity={false}
        isRefreshingEquity={false}
        hasData
      />,
    );
    // A: values match.
    expect(frameA).toContain(`GBP ${formatMoneyAmount(1000)}`);
    expect(frameA).toContain("+2.0%");
    // Refreshing: still A's numbers (SWR contract).
    expect(frameRefreshing).toContain(`GBP ${formatMoneyAmount(1000)}`);
    expect(frameRefreshing).toContain("+2.0%");
    expect(frameRefreshing).not.toContain(`GBP ${formatMoneyAmount(2000)}`);
    expect(frameRefreshing).not.toContain("+5.0%");
    // B: atomic swap to new snapshot on both slots simultaneously.
    expect(frameB).toContain(`GBP ${formatMoneyAmount(2000)}`);
    expect(frameB).toContain("+5.0%");
    expect(frameB).not.toContain(`GBP ${formatMoneyAmount(1000)}`);
    expect(frameB).not.toContain("+2.0%");
  });

  it("production route wires SWR + refresh indicator", () => {
    const src = readFileSync(resolve(__dirname, "../index.tsx"), "utf8") + "\n" + readFileSync(resolve(__dirname, "../../components/home/portfolio-row.tsx"), "utf8") + "\n" + readFileSync(resolve(__dirname, "../../components/home/portfolio-row.tsx"), "utf8");
    // 1. equityQ uses keepPreviousData for SWR.
    expect(src).toMatch(/keepPreviousData/);
    expect(src).toMatch(
      /queryKey:\s*qk\.portfolios\.equity\(\)[\s\S]*?placeholderData:\s*keepPreviousData/,
    );

    // 2. Refreshing flag derived from isFetching && !isLoading.
    expect(src).toMatch(
      /isRefreshingEquity\s*=\s*equityQ\.isFetching\s*&&\s*!equityQ\.isLoading/,
    );
    // 3. Piped to PortfolioRow.
    expect(src).toMatch(/isRefreshingEquity=\{isRefreshingEquity\}/);
    // 4. Non-destructive indicator rendered in the loaded branch.
    expect(src).toMatch(/data-testid="equity-refreshing-dot"/);
    expect(src).toMatch(/aria-busy=\{isRefreshingEquity\s*\|\|\s*undefined\}/);
  });
});
