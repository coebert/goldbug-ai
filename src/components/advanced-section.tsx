import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Progressive disclosure wrapper. Advanced analytics are never
 * deleted — they collapse to a single low-contrast row that states,
 * in plain English, what's inside. Expert users flip the whole app to
 * "Advanced" (see use-experience-level) and these open by default.
 */
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

  return (
    <section className={`rounded-2xl border border-border/60 bg-surface-2/40 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 rounded-2xl px-3 py-3 text-left sm:px-4 transition-colors hover:bg-surface-3/50"
      >
        <span className="min-w-0">
          <span className="block font-display text-sm font-semibold tracking-tight">{title}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{summary}</span>
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open && <div className="space-y-4 border-t border-border/60 p-3 sm:p-4">{children}</div>}
    </section>
  );
}
