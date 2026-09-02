import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useCardOpen, type CardLevel } from "@/lib/card-level";

/**
 * The one card.
 *
 * Every panel in the app renders through this so the whole surface
 * shares a header shape, a spacing rhythm, a stable scroll anchor and
 * the same three-level detail model:
 *
 *   answer   — always visible, one line and one number
 *   body     — the evidence (chart / table), open by level
 *   workings — diagnostics and raw rows, always behind a disclosure
 *
 * Nothing is ever removed: at "Simple" the body collapses to a single
 * tappable row that says what's inside, it does not disappear.
 */
export function CardShell({
  anchor,
  title,
  subtitle,
  answer,
  actions,
  level = 2,
  workings,
  workingsLabel = "Show workings",
  children,
  className = "",
  bodyClassName = "",
}: {
  /** Stable DOM id — also the entry in `src/lib/card-catalog.ts`. */
  anchor: string;
  title: ReactNode;
  /** One line saying what the card answers. */
  subtitle?: ReactNode;
  /** The headline answer, rendered even when the body is collapsed. */
  answer?: ReactNode;
  actions?: ReactNode;
  /** Detail level of the body: 1 always open, 2 standard, 3 expert. */
  level?: CardLevel;
  /** Level-3 content: parameters, diagnostics, raw rows. */
  workings?: ReactNode;
  workingsLabel?: string;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const [open, setOpen] = useCardOpen(anchor, level);
  const [workingsOpen, setWorkingsOpen] = useCardOpen(`${anchor}:workings`, 3);
  const collapsible = level > 1 && !!children;

  return (
    <section
      id={anchor}
      data-card={anchor}
      className={`scroll-below-sticky rounded-2xl bg-surface-2 shadow-card transition-shadow duration-150 hover:shadow-card-hover ${className}`}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-4 pt-4 sm:px-5">
        <div className="min-w-0">
          <h3 className="truncate font-display text-sm font-semibold tracking-tight">{title}</h3>
          {subtitle && (
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>

      {answer && <div className="px-4 pt-3 sm:px-5">{answer}</div>}

      {children && (open || !collapsible) && (
        <div className={`px-4 pb-4 pt-3 sm:px-5 ${bodyClassName}`}>{children}</div>
      )}

      {collapsible && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={`${anchor}-body`}
          className="flex min-h-11 w-full items-center justify-between gap-2 rounded-b-2xl px-4 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-3/50 hover:text-foreground sm:px-5"
        >
          <span>{open ? "Hide detail" : "Show detail"}</span>
          <ChevronDown
            className={`h-4 w-4 shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
            aria-hidden
          />
        </button>
      )}

      {workings && (
        <>
          <button
            type="button"
            onClick={() => setWorkingsOpen(!workingsOpen)}
            aria-expanded={workingsOpen}
            className="flex min-h-11 w-full items-center justify-between gap-2 border-t border-border/50 px-4 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-3/50 hover:text-foreground sm:px-5"
          >
            <span>{workingsOpen ? "Hide workings" : workingsLabel}</span>
            <ChevronDown
              className={`h-4 w-4 shrink-0 transition-transform duration-150 ${workingsOpen ? "rotate-180" : ""}`}
              aria-hidden
            />
          </button>
          {workingsOpen && (
            <div className="border-t border-border/50 bg-surface-sunken/60 px-4 py-4 text-xs sm:px-5">
              {workings}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Honest empty state: says what happened and what to do next. */
export function CardEmpty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-xl bg-surface-sunken px-4 py-6 text-sm">
      <p className="font-medium">{title}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {action}
    </div>
  );
}

/** Error state with a retry rather than a blank card. */
export function CardError({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-xl border border-destructive-soft bg-destructive-soft/30 px-4 py-4 text-sm">
      <p className="font-medium text-destructive">Couldn't load this</p>
      <p className="text-xs text-muted-foreground">{message ?? "The request failed."}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-9 rounded-md bg-surface-3 px-3 text-xs font-medium hover:bg-surface-3/80"
        >
          Try again
        </button>
      )}
    </div>
  );
}
