import { useCallback, useEffect, useRef, useState } from "react";
import { useIsFetching, useQueryClient, type Query } from "@tanstack/react-query";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import {
  RATIONALE_REFRESH_QUERY_KEYS,
  describeRationaleRefresh,
  getLastRationaleRefresh,
  subscribeRationaleRefresh,
  type RationaleRefreshEvent,
} from "@/lib/rationale-refresh";
import {
  RATIONALE_MAX_AUTO_RETRIES,
  describeRationaleFailure,
  rationaleRetryDelayMs,
  shouldAutoRetryRationale,
} from "@/lib/rationale-retry";

const isRationaleQuery = (q: Query) =>
  RATIONALE_REFRESH_QUERY_KEYS.includes(q.queryKey[0] as never);

/**
 * Subscribes to the rationale refresh bus, invalidates the derived queries,
 * reports whether a recalculation is in flight and retries failures with
 * bounded exponential backoff.
 */
export function useRationaleRefresh() {
  const qc = useQueryClient();
  const [event, setEvent] = useState<RationaleRefreshEvent | null>(() => getLastRationaleRefresh());
  const [, setTick] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const invalidate = useCallback(() => {
    for (const key of RATIONALE_REFRESH_QUERY_KEYS) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  }, [qc]);

  useEffect(
    () =>
      subscribeRationaleRefresh((e) => {
        setEvent(e);
        setAttempt(0);
        setError(null);
        invalidate();
      }),
    [invalidate, qc],
  );

  // Keep the "Xs ago" label live.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 15_000);
    return () => window.clearInterval(id);
  }, []);

  // Watch the derived queries for failures.
  useEffect(() => {
    const cache = qc.getQueryCache();
    const read = () => {
      const failed = cache.getAll().find((q) => isRationaleQuery(q) && q.state.status === "error");
      setError(failed ? failed.state.error : null);
    };
    read();
    return cache.subscribe(read);
  }, [qc]);

  const pending = useIsFetching({ predicate: isRationaleQuery });
  const isRefreshing = pending > 0;

  const retryNow = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setAttempt(0);
    setError(null);
    void qc.refetchQueries({ predicate: isRationaleQuery });
  }, [qc]);

  // Bounded automatic retry.
  useEffect(() => {
    if (!error || isRefreshing) return;
    if (!shouldAutoRetryRationale(error, attempt)) return;
    const delay = rationaleRetryDelayMs(attempt + 1);
    timer.current = setTimeout(() => {
      setAttempt((a) => a + 1);
      void qc.refetchQueries({ predicate: isRationaleQuery });
    }, delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [error, isRefreshing, attempt, qc]);

  return {
    event,
    isRefreshing,
    error,
    attempt,
    canAutoRetry: error ? shouldAutoRetryRationale(error, attempt) : false,
    errorLabel: error ? describeRationaleFailure(error, attempt, RATIONALE_MAX_AUTO_RETRIES) : null,
    retryNow,
    label: describeRationaleRefresh(event, Date.now()),
  };
}

/** Inline one-line status shown above rationale levels. */
export function RationaleRefreshStatus({ className }: { className?: string }) {
  const { event, isRefreshing, label, error, errorLabel, retryNow } = useRationaleRefresh();
  if (!event && !isRefreshing && !error) return null;

  if (error && !isRefreshing) {
    return (
      <p
        role="status"
        aria-live="polite"
        className={`flex flex-wrap items-center gap-1.5 text-[11px] text-destructive ${className ?? ""}`}
      >
        <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
        <span>{errorLabel}</span>
        <button
          type="button"
          onClick={retryNow}
          className="inline-flex min-h-[24px] items-center gap-1 rounded-md border border-destructive/40 px-2 py-0.5 font-medium text-destructive transition-colors hover:bg-destructive/10"
        >
          <RefreshCw className="h-3 w-3" aria-hidden />
          Retry now
        </button>
      </p>
    );
  }

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
