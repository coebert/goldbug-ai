import { Link, useRouterState } from "@tanstack/react-router";
import { Home, Receipt, BookOpen, MoreHorizontal, Newspaper, Plus } from "lucide-react";

type Tab = {
  to: "/" | "/trades" | "/learn";
  label: string;
  icon: typeof Home;
  exact?: boolean;
};

/**
 * Task-oriented bottom nav. Four tabs plus a raised centre "+" that
 * drops the user into "New portfolio" on the home page. The "More"
 * tab opens a lightweight sheet-like anchor to secondary destinations
 * (kept as a route link for now; deeper redesign lands in Phase 6).
 */
const LEFT: Tab[] = [
  { to: "/", label: "Home", icon: Home, exact: true },
  { to: "/trades", label: "Trades", icon: Receipt },
];
const RIGHT: Tab[] = [
  { to: "/learn", label: "Learn", icon: BookOpen },
];

const HIDDEN_PREFIXES = ["/auth"];

export function MobileTabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) return null;

  const item = (t: Tab) => (
    <Link
      key={t.to}
      to={t.to}
      activeOptions={t.exact ? { exact: true } : undefined}
      className="flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground [&.active]:text-primary"
    >
      <t.icon className="h-5 w-5" aria-hidden="true" />
      <span className="leading-none">{t.label}</span>
    </Link>
  );

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 md:hidden"
    >
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-background/95 via-background/60 to-transparent" />
      <div
        className="relative mx-auto flex max-w-lg items-stretch gap-1 border-t border-border bg-card/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur"
      >
        {LEFT.map(item)}

        {/* Raised primary action — routes to the home page create-
            portfolio anchor. Sits half-outside the bar for prominence. */}
        <Link
          to="/"
          hash="create-portfolio"
          aria-label="New portfolio"
          className="relative -mt-5 flex h-14 w-14 shrink-0 items-center justify-center self-center rounded-full bg-primary text-primary-foreground shadow-[0_8px_20px_-6px_color-mix(in_oklab,var(--primary)_60%,transparent)] transition-transform active:scale-95"
        >
          <Plus className="h-6 w-6" aria-hidden="true" />
        </Link>

        {RIGHT.map(item)}

        <Link
          to="/compare"
          aria-label="More destinations"
          className="flex min-h-[52px] flex-1 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground [&.active]:text-primary"
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
          <span className="leading-none">More</span>
        </Link>
      </div>
    </nav>
  );
}
