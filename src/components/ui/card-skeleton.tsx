import * as React from "react";

import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Phase 4 — reusable loading skeletons for SectionCardBody. Every card
 * that renders a chart, table or list should use one of these while
 * data is inbound so the shape does not shift when values arrive.
 */

export interface ChartSkeletonProps {
  /** Height in Tailwind arbitrary value form (px, rem, etc). */
  height?: string;
  /** Show a small headline block above the chart placeholder. */
  withHeadline?: boolean;
  className?: string;
}

export function ChartSkeleton({
  height = "260px",
  withHeadline = true,
  className,
}: ChartSkeletonProps) {
  return (
    <div className={cn("space-y-3", className)} aria-busy="true">
      {withHeadline ? (
        <div className="space-y-1.5">
          <Skeleton variant="shimmer" className="h-6 w-32" />
          <Skeleton variant="shimmer" className="h-3 w-48" />
        </div>
      ) : null}
      <Skeleton
        variant="shimmer"
        className="w-full"
        style={{ height }}
      />
    </div>
  );
}

export interface ListSkeletonProps {
  rows?: number;
  /** Show a leading avatar/icon block on each row. */
  withAvatar?: boolean;
  className?: string;
}

export function ListSkeleton({
  rows = 4,
  withAvatar = true,
  className,
}: ListSkeletonProps) {
  return (
    <div className={cn("space-y-3", className)} aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          {withAvatar ? (
            <Skeleton variant="shimmer" className="h-8 w-8 rounded-full" />
          ) : null}
          <div className="flex-1 space-y-1.5">
            <Skeleton variant="shimmer" className="h-3.5 w-3/5" />
            <Skeleton variant="shimmer" className="h-3 w-2/5" />
          </div>
          <Skeleton variant="shimmer" className="h-4 w-12" />
        </div>
      ))}
    </div>
  );
}

export interface TileGridSkeletonProps {
  tiles?: number;
  className?: string;
}

export function TileGridSkeleton({
  tiles = 4,
  className,
}: TileGridSkeletonProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-3 sm:grid-cols-4",
        className,
      )}
      aria-busy="true"
    >
      {Array.from({ length: tiles }).map((_, i) => (
        <div key={i} className="space-y-2 rounded-md border border-border/40 bg-surface-sunken/30 p-3">
          <Skeleton variant="shimmer" className="h-3 w-16" />
          <Skeleton variant="shimmer" className="h-6 w-20" />
        </div>
      ))}
    </div>
  );
}
