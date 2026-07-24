// Client-side preference: should equity % changes INCLUDE external
// deposit / withdrawal cash-flows, or exclude them (trading PnL only)?
//
// Default = false (exclude deposits). Persisted in localStorage so the
// choice survives reloads and applies uniformly across dashboard tiles,
// per-portfolio charts and the compare tool.
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "aegis:include-deposits-in-pct";

function readInitial(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function useIncludeDeposits(): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(false);
  // Hydration-safe: read localStorage after mount only.
  useEffect(() => {
    setValue(readInitial());
  }, []);
  const set = useCallback((v: boolean) => {
    setValue(v);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
      // Notify sibling hooks in other components in the same tab.
      window.dispatchEvent(new CustomEvent("aegis:include-deposits-changed", { detail: v }));
    } catch {
      /* ignore */
    }
  }, []);
  // Cross-component sync within a single tab.
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail;
      if (typeof detail === "boolean") setValue(detail);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setValue(e.newValue === "1");
    };
    window.addEventListener("aegis:include-deposits-changed", onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("aegis:include-deposits-changed", onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return [value, set];
}
