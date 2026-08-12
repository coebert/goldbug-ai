// Visual regression for the mobile bottom tab bar.
//
// Locks the markup + the critical layout contract that keeps the pill
// anchored to the viewport-relative bottom safe-area:
//   - the <nav> is `position: fixed`, pinned to `inset-x-0 bottom-0`
//   - its safe-area offset lives in a *capped* padding-bottom (floor
//     0.5rem, ceiling 1.25rem) so an inflated
//     `env(safe-area-inset-bottom)` cannot push the pill toward the
//     middle of the screen (previously reported regression).
//   - `md:hidden` keeps it out of tablet/desktop layouts.
//
// The rendered markup is viewport-independent (no matchMedia branches
// in the component itself — Tailwind handles the breakpoint via CSS),
// so we snapshot once per route context. If anyone later swaps
// `bottom-0` for a `bottom-*` utility, drops the padding cap, or
// removes `md:hidden`, both the full-markup snapshot AND the
// contract assertions below fail — forcing a deliberate review.

import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Mock the router primitives the tab bar reads from. `useRouterState`
// with a selector receives the full state; return a shape that lets
// the selector pick a pathname. `Link` renders a plain <a> so the
// serialized HTML stays stable across router upgrades.
vi.mock("@tanstack/react-router", () => ({
  // `usePrefetchOnTouch` (via use-idle-prefetch) calls `useRouter()`; the tab
  // bar only ever invokes `preloadRoute` from touch handlers, which never fire
  // during static SSR rendering — a no-op stub is enough.
  useRouter: () => ({
    preloadRoute: () => Promise.resolve(),
    buildLocation: () => ({ href: "/" }),
  }),
  useRouterState: (opts: { select: (s: { location: { pathname: string } }) => unknown }) =>
    opts.select({ location: { pathname: (globalThis as { __PATH__?: string }).__PATH__ ?? "/" } }),
  Link: ({
    to,
    hash,
    children,
    className,
    ...rest
  }: {
    to?: string;
    hash?: string;
    children: React.ReactNode;
    className?: string;
    [k: string]: unknown;
  }) => {
    const href = `${to ?? ""}${hash ? `#${hash}` : ""}`;
    // Strip router-only props that would otherwise leak into the DOM.
    delete (rest as Record<string, unknown>).activeOptions;
    return (
      <a href={href} className={className} {...(rest as Record<string, unknown>)}>
        {children}
      </a>
    );
  },
}));

import { MobileTabBar } from "@/components/mobile-tab-bar";

// ---------------------------------------------------------------------------
// Determinism guards.
//
// A visual snapshot must be identical whether this file runs alone or inside
// the full parallel suite. Two classes of input could break that:
//   * wall-clock time (a "Xs ago"-style label, a date, an animation delay);
//   * viewport-dependent branching (matchMedia / window.innerWidth), which
//     differs between the jsdom-less `ci` project and a DOM environment.
// The component uses neither today — Tailwind's `md:hidden` handles the
// breakpoint in CSS, not JS — so we freeze the clock and install a matchMedia
// spy that FAILS the run if anything in the tree starts querying it.
// ---------------------------------------------------------------------------
const FROZEN_NOW = new Date("2026-07-30T14:00:00Z");
const matchMediaCalls: string[] = [];

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(FROZEN_NOW);
  (globalThis as { window?: unknown }).window ??= globalThis;
  (globalThis as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => {
    matchMediaCalls.push(q);
    return {
      matches: false,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
  };
});
afterAll(() => {
  vi.useRealTimers();
});

function renderAt(pathname: string): string {
  (globalThis as { __PATH__?: string }).__PATH__ = pathname;
  vi.setSystemTime(FROZEN_NOW);
  return renderToStaticMarkup(<MobileTabBar />);
}

// Representative routes: root, a leaf, and a hidden-prefix route.
const ROUTES = ["/", "/trades", "/learn", "/compare", "/auth/sign-in"] as const;


