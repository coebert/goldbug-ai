import * as React from "react";
import { Inbox } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Phase 4 — standardised empty state used inside SectionCardBody when
 * a request succeeded but produced no rows / no matching data.
 *
 * Renders inside a dashed-border tile that matches the shape of the
 * usual card content, so the layout does not collapse.
 */
export interface EmptyStateProps
  extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** Compact variant reduces vertical padding for use in dense layouts. */
  compact?: boolean;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center justify-center rounded-md border border-dashed border-border/60 bg-surface-sunken/40 text-center",
        compact ? "gap-1.5 px-4 py-6" : "gap-2 px-6 py-10",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className="text-muted-foreground [&_svg]:h-6 [&_svg]:w-6"
      >
        {icon ?? <Inbox />}
      </span>
      <div className="text-sm font-medium">{title}</div>
      {description ? (
        <div className="max-w-sm text-xs text-muted-foreground sm:text-sm">
          {description}
        </div>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
