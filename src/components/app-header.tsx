import { useEffect, useRef, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  TrendingUp,
  Shield,
  GitCompare,
  Sparkles,
  Plug,
  BookOpen,
  Menu,
  RefreshCw,
  LogOut,
  Receipt,
  ChevronRight,
  User as UserIcon,
  PlusCircle,
  Banknote,
  Settings as SettingsIcon,
} from "lucide-react";
import { NotificationsBell } from "@/components/notifications-bell";
import { HelpDrawer } from "@/components/help-drawer";
import { CommandPalette } from "@/components/command-palette";
import { UkClock } from "@/components/uk-clock";
import { EnvBadge } from "@/components/env-badge";
import { PRIMARY } from "@/components/nav/destinations";

/** Primary destinations, shared with the mobile tab bar and desktop rail. */
const NAV: ReadonlyArray<{
  to: string;
  label: string;
  icon: typeof TrendingUp;
  exact?: boolean;
}> = PRIMARY.map((d) => ({ to: d.to, label: d.label, icon: d.icon, exact: d.exact }));


const MOBILE_EXTRAS = [
  { to: "/get-started", label: "Get started", icon: Sparkles },
  { to: "/saxo-reconnect", label: "Reconnect broker", icon: RefreshCw },
] as const;

/**
 * Route-aware label used in the context row breadcrumb. Falls back
 * to a stripped-down version of the pathname for unknown routes so
 * users still get an anchor.
 */
function useCrumb() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (pathname === "/") return { title: "Portfolios", subtitle: "Your dashboard" };
  if (pathname.startsWith("/trades")) return { title: "Trades", subtitle: "Executed & pending" };
  if (pathname.startsWith("/compare")) return { title: "Compare", subtitle: "Side-by-side" };
  if (pathname.startsWith("/learn")) return { title: "Learn", subtitle: "Concepts & guides" };
  if (pathname.startsWith("/saxo-status")) return { title: "Broker", subtitle: "Saxo connection" };
  if (pathname.startsWith("/saxo-reconnect")) return { title: "Reconnect broker", subtitle: "OAuth flow" };
  if (pathname.startsWith("/admin")) return { title: "Admin", subtitle: "System controls" };
  if (pathname.startsWith("/get-started")) return { title: "Get started", subtitle: "3-step demo" };
  if (pathname.startsWith("/portfolio/")) return { title: "Portfolio", subtitle: "Detail view" };
  if (pathname.startsWith("/long-horizon/")) return { title: "Long-horizon", subtitle: "Report" };
  return { title: pathname.replace(/^\//, "") || "Aegis", subtitle: null as string | null };
}

/**
 * Route-scoped secondary actions surfaced in the right side of the
 * context row. Kept intentionally small (max 3) — deeper actions
 * belong inside the page body or the command palette.
 */
function useContextActions() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (pathname === "/") {
    return (
      <>
        <Link to="/get-started" className="hidden sm:inline-flex">
          <Button variant="ghost" size="sm">
            <Sparkles className="mr-1.5 h-4 w-4" /> £1000 demo
          </Button>
        </Link>
        <Link to="/saxo-status" className="hidden md:inline-flex">
          <Button variant="ghost" size="sm">
            <Banknote className="mr-1.5 h-4 w-4" /> Real money
          </Button>
        </Link>
        <Link to="/" hash="create-portfolio">
          <Button size="sm">
            <PlusCircle className="mr-1.5 h-4 w-4" /> New portfolio
          </Button>
        </Link>
      </>
    );
  }
  if (pathname.startsWith("/portfolio/")) {
    return (
      <Link to="/">
        <Button variant="ghost" size="sm">
          <ChevronRight className="mr-1 h-4 w-4 rotate-180" /> All portfolios
        </Button>
      </Link>
    );
  }
  return null;
}

