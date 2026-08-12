import * as React from "react";
import { HelpCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import { CHART_FILTER_ROW_CLASS } from "@/components/ui/chart-filter-row";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Phase 4 — standardised card primitive.
 *
 * Every long-lived data card in the app (backtest, live holdings, news,
 * decisions, correlation heatmap, regime, risk controls, etc.) should
 * eventually adopt SectionCard so that:
 *   - the header rhythm (title + optional icon, description, tooltip,
 *     trailing action) is identical everywhere;
 *   - loading / empty / error slots share one visual language via
 *     CardSkeleton, EmptyState and ErrorState;
 *   - the footer's "updated at + refresh" contract is consistent.
 *
 * SectionCard is a thin composition over the underlying shadcn Card so
 * migrating a component is a single-file, non-breaking swap.
 */

export interface SectionCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Optional elevation. Defaults to a flat card; hover raises on interactive cards. */
  interactive?: boolean;
}

export const SectionCard = React.forwardRef<HTMLDivElement, SectionCardProps>(
  ({ className, interactive, ...props }, ref) => (
    <Card
      ref={ref}
      className={cn(
        "border-border/60 bg-surface-2 shadow-card",
        interactive &&
          "transition-shadow duration-200 ease-out hover:shadow-card-hover",
        className,
      )}
      {...props}
    />
  ),
);
SectionCard.displayName = "SectionCard";

export interface SectionCardHeaderProps {
  /** Short, sentence-case heading. Renders as the CardTitle. */
  title: React.ReactNode;
  /** Optional leading icon rendered before the title. */
  icon?: React.ReactNode;
  /** One-line description below the title. */
  description?: React.ReactNode;
  /** Info tooltip surfaced next to the title as a question-mark. */
  tooltip?: React.ReactNode;
  /** Trailing action slot (range toggle, refresh button, filter). */
  action?: React.ReactNode;
  /** Optional badge/pill rendered to the left of the title. */
  badge?: React.ReactNode;
  className?: string;
}

export function SectionCardHeader({
  title,
  icon,
  description,
  tooltip,
  action,
  badge,
  className,
}: SectionCardHeaderProps) {
  return (
    <CardHeader
      className={cn(
        // Phones get the action (range toggles, filters, refresh) on its own
        // full-width row so a long title can never squeeze it into a clipped
        // sliver; from `sm:` up it returns to the trailing column.
        "grid grid-cols-1 gap-3 space-y-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          {badge}
          {icon ? (
            <span aria-hidden className="shrink-0 text-muted-foreground">
              {icon}
            </span>
          ) : null}
          <CardTitle className="truncate font-display text-base">
            {title}
          </CardTitle>
          {tooltip ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger
                  type="button"
                  className="shrink-0 rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="More info"
                >
                  <HelpCircle className="h-3.5 w-3.5" />
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  className="max-w-xs shadow-popover"
                >
                  {tooltip}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
        </div>
        {description ? (
          <CardDescription className="mt-1.5 text-xs sm:text-sm">
            {description}
          </CardDescription>
        ) : null}
      </div>
      {action ? (
        <div className={cn(CHART_FILTER_ROW_CLASS, "sm:shrink-0")}>{action}</div>
      ) : null}
    </CardHeader>
  );
}

export const SectionCardBody = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <CardContent ref={ref} className={cn("space-y-4", className)} {...props} />
));
SectionCardBody.displayName = "SectionCardBody";

export const SectionCardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <CardFooter
    ref={ref}
    className={cn(
      "flex items-center justify-between gap-2 border-t border-border/40 pt-4 text-xs text-muted-foreground",
      className,
    )}
    {...props}
  />
));
SectionCardFooter.displayName = "SectionCardFooter";
