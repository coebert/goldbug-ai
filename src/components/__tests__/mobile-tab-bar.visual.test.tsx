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

import { describe, expect, it, vi } from "vitest";
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

function renderAt(pathname: string): string {
  (globalThis as { __PATH__?: string }).__PATH__ = pathname;
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

      it("renders all four tabs plus the raised primary action", () => {
        // Home / Trades / Learn / More + New portfolio.
        expect(html).toMatch(/>Home<\/span>/);
        expect(html).toMatch(/>Trades<\/span>/);
        expect(html).toMatch(/>Learn<\/span>/);
        expect(html).toMatch(/>More<\/span>/);
        expect(html).toMatch(/aria-label="New portfolio"/);
      });
    },
  );
});
