// Visual regression for the mobile home layout.
//
// The home page has repeatedly regressed on phones: the hero headline
// overflowing, the equity block refusing to stack, the practice
// section losing its tap target. jsdom can't measure pixels, so we
// lock the *layout contract* instead — the mobile-first Tailwind
// utilities that make each block behave at 320/375/414px — plus a full
// markup snapshot so any unreviewed structural change fails loudly.
//
// Breakpoint model (Tailwind defaults): base = phone (<640px),
// `sm:` = 640px+, `md:` = 768px+. A class with NO `sm:`/`md:` prefix is
// the phone behaviour; a prefixed class is the desktop override.

import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className, to }: { children: React.ReactNode; className?: string; to?: string }) => (
    <a href={to ?? "#"} className={className}>
      {children}
    </a>
  ),
}));

import { TodayHero } from "@/components/home/today-hero";
import { TodayHeroSkeleton } from "@/components/home/today-hero-skeleton";
import { AdvancedSection } from "@/components/advanced-section";
import type { ModeSummaryPair } from "@/lib/mode-summary";

// Frozen clock so the hero's "next AI run" countdown is deterministic.
//
// This MUST run at module scope, not in `beforeAll`: the `describe`
// bodies below render their markup during collection, which happens
// *before* any hook fires. Freezing in `beforeAll` left those renders
// on the wall clock, so the "in MM:SS" countdown differed on every run
// and the snapshot churned. 10:17:30 BST => next run 11:00 BST, 42:30.
vi.useFakeTimers();
vi.setSystemTime(new Date("2026-08-01T09:17:30Z"));

beforeAll(() => {
  vi.setSystemTime(new Date("2026-08-01T09:17:30Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

const html = (el: ReactElement) => renderToStaticMarkup(el);

const SUMMARY: ModeSummaryPair = {
  real: { now: 10_215.95, pnl: 84.2, pct: 0.83, count: 1 },
  sim: { now: 24_880.4, pnl: -312.5, pct: -1.24, count: 2 },
};

/** Widths we care about; used to document intent in test names. */
const PHONE_WIDTHS = [320, 375, 414] as const;

describe("home mobile layout — visual regression", () => {
  describe("TodayHero", () => {
    const markup = html(<TodayHero summary={SUMMARY} />);

    it("full markup snapshot", () => {
      expect(markup).toMatchSnapshot();
    });

    it.each(PHONE_WIDTHS)("stacks into a single column at %ipx (grid columns are sm:+ only)", () => {
      // The two-column split is `sm:grid-cols-[...]`; there must be no
      // unprefixed multi-column grid or phones get a squashed headline.
      expect(markup).toMatch(/class="[^"]*\bsm:grid-cols-\[minmax\(0,1fr\)_auto\]/);
      expect(markup).not.toMatch(/class="[^"]*(?<![:\w-])grid-cols-2\b/);
    });

    it("lets the headline figure wrap instead of overflowing narrow screens", () => {
      // `break-all` + `min-w-0` are what stopped £-figures blowing out
      // the 320px viewport.
      expect(markup).toMatch(/class="[^"]*\bbreak-all\b/);
      expect(markup).toMatch(/class="[^"]*\bmin-w-0\b/);
      // Smaller base type, larger only from sm:.
      expect(markup).toMatch(/text-\[1\.75rem\][^"]*sm:text-4xl/);
    });

    it("gives the next-run pill full width and roomy vertical padding on phones", () => {
      expect(markup).toMatch(/class="[^"]*\bw-full\b[^"]*\bpy-2\.5\b[^"]*\bsm:w-auto\b/);
    });

    it("stacks the two mode tiles vertically on phones", () => {
      expect(markup).toMatch(/class="[^"]*\bgrid\b[^"]*\bsm:grid-cols-2\b/);
    });

    it("uses tighter phone padding that expands at sm:", () => {
      expect(markup).toMatch(/\bpx-4\b[^"]*\bsm:px-6\b/);
    });
  });

  describe("TodayHeroSkeleton", () => {
    const markup = html(<TodayHeroSkeleton />);

    it("full markup snapshot", () => {
      expect(markup).toMatchSnapshot();
    });

    it("announces itself as busy so screen readers don't read stale values", () => {
      expect(markup).toMatch(/role="status"/);
      expect(markup).toMatch(/aria-busy="true"/);
    });

    it("mirrors the real hero's mobile stacking so nothing jumps when data lands", () => {
      const hero = html(<TodayHero summary={SUMMARY} />);
      for (const cls of ["sm:grid-cols-[minmax(0,1fr)_auto]", "sm:grid-cols-2", "px-4", "sm:px-6"]) {
        expect(markup).toContain(cls);
        expect(hero).toContain(cls);
      }
    });
  });

  describe("AdvancedSection (practice portfolios)", () => {
    const markup = html(
      <AdvancedSection title="Practice portfolios" summary="Pretend cash, real prices">
        <div>hidden child</div>
      </AdvancedSection>,
    );

    it("full markup snapshot (collapsed)", () => {
      expect(markup).toMatchSnapshot();
    });

    it("keeps children unmounted while collapsed (no wasted mobile requests)", () => {
      expect(markup).not.toContain("hidden child");
      expect(markup).toMatch(/aria-expanded="false"/);
    });

    it("keeps a >=44px tap row at every phone width", () => {
      // min-h-14 = 3.5rem = 56px, comfortably above the 44px target.
      expect(markup).toMatch(/class="[^"]*\bmin-h-14\b/);
      expect(markup).toMatch(/class="[^"]*\bw-full\b/);
    });

    it("uses tighter phone padding on the toggle row", () => {
      expect(markup).toMatch(/\bpx-3\b[^"]*\bsm:px-4\b/);
    });

    it("shows an explicit expand affordance, not just a chevron", () => {
      expect(markup).toMatch(/>Show</);
    });
  });
});
