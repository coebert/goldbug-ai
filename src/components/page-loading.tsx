import { Skeleton } from "@/components/ui/skeleton";

interface PageLoadingProps {
  /** Optional label announced to screen readers */
  label?: string;
  /** Number of skeleton card rows to render */
  rows?: number;
}

/**
 * Consistent full-page loading state used across routes.
 * Renders skeleton blocks that roughly match a stacked card layout instead
 * of a bare "Loading…" text.
 */
export function PageLoading({ label = "Loading", rows = 3 }: PageLoadingProps) {
  return (
    <div
      role="status"
      aria-label={label}
      aria-live="polite"
      className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6"
    >
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-xl border bg-card p-4 sm:p-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-32 w-full" />
        </div>
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}
