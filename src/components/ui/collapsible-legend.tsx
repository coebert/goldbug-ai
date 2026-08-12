import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Responsive legend that can never overlap the plot area.
 *
 * On phones a five- or six-series legend either wraps onto three rows (pushing
 * the chart out of the card) or scrolls invisibly and hides its last entries.
 * This content renderer keeps the legend to a single row on narrow screens and
 * exposes an explicit "+N" collapse/expand control; from `sm:` up every item is
 * always visible and the control disappears.
 *
 * Use as `<Legend {...LEGEND_PROPS} content={<CollapsibleLegend />} />` so the
 * shared wrapper/typography tokens still apply.
 */

/** Items shown before the legend collapses on a narrow screen. */
export const LEGEND_COLLAPSE_THRESHOLD = 3;

export const LEGEND_LIST_CLASS =
  "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1";
/** Collapsed on phones (one row, clipped); always fully expanded from sm up. */
export const LEGEND_COLLAPSED_CLASS = "max-h-[1.5rem] overflow-hidden sm:max-h-none";
export const LEGEND_TOGGLE_CLASS =
  "sm:hidden shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] leading-4 text-muted-foreground min-h-6";

export type LegendItem = {
  value?: React.ReactNode;
  color?: string;
  type?: string;
  payload?: { strokeDasharray?: string | number };
  inactive?: boolean;
};

export function CollapsibleLegend({
  payload = [],
  iconSize = 9,
  onItemClick,
}: {
  payload?: LegendItem[];
  iconSize?: number;
  onItemClick?: (item: LegendItem, index: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = payload.length > LEGEND_COLLAPSE_THRESHOLD;
  const hidden = payload.length - LEGEND_COLLAPSE_THRESHOLD;

  return (
    <div className="flex w-full min-w-0 items-start gap-2">
      <div
        className={cn(
          LEGEND_LIST_CLASS,
          collapsible && !expanded && LEGEND_COLLAPSED_CLASS,
        )}
      >
        {payload.map((item, index) => (
          <span
            key={`${String(item.value)}-${index}`}
            className={cn(
              "inline-flex min-w-0 items-center gap-1.5",
              item.inactive && "opacity-50",
              onItemClick && "cursor-pointer",
            )}
            onClick={onItemClick ? () => onItemClick(item, index) : undefined}
          >
            <span
              aria-hidden
              className="shrink-0 rounded-[2px]"
              style={{
                width: iconSize,
                height: iconSize,
                background: item.color ?? "currentColor",
              }}
            />
            <span className="truncate">{item.value}</span>
          </span>
        ))}
      </div>
      {collapsible ? (
        <button
          type="button"
          className={LEGEND_TOGGLE_CLASS}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Less" : `+${hidden}`}
        </button>
      ) : null}
    </div>
  );
}

export default CollapsibleLegend;