export function AppHeader({ email }: { email?: string | null }) {
  const [open, setOpen] = useState(false);
  const crumb = useCrumb();
  const contextActions = useContextActions();
  const headerRef = useRef<HTMLElement | null>(null);

  // Publish the measured header height as --app-header-h so every sticky
  // sub-nav (portfolio tabs, leaf back rows) lines up exactly beneath it,
  // including on notched devices where the safe-area padding varies.
  useEffect(() => {
    const el = headerRef.current;
    if (!el || typeof window === "undefined") return;
    const apply = () => {
      document.documentElement.style.setProperty(
        "--app-header-h",
        `${Math.round(el.getBoundingClientRect().height)}px`,
      );
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <header
      ref={headerRef}
      className="sticky top-0 z-30 border-b border-border bg-surface-2/85 pt-[env(safe-area-inset-top)] backdrop-blur"
    >
      {/* Row 1 — Brand / global controls */}
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5 2xl:max-w-7xl">
        <Link
          to="/"
          className="flex shrink-0 items-center gap-2 font-semibold tracking-tight"
        >
          <span className="grid h-8 w-8 place-items-center rounded-md bg-primary/15 text-primary">
            <TrendingUp className="h-4 w-4" />
          </span>
          <span className="font-display text-lg leading-none">Aegis</span>
          <EnvBadge />
        </Link>

        <div className="flex flex-1 items-center justify-end gap-2">
          <CommandPalette enabled={!!email} />
          <UkClock />
          <span data-coach="help-button">
            <HelpDrawer />
          </span>
          {email && <NotificationsBell />}

          {email ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 rounded-full border border-border/60 bg-surface-sunken"
                  aria-label="Account menu"
                >
                  <UserIcon className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
                  {email}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/settings" className="flex items-center gap-2">
                    <SettingsIcon className="h-4 w-4" /> Settings & notifications
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/admin" className="flex items-center gap-2">
                    <Shield className="h-4 w-4" /> Admin
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/saxo-reconnect" className="flex items-center gap-2">
                    <RefreshCw className="h-4 w-4" /> Reconnect broker
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={async (e) => {
                    e.preventDefault();
                    await supabase.auth.signOut();
                  }}
                  className="flex items-center gap-2 text-muted-foreground focus:text-foreground"
                >
                  <LogOut className="h-4 w-4" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {/* Mobile hamburger — nav only, account/actions stay in the
              existing controls above. */}
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 md:hidden"
                aria-label="Open navigation menu"
              >
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[85vw] max-w-sm p-0">
              <SheetHeader className="border-b border-border px-4 py-4 text-left">
                <SheetTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-primary" />
                  <span className="font-display">Aegis</span>
                </SheetTitle>
                {email && (
                  <p className="truncate text-xs text-muted-foreground">{email}</p>
                )}
              </SheetHeader>
              <nav className="flex flex-col gap-1 p-3 text-sm">
                {NAV.map(({ to, label, icon: Icon, exact }) => (
                  <Link
                    key={to}
                    to={to as never}
                    activeOptions={exact ? { exact: true } : undefined}
                    onClick={() => setOpen(false)}
                    className="inline-flex items-center gap-3 rounded-md px-3 py-3 text-foreground hover:bg-muted [&.active]:bg-muted [&.active]:text-foreground"
                  >
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span>{label}</span>
                  </Link>
                ))}
                <div className="my-2 h-px bg-border" />
                {MOBILE_EXTRAS.map(({ to, label, icon: Icon }) => (
                  <Link
                    key={to}
                    to={to}
                    onClick={() => setOpen(false)}
                    className="inline-flex items-center gap-3 rounded-md px-3 py-3 text-foreground hover:bg-muted"
                  >
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span>{label}</span>
                  </Link>
                ))}
                <Link
                  to="/settings"
                  onClick={() => setOpen(false)}
                  className="inline-flex items-center gap-3 rounded-md px-3 py-3 text-foreground hover:bg-muted"
                >
                  <SettingsIcon className="h-4 w-4 text-muted-foreground" />
                  <span>Settings & notifications</span>
                </Link>
                <Link
                  to="/admin"
                  onClick={() => setOpen(false)}
                  className="inline-flex items-center gap-3 rounded-md px-3 py-3 text-foreground hover:bg-muted"
                >
                  <Shield className="h-4 w-4 text-muted-foreground" />
                  <span>Admin</span>
                </Link>
                {email && (
                  <button
                    type="button"
                    onClick={async () => {
                      setOpen(false);
                      await supabase.auth.signOut();
                    }}
                    className="mt-3 inline-flex items-center gap-3 rounded-md px-3 py-3 text-left text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <LogOut className="h-4 w-4" />
                    <span>Sign out</span>
                  </button>
                )}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      {/* Row 2 — Context nav: primary destinations + route breadcrumb
          + route-scoped actions. Hidden on mobile — the floating tab
          bar covers primary destinations there. */}
      <div className="border-t border-border/60 bg-surface-1/60">
        <div className="mx-auto hidden max-w-6xl items-center gap-1 px-4 py-1.5 md:flex lg:hidden 2xl:max-w-7xl">
          <nav
            aria-label="Primary"
            className="flex flex-1 items-center gap-1 text-sm"
          >
            {NAV.map(({ to, label, icon: Icon, exact }) => (
              <Link
                key={to}
                to={to as never}
                activeOptions={exact ? { exact: true } : undefined}
                className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&.active]:bg-primary/10 [&.active]:text-primary"
              >
                <Icon className="h-4 w-4" />
                <span>{label}</span>
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="hidden lg:inline">{crumb.title}</span>
            {crumb.subtitle && (
              <>
                <ChevronRight className="hidden h-3 w-3 opacity-60 lg:inline" />
                <span className="hidden lg:inline">{crumb.subtitle}</span>
              </>
            )}
            <div className="ml-2 flex items-center gap-1">{contextActions}</div>
          </div>
        </div>

        {/* Mobile row: breadcrumb + context actions only. Primary nav
            lives in the floating tab bar. */}
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-1.5 md:hidden 2xl:max-w-7xl">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{crumb.title}</div>
            {crumb.subtitle && (
              <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
                {crumb.subtitle}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">{contextActions}</div>
        </div>
      </div>

      <div className="border-t border-border/60 bg-background/60 px-4 py-1 text-center text-[10px] leading-tight text-muted-foreground sm:text-[11px]">
        Simulation only. Past performance does not predict future results. Do not use for real investment decisions.
      </div>
    </header>
  );
}
