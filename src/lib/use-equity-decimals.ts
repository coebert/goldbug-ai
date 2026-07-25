// Client-side preference: how many decimal places to show for the GBP
// (and any other currency) total-equity headline on every portfolio card.
//
// Default = 2 (matches the existing snapshot/regression contracts).
// Persisted in localStorage so the choice survives reloads and applies
// uniformly across dashboard tiles and per-portfolio cards.
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "aegis:equity-decimals";
const EVENT = "aegis:equity-decimals-changed";
export const EQUITY_DECIMALS_MIN = 0;
export const EQUITY_DECIMALS_MAX = 4;
export const EQUITY_DECIMALS_DEFAULT = 2;

function clamp(n: number): number {
  if (!Number.isFinite(n)) return EQUITY_DECIMALS_DEFAULT;
  const i = Math.trunc(n);
  if (i < EQUITY_DECIMALS_MIN) return EQUITY_DECIMALS_MIN;
  if (i > EQUITY_DECIMALS_MAX) return EQUITY_DECIMALS_MAX;
  return i;
}

function readInitial(): number {
  if (typeof window === "undefined") return EQUITY_DECIMALS_DEFAULT;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw == null) return EQUITY_DECIMALS_DEFAULT;
    const n = Number.parseInt(raw, 10);
    return Number.isNaN(n) ? EQUITY_DECIMALS_DEFAULT : clamp(n);
  } catch {
    return EQUITY_DECIMALS_DEFAULT;
  }
}

export function useEquityDecimals(): [number, (v: number) => void] {
  const [value, setValue] = useState<number>(EQUITY_DECIMALS_DEFAULT);
  // Hydration-safe: read localStorage after mount only.
  useEffect(() => {
    setValue(readInitial());
  }, []);
  const set = useCallback((v: number) => {
    const c = clamp(v);
    setValue(c);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, String(c));
      window.dispatchEvent(new CustomEvent(EVENT, { detail: c }));
    } catch {
      /* ignore */
    }
  }, []);
  // Cross-component sync within a single tab (+ cross-tab via storage event).
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<number>).detail;
      if (typeof detail === "number") setValue(clamp(detail));
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const n = e.newValue == null ? EQUITY_DECIMALS_DEFAULT : Number.parseInt(e.newValue, 10);
      setValue(Number.isNaN(n) ? EQUITY_DECIMALS_DEFAULT : clamp(n));
    };
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return [value, set];
}
