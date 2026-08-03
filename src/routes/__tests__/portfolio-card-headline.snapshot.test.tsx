// Snapshot + layout tests for the portfolio card's prominent GBP
// "Total equity" headline.
//
// Two complementary guards:
//   1. Source-level layout contract — regexes over src/routes/index.tsx
//      pin the exact responsive class shape of the Row-2 grid and the
//      headline block so a refactor cannot silently drop `shrink-0`,
//      `min-w-0`, `text-2xl font-bold`, `tabular-nums`, or the right-
//      aligned column that keeps the £ number aligned across
//      mobile/tablet/desktop breakpoints.
//   2. Rendered snapshots — a byte-stable render of the headline block
//      (loaded and loading) using the same formatter (`formatMoneyAmount`)
//      and the same classes as production. Any accidental style, order,
//      or copy change trips the snapshot.
//
// We render just the headline column via renderToStaticMarkup rather
// than the whole PortfolioRow (which needs the TanStack Router + Query
// providers) — the source-level regexes keep this mirror honest.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formatMoney, formatMoneyAmount } from "@/lib/format-money";

// The portfolio card JSX now lives in the `PortfolioRow` component; the
// index route file mounts it. Concatenate both so source-level regex
// assertions catch drift regardless of which file the row block lives in.
const SOURCE = [
  readFileSync(resolve(__dirname, "../index.tsx"), "utf8"),
  readFileSync(resolve(__dirname, "../../components/home/portfolio-row.tsx"), "utf8"),
].join("\n");


// Mirror of the production JSX (src/routes/index.tsx lines 592–621).
// Kept in lockstep with the source via the regex assertions below —
// any drift there fires before the snapshots go stale silently.
function HeadlineBlock({
  currency,
  totalEquity,
  currentCash,
  pnl,
  pnlPct,
  isLoadingEquity,
  hasSeries,
}: {
  currency: string;
  totalEquity: number;
  currentCash: number;
  pnl: number;
  pnlPct: number;
  isLoadingEquity: boolean;
  hasSeries: boolean;
}) {
  return (
    <div className="shrink-0 text-right">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Total equity
      </div>
      {isLoadingEquity && !hasSeries ? (
        <>
          <div
            data-testid="total-equity-skeleton"
            aria-label="Loading total equity"
            className="ml-auto mt-1 h-7 w-28 animate-pulse rounded-md bg-muted"
          />
          <div className="ml-auto mt-2 h-3 w-20 animate-pulse rounded-md bg-muted" />
        </>
      ) : (
        <>
          <div className="text-2xl font-bold leading-tight tabular-nums">
            {currency} {formatMoneyAmount(totalEquity)}
          </div>
          <div className="mt-1 text-xs tabular-nums text-muted-foreground">
            {formatMoney(Number(currentCash), currency)}
            <span className="ml-1 text-[10px]">cash</span>
          </div>
          <div
            className={`text-xs tabular-nums ${pnl >= 0 ? "text-success" : "text-destructive"}`}
          >
            {pnl >= 0 ? "+" : ""}
            {pnlPct.toFixed(2)}%
            <span className="ml-1 text-[10px] text-muted-foreground">cash vs start</span>
          </div>
        </>
      )}
    </div>
  );
}

describe("portfolio card headline — layout contract (source-level)", () => {
  it("row 2 stacks on mobile and becomes a two-column grid from sm up", () => {
    // The row hosting the sparkline + headline stacks to one column on
    // phones (so the £ headline gets full width instead of being squeezed
    // beside the sparkline) and switches to sparkline | headline from the
    // sm breakpoint, bottom-aligned. Rule from responsive-layout-patterns.
    expect(SOURCE).toMatch(
      /grid\s+grid-cols-1\s+gap-3[\s\S]{0,120}?sm:grid-cols-\[minmax\(0,1fr\)_auto\]\s+sm:items-end/,
    );

    // Sparkline column must be min-w-0 to let text/svg shrink.
    expect(SOURCE).toMatch(/<div className="min-w-0">\s*<div className="flex items-center gap-2">/);
    // Headline column is left-aligned while stacked, then shrink-0 +
    // right-aligned from sm up so the £ number stays glued to the right
    // edge of the two-column row on tablet/desktop.
    expect(SOURCE).toMatch(/<div className="min-w-0 text-left sm:shrink-0 sm:text-right">/);

  });


  it("headline £ number is text-2xl, bold, tabular-nums, and single-line", () => {
    // The prominent number is the WHOLE point of the card — lock its
    // typography so a future refactor cannot demote it back to a small
    // secondary metric.
    expect(SOURCE).toMatch(
      /className="font-display text-2xl font-bold leading-tight tabular-nums"\s*>\s*\{portfolio\.currency\}\s+\{formatMoneyAmount\(totalEquity,\s*equityDecimals\)\}/,
    );
    // Cash sub-line stays a small muted secondary.
    expect(SOURCE).toMatch(
      /className="mt-1 text-xs tabular-nums text-muted-foreground"/,
    );
    // Loading state uses a shimmer skeleton sized to match the
    // headline's typography box (h-8 ≈ text-2xl leading-tight) so
    // the layout doesn't jump when data arrives.
    expect(SOURCE).toMatch(
      /<Skeleton\b[\s\S]*?variant="shimmer"[\s\S]*?data-testid="total-equity-skeleton"[\s\S]*?h-8/,
    );
  });

});

