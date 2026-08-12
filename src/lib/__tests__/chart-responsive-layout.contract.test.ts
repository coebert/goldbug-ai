// Contract for the small-screen chart layout rules.
//
// Three regressions keep coming back on phones, and each has a single shared
// owner now:
//   1. legends grow past the card and clip their last series;
//   2. tooltips render as one very wide line that runs off the viewport;
//   3. filter clusters (range toggles, series switches) squash their labels
//      instead of scrolling.
// This suite locks the shared primitives and fails the moment a chart
// hand-rolls its own version of them again.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { LEGEND_PROPS, LEGEND_STYLE, TOOLTIP_CONTENT_STYLE } from "@/lib/chart-palette";
import { SAXO_LEGEND_PROPS, SAXO_TOOLTIP_CONTENT } from "@/lib/saxo-chart";
import {
  CHART_FILTER_ITEM_CLASS,
  CHART_FILTER_ROW_CLASS,
} from "@/components/ui/chart-filter-row";

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

const chartFiles = walk(SRC).filter(
  (f) => !f.includes("__tests__") && /from "recharts"/.test(readFileSync(f, "utf8")),
);

describe("legend sizing is viewport-responsive", () => {
  it("shrinks the label on narrow screens without dropping below the 11px floor", () => {
    expect(LEGEND_STYLE.fontSize).toBe("clamp(11px, 2.9vw, 12px)");
  });

  it("wraps within a bounded height instead of pushing the plot area", () => {
    expect(LEGEND_STYLE.maxHeight).toBeTruthy();
    expect(LEGEND_STYLE.overflowY).toBe("auto");
    expect(LEGEND_STYLE.width).toBe("100%");
  });

  it("uses a smaller swatch than the Recharts 14px default", () => {
    expect(LEGEND_PROPS.iconSize).toBeLessThan(14);
    expect(LEGEND_PROPS.wrapperStyle).toBe(LEGEND_STYLE);
    expect(SAXO_LEGEND_PROPS.iconSize).toBe(LEGEND_PROPS.iconSize);
    expect(SAXO_LEGEND_PROPS.wrapperStyle.fontSize).toBe(LEGEND_STYLE.fontSize);
  });

  it("keeps both legend presets colour-tokenised", () => {
    expect(LEGEND_STYLE.color).toMatch(/^var\(--/);
    expect(SAXO_LEGEND_PROPS.wrapperStyle.color).toBeTruthy();
  });
});

describe("tooltips stay inside the viewport", () => {
  for (const [label, style] of [
    ["generic", TOOLTIP_CONTENT_STYLE],
    ["saxo", SAXO_TOOLTIP_CONTENT],
  ] as const) {
    it(`${label} tooltip caps its width against the viewport`, () => {
      expect(style.maxWidth).toBe("min(88vw, 20rem)");
    });

    it(`${label} tooltip wraps long series names`, () => {
      expect(style.whiteSpace).toBe("normal");
      expect(style.overflowWrap).toBe("anywhere");
    });
  }
});

describe("chart filter rows scroll rather than squash", () => {
  it("scrolls horizontally on mobile and returns to wrapping at sm", () => {
    expect(CHART_FILTER_ROW_CLASS).toContain("overflow-x-auto");
    expect(CHART_FILTER_ROW_CLASS).toContain("sm:overflow-visible");
    expect(CHART_FILTER_ROW_CLASS).toContain("sm:flex-wrap");
  });

  it("stops children being compressed and gives the scroll snap points", () => {
    expect(CHART_FILTER_ROW_CLASS).toContain("[&>*]:shrink-0");
    expect(CHART_FILTER_ROW_CLASS).toContain("snap-x");
    expect(CHART_FILTER_ITEM_CLASS).toContain("shrink-0");
  });

  it("hides the scrollbar so the row reads as content", () => {
    expect(CHART_FILTER_ROW_CLASS).toContain("[scrollbar-width:none]");
  });
});

describe("card headers give chart actions their own mobile row", () => {
  const header = readFileSync(join(SRC, "components/ui/section-card.tsx"), "utf8");

  it("stacks title and action on phones, two columns from sm", () => {
    expect(header).toContain("grid-cols-1");
    expect(header).toContain("sm:grid-cols-[minmax(0,1fr)_auto]");
  });

  it("routes the action slot through the shared filter row", () => {
    expect(header).toContain("CHART_FILTER_ROW_CLASS");
  });
});

describe("no chart re-hand-rolls the legend style", () => {
  for (const file of chartFiles) {
    const src = readFileSync(file, "utf8");
    const name = file.slice(SRC.length + 1);
    it(`${name}: legends use a shared preset`, () => {
      for (const legend of src.match(/<Legend\b[^>]*?\/?>/gs) ?? []) {
        expect(
          /\{\.\.\.(?:SAXO_)?LEGEND_PROPS\}/.test(legend),
          `hand-rolled legend style in ${name}: ${legend}`,
        ).toBe(true);
      }
    });
  }
});
