import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Reusable dashboard section heading. Consistent icon + title + optional
 * one-line description + trailing slot. Standardises the "briefing" feel
 * of the home page (Phase 3 IA polish).
 */
export function SectionHeader({
  icon: Icon,
  title,
  description,
  trailing,
  as: As = "h2",
  className = "",
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  trailing?: ReactNode;
  as?: "h2" | "h3";
  className?: string;
}) {
  return (
    <div className={`mb-3 flex items-start justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        <As className="flex items-center gap-2 font-display text-sm font-semibold tracking-tight text-foreground sm:text-base">
          {Icon ? <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" /> : null}
          <span className="truncate">{title}</span>
        </As>
        {description ? (
          <p className="mt-0.5 text-xs text-muted-foreground sm:text-[13px]">{description}</p>
        ) : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
}
