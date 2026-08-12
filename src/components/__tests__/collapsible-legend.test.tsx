import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import {
  CollapsibleLegend,
  LEGEND_COLLAPSE_THRESHOLD,
  LEGEND_COLLAPSED_CLASS,
} from "@/components/ui/collapsible-legend";

const items = ["A", "B", "C", "D", "E"].map((value, i) => ({
  value,
  color: `#00000${i}`,
}));

describe("CollapsibleLegend", () => {
  it("shows every series label", () => {
    render(<CollapsibleLegend payload={items} />);
    for (const item of items) expect(screen.getByText(item.value)).toBeTruthy();
  });

  it("clips to one row on phones when over the threshold", () => {
    const { container } = render(<CollapsibleLegend payload={items} />);
    const list = container.querySelector("div > div");
    expect(list?.className).toContain(LEGEND_COLLAPSED_CLASS.split(" ")[0]);
  });

  it("keeps short legends uncollapsed and control-free", () => {
    const { container } = render(
      <CollapsibleLegend payload={items.slice(0, LEGEND_COLLAPSE_THRESHOLD)} />,
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("expands and collapses via the control", () => {
    render(<CollapsibleLegend payload={items} />);
    const button = screen.getByRole("button");
    expect(button.textContent).toBe(`+${items.length - LEGEND_COLLAPSE_THRESHOLD}`);
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.textContent).toBe("Less");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("hides the control from sm up where the full legend fits", () => {
    render(<CollapsibleLegend payload={items} />);
    expect(screen.getByRole("button").className).toContain("sm:hidden");
  });
});
