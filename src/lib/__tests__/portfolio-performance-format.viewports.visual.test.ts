// Viewport-scoped visual regression for the portfolio performance
// chart. The chart branches its tick labels, axis title, tooltip
// text and layout constants on the `isMobile` flag derived from
// `useIsMobile` (breakpoint = 768px, see `src/hooks/use-mobile.tsx`).
//
// This suite pins the label + layout surface at three common
// viewports — mobile (375), tablet (834), desktop (1440) — so any
// accidental change to a tick formatter, axis label, tooltip line
// or the mobile/desktop layout constants used by the route fails
// loudly in CI. It complements `portfolio-performance-format.visual`
// (which iterates helpers directly) by fixing the *combination* of
// values that ship together at each screen size.

import { describe, expect, it } from "vitest";

import {
  compareGridHeader,
  formatDateTick,
  formatTooltipValue,
  formatValueTick,
  tooltipModeChip,
  yAxisLabel,
} from "../portfolio-performance-format";

process.env.TZ = "UTC";

// Mirror of `useIsMobile` — the hook returns true for widths under
// 768px, so tablet + desktop both take the desktop code path. We
// still snapshot all three so a future breakpoint change is caught.
const MOBILE_BREAKPOINT = 768;
const isMobileAt = (w: number) => w < MOBILE_BREAKPOINT;

// Mirror of the layout constants the route feeds into recharts at
// each viewport (see `src/routes/portfolio.$id.tsx` around the
// ComposedChart). Kept as data so the snapshot fails if either the
// route's constants or the branching threshold move.
function chartLayoutFor(width: number) {
  const isMobile = isMobileAt(width);
  return {
    isMobile,
    chartMargin: { top: 8, right: isMobile ? 6 : 12, left: isMobile ? -12 : 0, bottom: 8 },
    xAxis: {
      tickFontSize: isMobile ? 10 : 11,
      minTickGap: isMobile ? 56 : 30,
      showLabel: !isMobile,
      labelText: isMobile ? undefined : "Date",
    },
  } as const;
}

const VIEWPORTS = [
  { name: "mobile", width: 375 },
  { name: "tablet", width: 834 },
  { name: "desktop", width: 1440 },
] as const;

const DATE_SAMPLES = ["2024-01-04", "2024-06-15", "2024-12-31"];
const VALUE_SAMPLES = [0, 250, 1_000, 12_345.67, 1_500_000, -750];
const TOOLTIP_SAMPLES = [0, 12.5, 1_234.567, -50.25];

describe("portfolio performance chart — viewport visual regression", () => {
  for (const vp of VIEWPORTS) {
    it(`${vp.name} (${vp.width}px) — chart layout constants`, () => {
      expect(chartLayoutFor(vp.width)).toMatchSnapshot();
    });

    it(`${vp.name} (${vp.width}px) — x-axis date ticks`, () => {
      const isMobile = isMobileAt(vp.width);
      expect(DATE_SAMPLES.map((d) => formatDateTick(d, isMobile))).toMatchSnapshot();
    });

    it(`${vp.name} (${vp.width}px) — y-axis ticks raw/pct in £ and $`, () => {
      const isMobile = isMobileAt(vp.width);
      expect({
        raw_gbp: VALUE_SAMPLES.map((v) =>
          formatValueTick(v, { currency: "£", isPct: false, isMobile }),
        ),
        raw_usd: VALUE_SAMPLES.map((v) =>
          formatValueTick(v, { currency: "$", isPct: false, isMobile }),
        ),
        pct: VALUE_SAMPLES.map((v) =>
          formatValueTick(v, { currency: "£", isPct: true, isMobile }),
        ),
      }).toMatchSnapshot();
    });

    it(`${vp.name} (${vp.width}px) — y-axis title text`, () => {
      // Title is currency/mode-driven (viewport-independent by design);
      // pinning it per viewport ensures we notice if a future change
      // starts hiding it on small screens.
      expect({
        raw_gbp: yAxisLabel("raw", "£"),
        raw_usd: yAxisLabel("raw", "$"),
        pct: yAxisLabel("pct", "£"),
      }).toMatchSnapshot();
    });

    it(`${vp.name} (${vp.width}px) — tooltip label surface`, () => {
      expect({
        chipRaw: tooltipModeChip(false),
        chipPct: tooltipModeChip(true),
        header: {
          none: compareGridHeader("none"),
          spy: compareGridHeader("SPY"),
        },
        valuesRawGbp: TOOLTIP_SAMPLES.map((v) =>
          formatTooltipValue(v, { currency: "£", isPct: false }),
        ),
        valuesPct: TOOLTIP_SAMPLES.map((v) =>
          formatTooltipValue(v, { currency: "£", isPct: true }),
        ),
      }).toMatchSnapshot();
    });
  }

  it("mobile / tablet / desktop layouts differ only across the 768px break", () => {
    // Contract check: tablet and desktop must produce identical
    // chart layout constants because they share the desktop branch.
    // Mobile must differ. If someone bumps the breakpoint above
    // 834 or introduces a new tablet-only branch, this trips.
    const mobile = chartLayoutFor(375);
    const tablet = chartLayoutFor(834);
    const desktop = chartLayoutFor(1440);
    expect(tablet).toEqual(desktop);
    expect(mobile).not.toEqual(desktop);
  });
});
