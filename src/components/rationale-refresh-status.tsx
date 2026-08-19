import { useEffect, useState } from "react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import {
  RATIONALE_REFRESH_QUERY_KEYS,
  describeRationaleRefresh,
  getLastRationaleRefresh,
  subscribeRationaleRefresh,
  type RationaleRefreshEvent,
} from "@/lib/rationale-refresh";

/**
 * Subscribes to the rationale refresh bus, invalidates the derived queries
 * and reports whether a recalculation is in flight.
 */
export function useRationaleRefresh() {
  const qc = useQueryClient();
  const [event, setEvent] = useState<RationaleRefreshEvent | null>(() => getLastRationaleRefresh());
  const [tick, setTick] = useState(0);

  useEffect(
    () =>
      subscribeRationaleRefresh((e) => {
        setEvent(e);
        for (const key of RATIONALE_REFRESH_QUERY_KEYS) {
          void qc.invalidateQueries({ queryKey: [key] });
        }
      }),
    [qc],
  );

  // Keep the "Xs ago" label live.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const pending = useIsFetching({
    predicate: (q) => RATIONALE_REFRESH_QUERY_KEYS.includes(q.queryKey[0] as never),
  });

  return {
    event,
    isRefreshing: pending > 0,
    label: describeRationaleRefresh(event, Date.now() + tick * 0),
  };
}

/** Inline one-line status shown above rationale levels. */
export function RationaleRefreshStatus({ className }: { className?: string }) {
  const { event, isRefreshing, label } = useRationaleRefresh();
  if (!event && !isRefreshing) return null;
  return (
    <p
      role="status"
      aria-live="polite"
      className={`flex items-center gap-1.5 text-[11px] text-muted-foreground ${className ?? ""}`}
    >
      {isRefreshing ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
      ) : (
        <RefreshCw className="h-3 w-3 shrink-0" aria-hidden />
      )}
      {isRefreshing ? "Recalculating levels from the latest data…" : label}
    </p>
  );
}
