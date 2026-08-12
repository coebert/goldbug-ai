// @vitest-environment jsdom
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

/** Narrow row: only ~100px of chips fit, chips laid out 120px apart. */
function narrowRow(row: HTMLElement) {
  Object.defineProperty(row, "clientWidth", { value: 100, configurable: true });
  for (const [idx, chip] of Array.from(
    row.querySelectorAll<HTMLElement>("[data-section]"),
  ).entries()) {
    Object.defineProperty(chip, "offsetLeft", { value: idx * 120, configurable: true });
    Object.defineProperty(chip, "offsetWidth", { value: 110, configurable: true });
  }
}

/** Dispatch a scroll and let the rAF-throttled spy run. */
async function scrollTick() {
  await act(async () => {
    window.dispatchEvent(new Event("scroll"));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  });
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
  it("never scrolls the page or an ancestor while spying on scroll", async () => {
    mountSections();
    positionAt(0);
    render(<SectionIndex items={items} />);

    for (const y of [100, 500, 900, 1400, 1900, 2400]) {
      positionAt(y);
      await scrollTick();
    }


    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(windowScrollTo).not.toHaveBeenCalled();
  });

  it("keeps the active chip visible via horizontal row scrolling only", async () => {
    mountSections();
    positionAt(0);
    const { container } = render(<SectionIndex items={items} />);
    const row = container.querySelector<HTMLElement>("nav > div")!;
    narrowRow(row);

    positionAt(1700); // third section is active
    await scrollTick();

    expect(row.scrollLeft).toBeGreaterThan(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(windowScrollTo).not.toHaveBeenCalled();
  });

  it("writes no scroll position while a finger is down, then flushes on lift", async () => {
    mountSections();
    positionAt(0);
    const { container } = render(<SectionIndex items={items} />);
    const row = container.querySelector<HTMLElement>("nav > div")!;
    narrowRow(row);

    act(() => {
      window.dispatchEvent(new Event("touchstart"));
    });
    positionAt(1700);
    await scrollTick();

    // Mid-gesture: the row must not be scrolled, or iOS aborts the fling.
    expect(row.scrollLeft).toBe(0);

    act(() => {
      window.dispatchEvent(new Event("touchend"));
    });
    expect(row.scrollLeft).toBeGreaterThan(0);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(windowScrollTo).not.toHaveBeenCalled();
  });

  it("registers its scroll and touch listeners as passive", () => {
    mountSections();
    positionAt(0);
    const add = vi.spyOn(window, "addEventListener");
    render(<SectionIndex items={items} />);

    for (const type of ["scroll", "touchstart", "touchend", "touchcancel"]) {
      const call = add.mock.calls.find((c) => c[0] === type);
      expect(call, `${type} listener registered`).toBeTruthy();
      expect(call![2], `${type} passive`).toMatchObject({ passive: true });
    }
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
