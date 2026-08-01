import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Progressive disclosure wrapper. Advanced analytics are never
 * deleted — they collapse to a single low-contrast row that states,
 * in plain English, what's inside. Expert users flip the whole app to
 * "Advanced" (see use-experience-level) and these open by default.
 *
 * Children stay unmounted while collapsed (so lazy/Suspense cards don't
 * fetch until asked for), but a short exit animation keeps the close
 * feeling smooth on phones instead of snapping shut.
 */
const CLOSE_MS = 180;

export function AdvancedSection({
  title,
  summary,
  defaultOpen = false,
  children,
  className = "",
}: {
  /** Plain-English label, e.g. "Deeper analysis". */
  title: string;
  /** One line describing what's inside, so nobody has to open it to find out. */
  summary: string;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const toggle = () => {
    if (open) {
      setOpen(false);
      setClosing(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setClosing(false), CLOSE_MS);
    } else {
      if (timer.current) clearTimeout(timer.current);
      setClosing(false);
      setOpen(true);
    }
  };

  const rendered = open || closing;

  return (
    <section className={`rounded-2xl border border-border/60 bg-surface-2/40 ${className}`}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl px-3 py-3 text-left transition-colors hover:bg-surface-3/50 sm:px-4"
      >
        <span className="min-w-0">
          <span className="block font-display text-sm font-semibold tracking-tight">{title}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{summary}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span aria-hidden>{open ? "Hide" : "Show"}</span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
            aria-hidden
          />
        </span>
      </button>
      {rendered && (
        <div
          hidden={!open}
          className={`space-y-4 border-t border-border/60 p-3 sm:p-4 ${
            open
              ? "animate-in fade-in slide-in-from-top-1 duration-200 ease-out"
              : "animate-out fade-out slide-out-to-top-1 duration-150 ease-in"
          }`}
        >
          {children}
        </div>
      )}
    </section>
  );
}
