import { useCallback, useEffect, useState } from "react";

/**
 * Experience level — the single lever that controls how much of the
 * app is visible.
 *
 * - "standard" : the middle setting — your money plus the panels that
 *                explain today's decisions.
 * - "simple"   : the default. Only the handful of panels a newcomer
 *                needs (equity, what happened today, holdings, one
 *                clear next action). Everything expert-level is
 *                collapsed behind an explicit "Advanced" affordance
 *                but never removed.
 * - "advanced" : the historical full surface — every analytics card
 *                and every portfolio tab at depth 0.
 *
 * Persisted in localStorage so the choice survives reloads, and
 * broadcast on a window event so every mounted consumer (header,
 * home, portfolio page) stays in sync without a global store.
 */
export type ExperienceLevel = "simple" | "standard" | "advanced";

const KEY = "aegis.experienceLevel";
const EVENT = "aegis:experience-level";

const LEVELS: ReadonlyArray<ExperienceLevel> = ["simple", "standard", "advanced"];

function read(): ExperienceLevel {
  if (typeof window === "undefined") return "simple";
  const raw = window.localStorage.getItem(KEY) as ExperienceLevel | null;
  return raw && LEVELS.includes(raw) ? raw : "simple";
}

export function useExperienceLevel(): [ExperienceLevel, (v: ExperienceLevel) => void] {
  const [level, setLevel] = useState<ExperienceLevel>("simple");

  // Read after mount only — reading localStorage during the initial
  // render would hydration-mismatch against the SSR/prerender pass.
  useEffect(() => {
    setLevel(read());
    const onChange = () => setLevel(read());
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const set = useCallback((v: ExperienceLevel) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(KEY, v);
      window.dispatchEvent(new Event(EVENT));
    }
    setLevel(v);
  }, []);

  return [level, set];
}

/** Convenience read-only helper for components that only gate rendering. */
export function useIsAdvanced(): boolean {
  const [level] = useExperienceLevel();
  return level === "advanced";
}
