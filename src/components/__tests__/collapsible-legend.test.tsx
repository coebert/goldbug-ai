// Contract for the responsive legend collapse/expand control.
//
// A five-series legend on a 360px phone used to wrap onto three rows and push
// the plot area out of its card. The legend now clips to a single row on
// narrow screens and offers an explicit "+N" control; from `sm:` up it is
// always fully expanded and the control is hidden.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CollapsibleLegend,
  LEGEND_COLLAPSE_THRESHOLD,
  LEGEND_COLLAPSED_CLASS,
  LEGEND_TOGGLE_CLASS,
} from "@/components/ui/collapsible-legend";

const items = ["Equity", "Benchmark", "Cash", "Fees", "Deposits"].map(
  (value, i) => ({ value, color: `#00000${i}` }),
);

const markup = (payload: typeof items) =>
  renderToStaticMarkup(<CollapsibleLegend payload={payload} />);

describe("CollapsibleLegend", () => {
  it("renders every series label so nothing is silently dropped", () => {
    const html = markup(items);
    for (const item of items) expect(html).toContain(item.value);
  });

  it("clips to one row on phones once past the threshold", () => {
    expect(markup(items)).toContain(LEGEND_COLLAPSED_CLASS.split(" ")[0]);
    expect(LEGEND_COLLAPSED_CLASS).toContain("overflow-hidden");
    expect(LEGEND_COLLAPSED_CLASS).toContain("sm:max-h-none");
  });

  it("leaves short legends uncollapsed and control-free", () => {
    const html = markup(items.slice(0, LEGEND_COLLAPSE_THRESHOLD));
    expect(html).not.toContain("<button");
    expect(html).not.toContain(LEGEND_COLLAPSED_CLASS.split(" ")[0]);
  });

  it("labels the control with the number of hidden series", () => {
    expect(markup(items)).toContain(`+${items.length - LEGEND_COLLAPSE_THRESHOLD}`);
    expect(markup(items)).toContain('aria-expanded="false"');
  });

  it("hides the control from sm up, where the full legend fits", () => {
    expect(LEGEND_TOGGLE_CLASS).toContain("sm:hidden");
    expect(LEGEND_TOGGLE_CLASS).toContain("min-h-6");
  });
});
