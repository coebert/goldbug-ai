import { useCallback, useEffect, useState } from "react";
import { useExperienceLevel, type ExperienceLevel } from "@/lib/use-experience-level";

/**
 * Three levels of detail, applied per card instead of per page.
 *
 *  1 — the answer.   One sentence, one number. Always visible.
 *  2 — the evidence. The chart or table behind it.
 *  3 — the workings. Diagnostics, parameters, raw rows.
 *
 * The global experience level only decides which level is *open by
 * default*; nothing is ever removed, so a card can always be expanded
 * to its full depth. A user's own open/close choice wins over the
 * default and is remembered per card.
 */
export type CardLevel = 1 | 2 | 3;

/** Deepest level opened automatically at each experience setting. */
export function defaultOpenLevel(level: ExperienceLevel): CardLevel {
  if (level === "advanced") return 3;
  if (level === "standard") return 2;
  return 1;
}

const KEY_PREFIX = "aegis.card.";
const EVENT = "aegis:card-open";

function readOverride(anchor: string): boolean | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(KEY_PREFIX + anchor);
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

/**
 * Whether the body of a card at `level` should be open, plus a setter
 * that records the user's explicit choice.
 */
export function useCardOpen(anchor: string, level: CardLevel): [boolean, (v: boolean) => void] {
  const [experience] = useExperienceLevel();
  const auto = level <= defaultOpenLevel(experience);
  const [override, setOverride] = useState<boolean | null>(null);

  // Read after mount only: localStorage during render hydration-mismatches.
  useEffect(() => {
    const read = () => setOverride(readOverride(anchor));
    read();
    window.addEventListener(EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, [anchor]);

  const set = useCallback(
    (v: boolean) => {
      setOverride(v);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(KEY_PREFIX + anchor, v ? "1" : "0");
        window.dispatchEvent(new Event(EVENT));
      }
    },
    [anchor],
  );

  return [override ?? auto, set];
}
