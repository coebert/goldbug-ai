import { Link, useRouterState } from "@tanstack/react-router";
import { Home, GitCompare, Plug, Shield, BookOpen } from "lucide-react";

const TABS = [
  { to: "/", label: "Home", icon: Home, exact: true },
  { to: "/compare", label: "Compare", icon: GitCompare },
  { to: "/saxo-status", label: "Broker", icon: Plug },
  { to: "/learn", label: "Learn", icon: BookOpen },
  { to: "/admin", label: "Admin", icon: Shield },
] as const;

const HIDDEN_PREFIXES = ["/auth"];

export function MobileTabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) return null;

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <ul className="mx-auto grid max-w-lg grid-cols-5">
        {TABS.map(({ to, label, icon: Icon, exact }) => (
          <li key={to}>
            <Link
              to={to}
              activeOptions={exact ? { exact: true } : undefined}
              className="flex min-h-[56px] flex-col items-center justify-center gap-0.5 px-1 py-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground [&.active]:text-primary"
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
              <span className="leading-none">{label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
