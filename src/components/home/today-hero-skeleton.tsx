import { Skeleton } from "@/components/ui/skeleton";

/**
 * Placeholder for the "Today" hero while equity is still being computed.
 * Mirrors the real hero's block sizes so the page doesn't jump on phones
 * when the numbers land.
 */
export function TodayHeroSkeleton() {
  return (
    <section
      role="status"
      aria-busy="true"
      aria-label="Loading today's equity"
      data-testid="today-hero-skeleton"
      className="mb-6 overflow-hidden rounded-2xl border border-border/70 bg-surface-2 shadow-[var(--shadow-card)]"
    >
      <div className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-6 sm:px-6 sm:py-6">
        <div className="min-w-0 space-y-2">
          <Skeleton variant="shimmer" className="h-3 w-44" />
          <Skeleton variant="shimmer" className="h-8 w-56 sm:h-10" />
          <Skeleton variant="shimmer" className="h-3 w-64" />
        </div>
        <Skeleton variant="shimmer" className="h-14 w-full rounded-lg sm:w-48" />
      </div>
      <div className="grid gap-2 border-t border-border/60 px-4 py-3 sm:grid-cols-2 sm:gap-3 sm:px-6 sm:py-4">
        <Skeleton variant="shimmer" className="h-20 w-full rounded-xl" />
        <Skeleton variant="shimmer" className="h-20 w-full rounded-xl" />
      </div>
    </section>
  );
}
