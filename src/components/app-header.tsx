import { useState } from "react";
import { Link } from "@tanstack/react-router";
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
  TrendingUp,
  Shield,
  GitCompare,
  Sparkles,
  Plug,
  BookOpen,
  Menu,
  RefreshCw,
  LogOut,
} from "lucide-react";

const NAV = [
  { to: "/get-started", label: "Get started", icon: Sparkles },
  { to: "/learn", label: "Learn", icon: BookOpen },
  { to: "/compare", label: "Compare", icon: GitCompare },
  { to: "/saxo-status", label: "Broker", icon: Plug },
] as const;

const MOBILE_EXTRAS = [
  { to: "/saxo-reconnect", label: "Reconnect broker", icon: RefreshCw },
] as const;

export function AppHeader({ email }: { email?: string | null }) {
  const [open, setOpen] = useState(false);

  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
        <Link
          to="/"
          className="flex min-w-0 flex-1 items-center gap-2 font-semibold tracking-tight"
        >
          <TrendingUp className="h-5 w-5 shrink-0 text-primary" />
          <span className="truncate">Aegis</span>
          <span className="hidden text-xs font-normal text-muted-foreground sm:inline">
            AI Paper Trader
          </span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 text-sm md:flex">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground [&.active]:bg-muted [&.active]:text-foreground"
            >
              <Icon className="h-4 w-4" />
              <span>{label}</span>
            </Link>
          ))}
          <Link
            to="/admin"
            className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1.5 font-medium text-primary hover:bg-primary/20 [&.active]:bg-primary [&.active]:text-primary-foreground"
          >
            <Shield className="h-4 w-4" />
            <span>Admin</span>
          </Link>
        </nav>

        <div className="hidden items-center gap-3 text-sm md:flex">
          {email && (
            <span className="hidden max-w-[180px] truncate text-muted-foreground lg:inline">
              {email}
            </span>
          )}
          {email ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await supabase.auth.signOut();
              }}
            >
              Sign out
            </Button>
          ) : null}
        </div>

        {/* Mobile: Admin + hamburger */}
        <div className="flex shrink-0 items-center gap-1 md:hidden">
          <Link
            to="/admin"
            aria-label="Admin"
            className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 [&.active]:bg-primary [&.active]:text-primary-foreground"
          >
            <Shield className="h-4 w-4" />
          </Link>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10"
                aria-label="Open menu"
              >
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[85vw] max-w-sm p-0">
              <SheetHeader className="border-b border-border px-4 py-4 text-left">
                <SheetTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-primary" />
                  Aegis
                </SheetTitle>
                {email && (
                  <p className="truncate text-xs text-muted-foreground">{email}</p>
                )}
              </SheetHeader>
              <nav className="flex flex-col gap-1 p-3 text-sm">
                {NAV.map(({ to, label, icon: Icon }) => (
                  <Link
                    key={to}
                    to={to}
                    onClick={() => setOpen(false)}
                    className="inline-flex items-center gap-3 rounded-md px-3 py-3 text-foreground hover:bg-muted [&.active]:bg-muted [&.active]:text-foreground"
                  >
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span>{label}</span>
                  </Link>
                ))}
                {MOBILE_EXTRAS.map(({ to, label, icon: Icon }) => (
                  <Link
                    key={to}
                    to={to}
                    onClick={() => setOpen(false)}
                    className="inline-flex items-center gap-3 rounded-md px-3 py-3 text-foreground hover:bg-muted [&.active]:bg-muted [&.active]:text-foreground"
                  >
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <span>{label}</span>
                  </Link>
                ))}
                <Link
                  to="/admin"
                  onClick={() => setOpen(false)}
                  className="mt-1 inline-flex items-center gap-3 rounded-md border border-primary/40 bg-primary/10 px-3 py-3 font-medium text-primary hover:bg-primary/20 [&.active]:bg-primary [&.active]:text-primary-foreground"
                >
                  <Shield className="h-4 w-4" />
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
      <div className="border-t border-border/60 bg-background/60 px-4 py-1.5 text-center text-[11px] leading-tight text-muted-foreground sm:text-xs">
        Simulation only. Past performance does not predict future results. Do not use for real investment decisions.
      </div>
    </header>
  );
}
