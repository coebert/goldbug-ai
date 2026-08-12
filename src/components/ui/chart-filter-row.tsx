import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Shared class for a row of chart controls (range toggles, series filters,
 * scale switches, refresh buttons).
 *
 * The failure mode this fixes: a four- or five-option control cluster is wider
 * than a 360px phone, so inside a `shrink-0` flex cell it clips its last
 * option, and inside a shrinking cell it squashes the labels to nothing.
 * Here the row keeps its natural width and scrolls horizontally instead, with
 * snap points so a flick lands on a control rather than between two, and the
 * scrollbar hidden so it reads as content rather than chrome. From `sm:` up
 * everything fits, so the row wraps normally and stops scrolling.
 */
export const CHART_FILTER_ROW_CLASS =
  "-mx-1 flex max-w-full snap-x snap-mandatory items-center gap-2 overflow-x-auto px-1 pb-0.5 " +
  // Children must keep their intrinsic width or the row squashes labels
  // instead of scrolling; `sm:` hands sizing back to the wrapping layout.
  "[&>*]:shrink-0 [&>*]:snap-start sm:[&>*]:shrink " +
  "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden " +
  "sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0";

/** Each direct child snaps and refuses to be squashed by its siblings. */
export const CHART_FILTER_ITEM_CLASS = "shrink-0 snap-start";

export interface ChartFilterRowProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

/**
 * Wrapper for chart filters that sit outside a `SectionCardHeader` action
 * slot (which already applies the same treatment).
 */
export const ChartFilterRow = React.forwardRef<HTMLDivElement, ChartFilterRowProps>(
  ({ className, children, ...props }, ref) => (
    <div ref={ref} className={cn(CHART_FILTER_ROW_CLASS, className)} {...props}>
      {children}
    </div>
  ),
);
ChartFilterRow.displayName = "ChartFilterRow";
