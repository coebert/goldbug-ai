// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { SectionIndex } from "@/components/nav/section-index";

/**
 * Regression: pinned nav heights must be viewport-independent, so a rotate
 * cannot change them. Every sticky bar declares a fixed token height
 * (--subnav-h) and offsets off --app-header-h; none may size from content or
 * from a viewport unit (vh/svh/dvh), which change on rotate and would move
 * every offset below them.
 */
describe("sticky nav geometry is rotation-stable", () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  function mountTargets(ids: string[]) {
    for (const id of ids) {
      const el = document.createElement("div");
      el.id = id;
      document.body.appendChild(el);
    }
  }

  it("sizes the section index from the fixed sub-nav token, not the viewport", () => {
    mountTargets(["alpha", "beta"]);
    const { container } = render(
      <SectionIndex
        items={[
          { id: "alpha", label: "Alpha" },
          { id: "beta", label: "Beta" },
        ]}
      />,
    );
    const nav = container.querySelector("nav")!;
    expect(nav.className).toContain("h-[var(--subnav-h,3.25rem)]");
    expect(nav.className).not.toMatch(/h-\[[^\]]*(vh|svh|dvh)\]/);
    // Offsets follow the header variable, which is republished on rotate.
    expect(nav.style.top).toBe("var(--app-header-h)");
    // data-sticky-nav carries the global `overflow-anchor: none` rule, which
    // keeps the browser from "correcting" scroll position when the bar
    // re-lays-out after a rotate.
    expect(nav.getAttribute("data-sticky-nav")).not.toBeNull();

  });

  it("keeps chips at a fixed 44px touch target in both orientations", () => {
    mountTargets(["alpha", "beta"]);
    const { container } = render(
      <SectionIndex
        items={[
          { id: "alpha", label: "Alpha" },
          { id: "beta", label: "Beta" },
        ]}
      />,
    );
    for (const chip of Array.from(container.querySelectorAll("a"))) {
      expect(chip.className).toMatch(/\bh-11\b/);
      expect(chip.className).not.toMatch(/\bmin-h-/);
    }
  });
});