describe("mobile tab bar — visual regression", () => {
  for (const path of ROUTES) {
    it(`full markup snapshot @ ${path}`, () => {
      expect(renderAt(path)).toMatchSnapshot();
    });
  }

  // Contract assertions — these encode the invariants the recent
  // "nav drifts to the middle of the screen" bug fix depends on.
  // Snapshotting alone would catch a diff, but explicit asserts give
  // future maintainers a readable failure message.
  it("hides on /auth routes", () => {
    expect(renderAt("/auth/sign-in")).toBe("");
  });

  describe.each(ROUTES.filter((p) => !p.startsWith("/auth")))(
    "layout contract @ %s",
    (path) => {
      const html = renderAt(path);

      it("renders a fixed nav pinned to the bottom edge", () => {
        expect(html).toMatch(/<nav[^>]*aria-label="Primary"/);
        // `fixed inset-x-0 bottom-0` — the three utilities that anchor
        // the bar to the true viewport bottom on every orientation.
        expect(html).toMatch(/class="[^"]*\bfixed\b[^"]*"/);
        expect(html).toMatch(/class="[^"]*\binset-x-0\b[^"]*"/);
        expect(html).toMatch(/class="[^"]*\bbottom-0\b[^"]*"/);
      });

      it("stays hidden at md+ breakpoints", () => {
        expect(html).toMatch(/class="[^"]*\bmd:hidden\b[^"]*"/);
      });

      it("uses a capped safe-area padding-bottom (floor 0.5rem, ceiling 1.25rem)", () => {
        // React serializes the inline style as `padding-bottom:...`.
        // The cap prevents an inflated env() from ballooning the nav
        // and pushing the pill toward the middle of the screen.
        expect(html).toMatch(
          /padding-bottom:\s*max\(\s*0\.5rem\s*,\s*min\(\s*env\(safe-area-inset-bottom\)\s*,\s*1\.25rem\s*\)\s*\)/,
        );
      });

      it("renders the five primary tabs plus a More button", () => {
        // Home / Markets / Research / Trades / Broker status + More.
        for (const label of ["Home", "Markets", "Research", "Trades", "Broker status"]) {
          expect(html).toContain(`>${label}</span>`);
        }
        expect(html).toMatch(/>More<\/span>/);
        // The raised "+" is gone: creating a portfolio is a rare action
        // and no longer earns a prime tap target.
        expect(html).not.toMatch(/aria-label="New portfolio"/);
      });

      it("opens the destination sheet from More instead of navigating", () => {
        expect(html).toMatch(/aria-label="More destinations"[^>]*aria-haspopup="dialog"/);
        expect(html).not.toMatch(/href="\/compare"[^>]*aria-label="More destinations"/);
      });
    },
  );

  // -------------------------------------------------------------------
  // Determinism: the snapshot must not depend on when or where it runs.
  // -------------------------------------------------------------------
  describe("deterministic rendering", () => {
    it("produces byte-identical markup across repeated renders", () => {
      for (const path of ROUTES) {
        expect(renderAt(path), `unstable markup @ ${path}`).toBe(renderAt(path));
      }
    });

    it("is unaffected by the wall clock advancing", () => {
      const before = renderAt("/");
      vi.setSystemTime(new Date("2027-01-01T03:17:42Z"));
      const after = renderToStaticMarkup(<MobileTabBar />);
      vi.setSystemTime(FROZEN_NOW);
      expect(after).toBe(before);
    });

    it("never branches on matchMedia / viewport width", () => {
      matchMediaCalls.length = 0;
      for (const path of ROUTES) renderAt(path);
      // Breakpoint behaviour belongs in CSS (`md:hidden`). A JS media query
      // here would make the snapshot environment-dependent.
      expect(matchMediaCalls).toEqual([]);
    });

    it("emits no time-, random- or id-shaped values in the markup", () => {
      const html = renderAt("/");
      expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // ISO timestamps
      expect(html).not.toMatch(/\bago\b/); // relative-time labels
      expect(html).not.toMatch(/\bdata-reactid|:r[0-9a-z]+:/); // React useId output
    });
  });

});