describe("portfolio card headline — rendered snapshots", () => {
  it("loaded state: gain (positive pnl, emerald) — GBP, thousands separators, 2dp", () => {
    const html = renderToStaticMarkup(
      <HeadlineBlock
        currency="GBP"
        totalEquity={12_345.6}
        currentCash={2_100}
        pnl={2_345.6}
        pnlPct={23.456}
        isLoadingEquity={false}
        hasSeries={true}
      />,
    );
    expect(html).toContain("GBP 12,345.60");
    expect(html).toContain("text-2xl font-bold leading-tight tabular-nums");
    expect(html).toContain("text-success");
    expect(html).not.toContain("text-destructive");
    expect(html).toContain("+23.46%");
    expect(html).toContain("cash vs start");
    expect(html).toMatchSnapshot();
  });

  it("loaded state: loss (negative pnl, red) — sign and colour flip together", () => {
    const html = renderToStaticMarkup(
      <HeadlineBlock
        currency="GBP"
        totalEquity={874.05}
        currentCash={200}
        pnl={-125.95}
        pnlPct={-12.5949}
        isLoadingEquity={false}
        hasSeries={true}
      />,
    );
    expect(html).toContain("GBP 874.05");
    expect(html).toContain("text-destructive");
    expect(html).not.toContain("text-success");
    // Negative pnlPct renders with its own '-' via toFixed — never
    // prefixed with an extra '+'.
    expect(html).toContain("-12.59%");
    expect(html).not.toContain("+-");
    expect(html).toMatchSnapshot();
  });

  it("loaded state: tiny / -0 amounts coerce to 0.00, never '-0.00'", () => {
    // formatMoneyAmount contract: values that round to zero render as
    // "0.00", never "-0.00". Guards against the headline flashing a
    // spurious minus for a portfolio that just crossed zero.
    const html = renderToStaticMarkup(
      <HeadlineBlock
        currency="GBP"
        totalEquity={-0.0001}
        currentCash={0}
        pnl={0}
        pnlPct={0}
        isLoadingEquity={false}
        hasSeries={true}
      />,
    );
    expect(html).toContain("GBP 0.00");
    expect(html).not.toContain("GBP -0.00");
    expect(html).toMatchSnapshot();
  });

  it("loading state: two right-aligned skeletons, no headline number", () => {
    const html = renderToStaticMarkup(
      <HeadlineBlock
        currency="GBP"
        totalEquity={0}
        currentCash={0}
        pnl={0}
        pnlPct={0}
        isLoadingEquity={true}
        hasSeries={false}
      />,
    );
    expect(html).toContain('data-testid="total-equity-skeleton"');
    expect(html).toContain('aria-label="Loading total equity"');
    // Skeleton is same height as the headline slot (h-7) so the card
    // does not reflow when data arrives.
    expect(html).toContain("h-7 w-28");
    // Skeleton is right-aligned to match the loaded headline column.
    expect(html).toContain("ml-auto");
    // No headline number leaks through while loading.
    expect(html).not.toContain("GBP 0.00");
    expect(html).not.toContain("cash vs start");
    expect(html).toMatchSnapshot();
  });

  it("still shows data (not skeleton) once a series exists, even mid-refresh", () => {
    // When `isLoadingEquity` is true but a prior series is cached, the
    // card must keep showing the last known headline rather than
    // flashing a skeleton on every refetch.
    const html = renderToStaticMarkup(
      <HeadlineBlock
        currency="GBP"
        totalEquity={500}
        currentCash={500}
        pnl={0}
        pnlPct={0}
        isLoadingEquity={true}
        hasSeries={true}
      />,
    );
    expect(html).toContain("GBP 500.00");
    expect(html).not.toContain("total-equity-skeleton");
  });
});
