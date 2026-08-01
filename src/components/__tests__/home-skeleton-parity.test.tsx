import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PortfolioRowSkeleton, PortfolioListSkeleton } from "@/components/home/portfolio-row-skeleton";
import { MirrorAlertSkeleton } from "@/components/home/mirror-alert-skeleton";
import { TodayHeroSkeleton } from "@/components/home/today-hero-skeleton";

/**
 * Contract: every home placeholder reserves the SAME layout box as the
 * component it stands in for, so nothing shifts when the data lands.
 */
describe("home skeleton layout parity", () => {
  const hero = renderToStaticMarkup(<TodayHeroSkeleton />);
  const row = renderToStaticMarkup(<PortfolioRowSkeleton />);
  const mirror = renderToStaticMarkup(<MirrorAlertSkeleton />);

  it("hero skeleton keeps the hero shell classes", () => {
    expect(hero).toContain("mb-6");
    expect(hero).toContain("rounded-2xl");
    expect(hero).toContain("sm:grid-cols-[minmax(0,1fr)_auto]");
  });

  it("row skeleton mirrors the portfolio row grids", () => {
    // Header grid: content left, actions right.
    expect(row).toContain("grid-cols-[minmax(0,1fr)_auto]");
    // Equity grid: sparkline left, totals right-aligned from `sm`.
    expect(row).toContain("sm:grid-cols-[minmax(0,1fr)_auto]");
    expect(row).toContain("sm:items-end");
    // Same divider + spacing rhythm as the real row.
    expect(row).toContain("border-t border-border/60 pt-3");
    expect(row).toContain("p-4 sm:p-5");
  });

  it("row skeleton reserves the real control sizes", () => {
    expect(row).toContain("h-10 w-20"); // Open button
    expect(row).toContain("h-10 w-10"); // overflow menu
    expect(row).toContain("h-8 w-[120px]"); // sparkline (120x32)
    expect(row).toContain("h-8 w-40"); // total equity value
    expect(row.match(/h-\[28px\]/g)?.length).toBe(5); // five range buttons
  });

  it("mirror skeleton matches the banner slot", () => {
    expect(mirror).toContain("mb-4");
    expect(mirror).toContain('data-testid="mirror-alert-skeleton"');
  });

  it("all placeholders expose a busy status for screen readers", () => {
    for (const markup of [hero, row, mirror]) {
      expect(markup).toContain('role="status"');
      expect(markup).toContain('aria-busy="true"');
    }
  });

  it("list skeleton keeps the real list's vertical rhythm", () => {
    const list = renderToStaticMarkup(<PortfolioListSkeleton count={3} />);
    expect(list).toContain("space-y-3");
    expect(list.match(/data-testid="portfolio-row-skeleton"/g)?.length).toBe(3);
  });
});
