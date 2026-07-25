import { Link, useRouterState } from "@tanstack/react-router";
import { Home, Receipt, BookOpen, MoreHorizontal, Plus } from "lucide-react";

type Tab = {
  to: "/" | "/trades" | "/learn";
  label: string;
  icon: typeof Home;
  exact?: boolean;
};

/**
 * Phase 6 — Frosted floating pill.
 *
 * Task-oriented bottom nav. Four tabs plus a raised centre "+" that
 * routes to the "New portfolio" anchor. The bar itself is a
 * rounded-full frosted pill floating above the safe area so it
 * reads as a raised control rather than a fixed footer stripe.
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
      className="flex min-h-[52px] min-w-[56px] flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[11px] text-muted-foreground transition-colors hover:text-foreground [&.active]:text-primary"
    >
      <t.icon className="h-5 w-5" aria-hidden="true" />
      <span className="leading-none">{t.label}</span>
    </Link>
  );

  return (
    <nav
      aria-label="Primary"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-3 md:hidden"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.5rem)" }}
    >
      <div className="pointer-events-auto mx-auto flex max-w-md items-stretch gap-1 rounded-full px-2 py-1.5 floating-nav">
        {LEFT.map(item)}

        {/* Raised primary action — routes to the create-portfolio anchor. */}
        <Link
          to="/"
          hash="create-portfolio"
          aria-label="New portfolio"
          className="relative -mt-4 flex h-14 w-14 shrink-0 items-center justify-center self-center rounded-full bg-primary text-primary-foreground shadow-[0_10px_24px_-8px_color-mix(in_oklab,var(--primary)_65%,transparent)] transition-transform active:scale-95"
        >
          <Plus className="h-6 w-6" aria-hidden="true" />
        </Link>

        {RIGHT.map(item)}

        <Link
          to="/compare"
          aria-label="More destinations"
          className="flex min-h-[52px] min-w-[56px] flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[11px] text-muted-foreground transition-colors hover:text-foreground [&.active]:text-primary"
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
          <span className="leading-none">More</span>
        </Link>
      </div>
    </nav>
  );
}
