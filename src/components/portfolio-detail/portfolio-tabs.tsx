import { Link } from "@tanstack/react-router";

/**
 * Sticky sub-navigation tying the portfolio detail page together with
 * its five sibling report routes. Horizontally scrollable on phones,
 * so every tab stays reachable without wrapping the row.
 */
const TABS = [
  { to: "/portfolio/$id", label: "Overview", exact: true },
  { to: "/portfolio/$id/summary", label: "Summary" },
  { to: "/portfolio/$id/trade", label: "Trade" },
  { to: "/portfolio/$id/risk", label: "Risk" },
  { to: "/portfolio/$id/attribution", label: "Attribution" },
  { to: "/portfolio/$id/analytics", label: "Analytics" },
  { to: "/portfolio/$id/optimizer", label: "Optimizer" },
  { to: "/portfolio/$id/report", label: "Report" },
  { to: "/portfolio/$id/sma-report", label: "SMA report" },
] as const;

export function PortfolioTabs({ id }: { id: string }) {
  return (
    <nav
      aria-label="Portfolio sections"
      data-sticky-nav
      className="sticky top-[var(--app-header-h)] z-20 -mx-4 mb-4 h-[var(--subnav-h,3.25rem)] border-b border-border bg-surface-1 px-4"
    >
      <ul className="flex h-full min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map((t) => (
          <li key={t.to} className="shrink-0">
            <Link
              to={t.to}
              params={{ id }}
              activeOptions={"exact" in t && t.exact ? { exact: true } : undefined}
              className="inline-flex h-11 items-center whitespace-nowrap rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&.active]:bg-primary/10 [&.active]:text-primary"
            >

              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
