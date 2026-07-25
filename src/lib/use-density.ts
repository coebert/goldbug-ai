import { useEffect, useSyncExternalStore } from "react";

/**
 * Phase 6 — Density modes.
 *
 * Two settings: "comfortable" (default) and "compact". We drive the
 * change with a single `data-density` attribute on <html> and a
 * matching CSS rule in `src/styles.css` that lowers the root
 * font-size. Because Tailwind spacing is rem-based, every padding,
 * gap and row height scales down proportionally without touching a
 * single component.
 *
 * The preference is persisted per-browser in localStorage and shared
 * across tabs via the `storage` event and a same-tab custom event.
 */

export type Density = "comfortable" | "compact";

const STORAGE_KEY = "aegis.density";
const EVENT = "aegis:density-change";

function readInitial(): Density {
  if (typeof window === "undefined") return "comfortable";
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === "compact" ? "compact" : "comfortable";
}

function subscribe(cb: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) cb();
  };
  const onCustom = () => cb();
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT, onCustom);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(EVENT, onCustom);
  };
}

export function useDensity(): [Density, (v: Density) => void] {
  const value = useSyncExternalStore(
    subscribe,
    readInitial,
    () => "comfortable" as Density,
  );
  const setValue = (v: Density) => {
    window.localStorage.setItem(STORAGE_KEY, v);
    window.dispatchEvent(new Event(EVENT));
  };
  return [value, setValue];
}

/**
 * Mounted once at the root. Reflects the current density into a
 * `data-density` attribute on <html> so the CSS rule can pick it up
 * regardless of which subtree triggered the change.
 */
export function DensityHost() {
  const [density] = useDensity();
  useEffect(() => {
    document.documentElement.setAttribute("data-density", density);
    return () => {
      document.documentElement.removeAttribute("data-density");
    };
  }, [density]);
  return null;
}
