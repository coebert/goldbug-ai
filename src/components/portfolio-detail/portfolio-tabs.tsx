import { Link } from "@tanstack/react-router";

/**
 * Sticky sub-navigation tying the portfolio detail page together with
 * its five sibling report routes. Horizontally scrollable on phones,
 * so every tab stays reachable without wrapping the row.
 */
const TABS = [
  { to: "/portfolio/$id", label: "Overview", exact: true },
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
      className="sticky top-[3.25rem] z-20 -mx-4 mb-4 border-b border-border bg-surface-1/90 px-4 backdrop-blur"
    >
      <ul className="flex min-w-0 gap-1 overflow-x-auto py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map((t) => (
          <li key={t.to} className="shrink-0">
            <Link
              to={t.to}
              params={{ id }}
              activeOptions={"exact" in t && t.exact ? { exact: true } : undefined}
              className="inline-flex min-h-11 items-center whitespace-nowrap rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&.active]:bg-primary/10 [&.active]:text-primary"
            >
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
