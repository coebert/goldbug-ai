import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Skeleton } from "@/components/ui/skeleton";

const routeSrc = readFileSync(
  resolve(__dirname, "../../components/home/portfolio-row.tsx"),
  "utf8",
);
const cssSrc = readFileSync(
  resolve(__dirname, "../../styles.css"),
  "utf8",
);

describe("Skeleton shimmer + headline typography contract", () => {
  it("Skeleton renders `skeleton-shimmer` utility when variant='shimmer'", () => {
    const html = renderToStaticMarkup(<Skeleton variant="shimmer" />);
    expect(html).toContain("skeleton-shimmer");
    expect(html).toContain('data-variant="shimmer"');
  });

  it("Skeleton default remains legacy pulse (no shimmer regression on other call-sites)", () => {
    const html = renderToStaticMarkup(<Skeleton />);
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("skeleton-shimmer");
  });

  it("styles.css defines the shimmer keyframe + utility + reduced-motion guard", () => {
    expect(cssSrc).toMatch(/@keyframes\s+skeleton-shimmer/);
    expect(cssSrc).toMatch(/@utility\s+skeleton-shimmer/);
    expect(cssSrc).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it("total-equity loading uses shimmer skeletons sized to match the headline box", () => {
    // Extract the equityLoading branch and verify the shimmer classes /
    // heights that mirror the final render's typography.
    const branch = routeSrc.match(
      /data-testid="total-equity-loading"[\s\S]*?<\/div>\s*\)\s*:\s*equityEmpty/,
    );
    expect(branch, "total-equity loading branch must exist").toBeTruthy();
    const block = branch![0];
    // Headline skeleton: h-8 (matches text-2xl leading-tight ≈ 1.875rem).
    expect(block).toMatch(/data-testid="total-equity-skeleton"[\s\S]*?h-8/);
    // Three shimmer variants (headline + cash + pnl) so the loading
    // stack has the same line-count as the loaded render.
    const shimmerCount = (block.match(/variant="shimmer"/g) ?? []).length;
    expect(shimmerCount).toBe(3);
    // Headline skeleton: h-8 (matches text-2xl leading-tight ≈ 1.875rem).
    expect(block).toMatch(/data-testid="total-equity-skeleton"[\s\S]*?h-8/);
    // ARIA loading semantics live on the enclosing container.
    const container = routeSrc.match(
      /<div\b[^>]*data-testid="total-equity-loading"[^>]*>/,
    );
    expect(container).toBeTruthy();
    expect(container![0]).toMatch(/role="status"/);
    expect(container![0]).toMatch(/aria-busy="true"/);
  });

  it("range-pct skeleton uses shimmer + h-5 to match the pct pill's text-sm box", () => {
    const branch = routeSrc.match(
      /<Skeleton\b[\s\S]*?data-testid="range-pct-skeleton"[\s\S]*?\/>/,
    );
    expect(branch).toBeTruthy();
    expect(branch![0]).toMatch(/variant="shimmer"/);
    expect(branch![0]).toMatch(/h-5/);
  });
});
