import { useCallback, useEffect, useState } from "react";

const KEY = "aegis.focusMode";

/**
 * Persisted "Focus mode" toggle. When true, the dashboard hides the
 * secondary panels (all-portfolios chart, news reel, decision breakdown)
 * so the user can concentrate on portfolio equity numbers.
 */
export function useFocusMode(): [boolean, (v: boolean) => void] {
  const [focus, setFocus] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(KEY) === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(KEY, focus ? "1" : "0");
  }, [focus]);
  const set = useCallback((v: boolean) => setFocus(v), []);
  return [focus, set];
}
