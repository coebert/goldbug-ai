import { Link, useRouter } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";

/**
 * Sticky back affordance for leaf routes (a single symbol chart, a report).
 * Mobile users arrive here from a card tap and otherwise have no way back
 * except the OS gesture — this gives them a visible, 44px-tall target that
 * sits directly under the app header.
 */
export function BackRow({
  to,
  label,
  title,
}: {
  /** Parent route to return to. Falls back to router history when omitted. */
  to?: string;
  label: string;
  title?: string;
}) {
  const router = useRouter();
  const inner = (
    <>
      <ChevronLeft className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </>
  );
  return (
    <div className="sticky top-[var(--app-header-h,3.25rem)] z-20 -mx-4 mb-3 flex items-center gap-2 border-b border-border bg-surface-1/90 px-4 py-1 backdrop-blur md:hidden">
      {to ? (
        <Link
          to={to as never}
          className="inline-flex min-h-11 min-w-0 items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {inner}
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => router.history.back()}
          className="inline-flex min-h-11 min-w-0 items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {inner}
        </button>
      )}
      {title ? (
        <span className="min-w-0 truncate text-sm font-semibold">{title}</span>
      ) : null}
    </div>
  );
}
