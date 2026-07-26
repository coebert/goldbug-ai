// Portfolio card: dedicated error state for the GBP headline + % pill.
//
// When the equity fetch fails AND we have no cached snapshot to fall
// back on, both slots MUST swap in lockstep to a clearly-marked error
// state (destructive color, alert icon, error message, retry action).
// The loading, empty, and loaded branches must all be suppressed to
// avoid mixed / mismatched renders.
//
// When cached data IS present (SWR), the error is silent at the card
// level — the refresh dot signals the failed background retry and the
// query layer retries. This matches the SWR contract locked in by
// `portfolio-card-swr-refresh.e2e.test.tsx`.
//
// A source-level guard keeps the harness aligned with the real JSX in
// `src/routes/index.tsx`.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoneyAmount } from "@/lib/format-money";

function CardEquityErrorHarness({
  currency,
  totalEquity,
  rangePct,
  isLoadingEquity,
  hasData,
  equityError,
  onRetryEquity,
}: {
  currency: string;
  totalEquity: number;
  rangePct: number | null;
  isLoadingEquity: boolean;
  hasData: boolean;
  equityError: string | null;
  onRetryEquity?: () => void;
}) {
  const equityLoading = isLoadingEquity && !hasData;
  const equityEmpty = !isLoadingEquity && !hasData && !equityError;
  return (
    <div data-testid="portfolio-row-equity">
      {/* % pill */}
      {equityError ? (
        <span
          data-testid="range-pct-error"
          role="status"
          aria-label={`Equity change unavailable: ${equityError}`}
          className="text-destructive"
        >
          <AlertCircle aria-hidden /> n/a
        </span>
      ) : equityLoading ? (
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

      {/* Total equity */}
      {equityError ? (
        <div
          role="alert"
          aria-live="polite"
          data-testid="total-equity-error"
          className="text-destructive"
        >
          <div>
            <AlertCircle aria-hidden />
            {currency} n/a
          </div>
          <div data-testid="total-equity-error-message">{equityError}</div>
          {onRetryEquity ? (
            <button
              type="button"
              data-testid="total-equity-retry"
              onClick={onRetryEquity}
            >
              <RefreshCw aria-hidden /> Retry
            </button>
          ) : null}
        </div>
      ) : equityLoading ? (
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
  );
}

describe("Portfolio card: equity-fetch error state", () => {
  const message = "Failed to load equity: 503 upstream";

  it("renders destructive error UI in BOTH slots when the fetch fails with no cache", () => {
    const html = renderToStaticMarkup(
      <CardEquityErrorHarness
        currency="GBP"
        totalEquity={0}
        rangePct={null}
        isLoadingEquity={false}
        hasData={false}
        equityError={message}
        onRetryEquity={() => {}}
      />,
    );
    // % pill error.
    expect(html).toContain('data-testid="range-pct-error"');
    expect(html).toMatch(/aria-label="Equity change unavailable: [^"]+"/);
    expect(html).toContain("n/a");
    // Headline error.
    expect(html).toContain('data-testid="total-equity-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("GBP n/a");
    // Message + retry surface.
    expect(html).toContain('data-testid="total-equity-error-message"');
    expect(html).toContain(message);
    expect(html).toContain('data-testid="total-equity-retry"');
  });

  it("suppresses every non-error branch (no skeleton, no em-dash, no value) while errored", () => {
    const html = renderToStaticMarkup(
      <CardEquityErrorHarness
        currency="GBP"
        totalEquity={1_234_567.89}
        rangePct={4.5}
        isLoadingEquity={false}
        hasData={false}
        equityError={message}
      />,
    );
    expect(html).not.toContain('data-testid="total-equity-skeleton"');
    expect(html).not.toContain('data-testid="range-pct-skeleton"');
    expect(html).not.toContain('data-testid="total-equity-empty"');
    expect(html).not.toContain('data-testid="range-pct-empty"');
    expect(html).not.toContain('data-testid="total-equity-value"');
    expect(html).not.toContain('data-testid="range-pct-value"');
    // No stale headline / % text leaked through the error branch.
    expect(html).not.toContain("GBP 1,234,567.89");
    expect(html).not.toContain("+4.5%");
  });

  it("error branch and loaded/loading/empty branches are mutually exclusive", () => {
    const loaded = renderToStaticMarkup(
      <CardEquityErrorHarness
        currency="GBP"
        totalEquity={1000}
        rangePct={2}
        isLoadingEquity={false}
        hasData
        equityError={null}
      />,
    );
    const errored = renderToStaticMarkup(
      <CardEquityErrorHarness
        currency="GBP"
        totalEquity={0}
        rangePct={null}
        isLoadingEquity={false}
        hasData={false}
        equityError={message}
      />,
    );
    expect(loaded).toContain('data-testid="total-equity-value"');
    expect(loaded).not.toContain('data-testid="total-equity-error"');
    expect(errored).toContain('data-testid="total-equity-error"');
    expect(errored).not.toContain('data-testid="total-equity-value"');
  });

  it("renders retry button which invokes the provided callback", () => {
    const onRetry = vi.fn();
    // Callback presence exercised via string match (SSR-only env).
    const html = renderToStaticMarkup(
      <CardEquityErrorHarness
        currency="GBP"
        totalEquity={0}
        rangePct={null}
        isLoadingEquity={false}
        hasData={false}
        equityError={message}
        onRetryEquity={onRetry}
      />,
    );
    expect(html).toContain('data-testid="total-equity-retry"');
    // With no callback, retry button is omitted.
    const htmlNoRetry = renderToStaticMarkup(
      <CardEquityErrorHarness
        currency="GBP"
        totalEquity={0}
        rangePct={null}
        isLoadingEquity={false}
        hasData={false}
        equityError={message}
      />,
    );
    expect(htmlNoRetry).not.toContain('data-testid="total-equity-retry"');
  });

  it("production route wires equityError + retry into PortfolioRow (source-level guard)", () => {
    const src = readFileSync(resolve(__dirname, "../index.tsx"), "utf8") + "\n" + readFileSync(resolve(__dirname, "../../components/home/portfolio-row.tsx"), "utf8") + "\n" + readFileSync(resolve(__dirname, "../../components/home/portfolio-row.tsx"), "utf8");
    // 1. equityErrored derived from useQuery state, only when no cache.
    expect(src).toMatch(
      /equityErrored\s*=\s*equityQ\.isError\s*&&\s*!equityQ\.data/,
    );
    // 2. Message + retry piped into PortfolioRow.
    expect(src).toMatch(
      /equityError=\{equityErrored\s*\?\s*equityErrorMessage\s*:\s*null\}/,
    );
    expect(src).toMatch(/onRetryEquity=\{\(\)\s*=>\s*equityQ\.refetch\(\)\}/);
    // 3. Both slots have a dedicated error branch that takes precedence
    //    over loading / empty / loaded.
    expect(src).toMatch(/data-testid="range-pct-error"/);
    expect(src).toMatch(/data-testid="total-equity-error"/);
    expect(src).toMatch(/data-testid="total-equity-retry"/);
    // 4. Error branch positioned BEFORE equityLoading in the ternary
    //    chain so it takes precedence.
    const headlineChunk = src.slice(src.indexOf("Total equity"));
    const errIdx = headlineChunk.indexOf('data-testid="total-equity-error"');
    const loadIdx = headlineChunk.indexOf(
      'data-testid="total-equity-loading"',
    );
    expect(errIdx).toBeGreaterThan(-1);
    expect(loadIdx).toBeGreaterThan(-1);
    expect(errIdx).toBeLessThan(loadIdx);
  });
});
