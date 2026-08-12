import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
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
    expect(screen.getByRole("link", { name: "Alpha" })).toHaveAttribute("href", "#alpha");
    expect(screen.getByRole("link", { name: "Beta" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Ghost" })).toBeNull();
  });

  it("hides itself when fewer than two sections exist", () => {
    mountTargets(["alpha"]);
    render(<SectionIndex items={items} />);
    expect(screen.queryByRole("navigation", { name: /sections on this page/i })).toBeNull();
  });

  it("marks the first section active on initial render", () => {
    mountTargets(["alpha", "beta"]);
    render(<SectionIndex items={items} />);
    expect(screen.getByRole("link", { name: "Alpha" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("link", { name: "Beta" })).not.toHaveAttribute("aria-current");
  });

  it("keeps every chip a 44px touch target", () => {
    mountTargets(["alpha", "beta"]);
    render(<SectionIndex items={items} />);
    for (const chip of screen.getAllByRole("link")) {
      expect(chip.className).toContain("min-h-11");
    }
  });
});
