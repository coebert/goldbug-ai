/**
 * Regression: the sticky section index used to yank the page back to the top
 * while scrolling on mobile.
 *
 * Two causes, both locked down here:
 *  1. Keeping the active chip visible used `chip.scrollIntoView()`, which also
 *     scrolls every scrollable ancestor — including the page.
 *  2. The MutationObserver re-set `present` on unrelated DOM churn, re-running
 *     the effect (and its scroll) on every render.
 */
import { render, act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SectionIndex } from "../nav/section-index";

const items = [
  { id: "sec-a", label: "A" },
  { id: "sec-b", label: "B" },
  { id: "sec-c", label: "C" },
];

function mountSections() {
  const host = document.createElement("div");
  for (const i of items) {
    const el = document.createElement("section");
    el.id = i.id;
    host.appendChild(el);
  }
  document.body.appendChild(host);
  return host;
}

/** Position sections as if the page were scrolled `y` px down. */
function positionAt(y: number) {
  const tops: Record<string, number> = { "sec-a": 0, "sec-b": 800, "sec-c": 1600 };
  for (const i of items) {
    const el = document.getElementById(i.id)!;
    el.getBoundingClientRect = () => ({ top: tops[i.id]! - y, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  }
}

let scrollIntoView: ReturnType<typeof vi.fn>;
let windowScrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollIntoView = vi.fn();
  windowScrollTo = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element["scrollIntoView"];
  window.scrollTo = windowScrollTo as unknown as Window["scrollTo"];
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("SectionIndex mobile scroll regression", () => {
  it("never scrolls the page or an ancestor while spying on scroll", () => {
    mountSections();
    positionAt(0);
    render(<SectionIndex items={items} />);

    for (const y of [100, 500, 900, 1400, 1900, 2400]) {
      positionAt(y);
      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });
    }

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(windowScrollTo).not.toHaveBeenCalled();
  });

  it("keeps the active chip visible via horizontal row scrolling only", () => {
    mountSections();
    positionAt(0);
    const { container } = render(<SectionIndex items={items} />);
    const row = container.querySelector<HTMLElement>("nav > div")!;

    // Narrow row: only ~100px of chips fit, chips laid out 120px apart.
    Object.defineProperty(row, "clientWidth", { value: 100, configurable: true });
    const chips = Array.from(row.querySelectorAll<HTMLElement>("[data-section]"));
    chips.forEach((chip, idx) => {
      Object.defineProperty(chip, "offsetLeft", { value: idx * 120, configurable: true });
      Object.defineProperty(chip, "offsetWidth", { value: 110, configurable: true });
    });

    positionAt(1700); // third section is active
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });

    expect(row.scrollLeft).toBeGreaterThan(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(windowScrollTo).not.toHaveBeenCalled();
  });

  it("ignores unrelated DOM mutations instead of re-running its scroll effect", async () => {
    const host = mountSections();
    positionAt(0);
    const { container } = render(<SectionIndex items={items} />);
    const row = container.querySelector<HTMLElement>("nav > div")!;
    const before = Array.from(row.querySelectorAll("[data-section]")).map((c) =>
      c.getAttribute("data-section"),
    );

    // Simulate a chart/list elsewhere on the page re-rendering repeatedly.
    for (let n = 0; n < 5; n += 1) {
      act(() => {
        const noise = document.createElement("div");
        noise.textContent = `noise-${n}`;
        host.appendChild(noise);
      });
      await act(async () => {
        await Promise.resolve();
      });
    }

    const after = Array.from(row.querySelectorAll("[data-section]")).map((c) =>
      c.getAttribute("data-section"),
    );
    expect(after).toEqual(before);
    expect(row.scrollLeft).toBe(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(windowScrollTo).not.toHaveBeenCalled();
  });

  it("does not render at all when fewer than two targets exist", () => {
    const only = document.createElement("section");
    only.id = "sec-a";
    document.body.appendChild(only);
    const { container } = render(<SectionIndex items={items} />);
    expect(container.querySelector("nav")).toBeNull();
  });
});
