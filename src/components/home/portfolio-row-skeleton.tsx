import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Placeholder for a single PortfolioRow.
 *
 * Every block below maps 1:1 onto the real row so the card occupies the
 * same height before and after data lands:
 *   - header grid: name/meta on the left, Open + menu buttons on the right
 *   - divider, then the equity grid: sparkline + range switcher on the
 *     left, total equity stack on the right (right-aligned from `sm`).
 */
export function PortfolioRowSkeleton() {
  return (
    <Card role="status" aria-busy="true" aria-label="Loading portfolio" data-testid="portfolio-row-skeleton">
      <CardContent className="p-4 sm:p-5">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton variant="shimmer" className="h-5 w-40" />
              <Skeleton className="h-4 w-12 rounded-full" />
            </div>
            <Skeleton className="h-3 w-52" />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Skeleton className="h-10 w-20 rounded-md" />
            <Skeleton className="h-10 w-10 rounded-md" />
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 border-t border-border/60 pt-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Skeleton variant="shimmer" className="h-8 w-[120px] rounded-md" />
              <Skeleton className="h-4 w-24" />
            </div>
            <div className="mt-2 flex gap-0.5 rounded-md border border-border/60 p-0.5">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-[28px] flex-1 rounded-sm" />
              ))}
            </div>
          </div>
          <div className="flex min-w-0 flex-col items-start gap-1 sm:items-end">
            <Skeleton className="h-3 w-20" />
            <Skeleton variant="shimmer" className="mt-1 h-8 w-40" />
            <Skeleton variant="shimmer" className="h-4 w-24" />
            <Skeleton variant="shimmer" className="h-4 w-16" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** A stack of row placeholders matching the real list's vertical rhythm. */
export function PortfolioListSkeleton({ count = 1 }: { count?: number }) {
  return (
    <div className="space-y-3" data-testid="portfolio-list-skeleton">
      {Array.from({ length: Math.max(1, count) }).map((_, i) => (
        <PortfolioRowSkeleton key={i} />
      ))}
    </div>
  );
}
