import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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
  it("SectionCardHeader renders title, description, and trailing action", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SectionCard>
          <SectionCardHeader
            title="Portfolio equity"
            description="Combined equity across every portfolio."
            action={<button type="button">Refresh</button>}
          />
          <SectionCardBody>body-content</SectionCardBody>
          <SectionCardFooter>foot-content</SectionCardFooter>
        </SectionCard>
      </TooltipProvider>,
    );
    expect(html).toContain("Portfolio equity");
    expect(html).toContain("Combined equity across every portfolio.");
    expect(html).toContain("Refresh");
    expect(html).toContain("body-content");
    expect(html).toContain("foot-content");
    // Uses the design-system surface tier instead of raw --card.
    expect(html).toContain("bg-surface-2");
  });

  it("EmptyState carries role=status and shows title + description", () => {
    const html = renderToStaticMarkup(
      <EmptyState title="Nothing yet" description="Come back later." />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Nothing yet");
    expect(html).toContain("Come back later.");
  });

  it("ErrorState carries role=alert and renders a retry button", () => {
    const html = renderToStaticMarkup(
      <ErrorState description="boom" onRetry={() => {}} />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Couldn&#x27;t load this section");
    expect(html).toContain("boom");
    expect(html).toMatch(/<button[^>]*>[\s\S]*Retry[\s\S]*<\/button>/);
  });

  it("Chart/List/TileGrid skeletons mark aria-busy for a11y announcements", () => {
    const chart = renderToStaticMarkup(<ChartSkeleton height="200px" />);
    const list = renderToStaticMarkup(<ListSkeleton rows={3} />);
    const tiles = renderToStaticMarkup(<TileGridSkeleton tiles={4} />);
    for (const html of [chart, list, tiles]) {
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain("skeleton-shimmer");
    }
  });
});
