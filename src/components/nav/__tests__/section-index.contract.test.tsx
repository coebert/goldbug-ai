// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SectionIndex } from "@/components/nav/section-index";

/**
 * The section index is only useful if it points at sections that exist —
 * a chip whose target id is missing would scroll nowhere.
 */
describe("SectionIndex", () => {
  const items = [
    { id: "alpha", label: "Alpha" },
    { id: "beta", label: "Beta" },
    { id: "ghost", label: "Ghost" },
  ] as const;

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

  it("renders one chip per present target and drops missing ones", () => {
    mountTargets(["alpha", "beta"]);
    render(<SectionIndex items={items} />);
    expect(screen.getByRole("link", { name: "Alpha" }).getAttribute("href")).toBe("#alpha");
    expect(screen.getByRole("link", { name: "Beta" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Ghost" })).toBeNull();
  });

  it("hides itself when fewer than two sections exist", () => {
    mountTargets(["alpha"]);
    render(<SectionIndex items={items} />);
    expect(screen.queryByRole("navigation", { name: /sections on this page/i })).toBeNull();
  });

  it("marks exactly one section active on initial render", () => {
    mountTargets(["alpha", "beta"]);
    render(<SectionIndex items={items} />);
    const active = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("aria-current") === "true");
    expect(active).toHaveLength(1);
  });

  it("keeps every chip a 44px touch target", () => {
    mountTargets(["alpha", "beta"]);
    render(<SectionIndex items={items} />);
    for (const chip of screen.getAllByRole("link")) {
      // Fixed h-11 rather than min-h-11: the bar's height must not depend on
      // its contents, or sticky offsets below it move mid-scroll.
      expect(chip.className).toMatch(/\bh-11\b/);
    }
  });

  it("pins the bar to the shared sub-nav height and opts out of scroll anchoring", () => {
    mountTargets(["alpha", "beta"]);
    const { container } = render(<SectionIndex items={items} />);
    const nav = container.querySelector("nav")!;
    expect(nav.className).toContain("h-[var(--subnav-h,3.25rem)]");
    expect(nav.getAttribute("data-sticky-nav")).not.toBeNull();
    expect(nav.style.top).toBe("var(--app-header-h)");
  });

});
