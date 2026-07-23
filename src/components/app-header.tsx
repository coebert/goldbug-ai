import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { TrendingUp, Shield, GitCompare, Sparkles, Plug, BookOpen } from "lucide-react";

export function AppHeader({ email }: { email?: string | null }) {
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <TrendingUp className="h-5 w-5 text-primary" />
          <span>Aegis</span>
          <span className="hidden text-xs font-normal text-muted-foreground sm:inline">AI Paper Trader</span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <Link
            to="/get-started"
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground [&.active]:bg-muted [&.active]:text-foreground"
          >
            <Sparkles className="h-4 w-4" />
            <span className="hidden sm:inline">Get started</span>
          </Link>
          <Link
            to="/learn"
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground [&.active]:bg-muted [&.active]:text-foreground"
          >
            <BookOpen className="h-4 w-4" />
            <span className="hidden sm:inline">Learn</span>
          </Link>
          <Link
            to="/compare"
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground [&.active]:bg-muted [&.active]:text-foreground"
          >
            <GitCompare className="h-4 w-4" />
            <span className="hidden sm:inline">Compare</span>
          </Link>
          <Link
            to="/saxo-status"
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground [&.active]:bg-muted [&.active]:text-foreground"
          >
            <Plug className="h-4 w-4" />
            <span className="hidden sm:inline">Saxo</span>
          </Link>
          <Link
            to="/saxo-reconnect"
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground [&.active]:bg-muted [&.active]:text-foreground"
          >
            <span className="hidden sm:inline">Reconnect</span>
          </Link>
          <Link
            to="/admin"
            className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1.5 font-medium text-primary hover:bg-primary/20 [&.active]:bg-primary [&.active]:text-primary-foreground"
          >
            <Shield className="h-4 w-4" />
            <span>Admin</span>
          </Link>
        </nav>
        <div className="flex items-center gap-3 text-sm">
          {email && <span className="hidden text-muted-foreground md:inline">{email}</span>}
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
      </div>
      <div className="border-t border-border/60 bg-background/60 px-4 py-1.5 text-center text-xs text-muted-foreground">
        Simulation only. Past performance does not predict future results. Do not use for real investment decisions.
      </div>
    </header>
  );
}
