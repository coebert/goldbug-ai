import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";
import { useIsMobile } from "@/hooks/use-mobile";

export type PrefetchTarget = {
  to: string;
  params?: Record<string, string>;
};

type NetworkInformation = {
  saveData?: boolean;
  effectiveType?: string;
};

/**
 * True when the device/browser signals we should not spend background
 * bandwidth: Data Saver on, or a slow (2g-class) connection.
 */
export function shouldSkipPrefetch(): boolean {
  if (typeof navigator === "undefined") return true;
  const conn = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  if (!conn) return false;
  if (conn.saveData) return true;
  const et = conn.effectiveType ?? "";
  return et === "slow-2g" || et === "2g";
}

function onIdle(cb: () => void, timeout = 2000): () => void {
  if (typeof window === "undefined") return () => {};
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof w.requestIdleCallback === "function") {
    const handle = w.requestIdleCallback(cb, { timeout });
    return () => w.cancelIdleCallback?.(handle);
  }
  const t = window.setTimeout(cb, 300);
  return () => window.clearTimeout(t);
}

/**
 * Background-prefetch the route chunks (and loaders) for the sections the
 * user is most likely to open next.
 *
 * Runs once the browser is idle, only on mobile viewports by default, and
 * never on Data Saver / 2g connections. Targets are preloaded one at a
 * time so we never contend with the current page's own fetches.
 */
export function useIdlePrefetch(targets: PrefetchTarget[], opts?: { mobileOnly?: boolean; enabled?: boolean }) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const mobileOnly = opts?.mobileOnly ?? true;
  const enabled = opts?.enabled ?? true;
  const key = JSON.stringify(targets);

  useEffect(() => {
    if (!enabled) return;
    if (mobileOnly && !isMobile) return;
    if (shouldSkipPrefetch()) return;

    let cancelled = false;
    const cancelIdle = onIdle(() => {
      void (async () => {
        for (const t of JSON.parse(key) as PrefetchTarget[]) {
          if (cancelled) return;
          try {
            await router.preloadRoute({ to: t.to, params: t.params } as never);
          } catch {
            // Preloading is best-effort; a failure must never surface to the user.
          }
        }
      })();
    });

    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [key, router, isMobile, mobileOnly, enabled]);
}

/**
 * Touch-intent prefetch: phones have no hover, so `defaultPreload: "intent"`
 * only fires on touchstart-as-hover in some browsers. Wiring this to
 * onTouchStart gives a reliable ~100ms head start before the tap completes.
 */
export function usePrefetchOnTouch() {
  const router = useRouter();
  return (target: PrefetchTarget) => {
    if (shouldSkipPrefetch()) return;
    void router.preloadRoute({ to: target.to, params: target.params } as never).catch(() => {});
  };
}
