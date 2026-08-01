import { Skeleton } from "@/components/ui/skeleton";
import { Alert } from "@/components/ui/alert";

/**
 * Placeholder for the portfolio-mirror / snapshot-mismatch banner slot.
 *
 * Uses the same Alert shell and `mb-4` rhythm as the real banner so the
 * content below does not jump when the check resolves. Render it only
 * when a banner is genuinely possible (two or more portfolios) — an
 * always-on reservation would itself be a shift when nothing is wrong.
 */
export function MirrorAlertSkeleton() {
  return (
    <Alert
      role="status"
      aria-busy="true"
      aria-label="Checking portfolios for duplicated data"
      data-testid="mirror-alert-skeleton"
      className="mb-4 border-border/60 bg-surface-2"
    >
      <Skeleton className="h-4 w-4 rounded-sm" />
      <div className="space-y-2">
        <Skeleton variant="shimmer" className="h-4 w-56" />
        <Skeleton className="h-3 w-full max-w-md" />
      </div>
    </Alert>
  );
}
