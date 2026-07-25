import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";

import {
  SectionCard,
  SectionCardBody,
  SectionCardFooter,
  SectionCardHeader,
} from "@/components/ui/section-card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import {
  ChartSkeleton,
  ListSkeleton,
  TileGridSkeleton,
} from "@/components/ui/card-skeleton";

/**
 * Phase 4 — lock the primitive contracts so any future edit to the
 * shared card language surfaces immediately in CI.
 */

describe("SectionCard primitives", () => {
  it("renders header title + description + trailing action", () => {
    render(
      <TooltipProvider>
        <SectionCard>
          <SectionCardHeader
            title="Portfolio equity"
            description="Combined equity across every portfolio."
            action={<button type="button">Refresh</button>}
          />
          <SectionCardBody>body</SectionCardBody>
          <SectionCardFooter>foot</SectionCardFooter>
        </SectionCard>
      </TooltipProvider>,
    );
    expect(screen.getByText("Portfolio equity")).toBeTruthy();
    expect(
      screen.getByText("Combined equity across every portfolio."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
    expect(screen.getByText("foot")).toBeTruthy();
  });

  it("EmptyState carries role=status and shows title + description", () => {
    render(
      <EmptyState title="Nothing yet" description="Come back later." />,
    );
    const el = screen.getByRole("status");
    expect(el).toBeTruthy();
    expect(el.textContent).toContain("Nothing yet");
    expect(el.textContent).toContain("Come back later.");
  });

  it("ErrorState carries role=alert and wires up retry", () => {
    let clicks = 0;
    render(
      <ErrorState
        description="boom"
        onRetry={() => {
          clicks += 1;
        }}
      />,
    );
    const el = screen.getByRole("alert");
    expect(el.textContent).toContain("Couldn't load this section");
    expect(el.textContent).toContain("boom");
    const btn = screen.getByRole("button", { name: /retry/i });
    (btn as HTMLButtonElement).click();
    expect(clicks).toBe(1);
  });

  it("Chart/List/TileGrid skeletons all mark aria-busy for a11y announcements", () => {
    const { container: c1 } = render(<ChartSkeleton height="200px" />);
    const { container: c2 } = render(<ListSkeleton rows={3} />);
    const { container: c3 } = render(<TileGridSkeleton tiles={4} />);
    expect(c1.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(c2.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(c3.querySelector('[aria-busy="true"]')).toBeTruthy();
    // Skeletons render enough placeholders to preview the final shape.
    expect(c2.querySelectorAll(".skeleton-shimmer, .animate-pulse").length).toBeGreaterThanOrEqual(6); // 3 rows × ≥2
    expect(c3.querySelectorAll(".skeleton-shimmer, .animate-pulse").length).toBeGreaterThanOrEqual(8); // 4 tiles × 2
  });
});
