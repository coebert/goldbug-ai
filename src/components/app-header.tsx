import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { TrendingUp } from "lucide-react";

export function AppHeader({ email }: { email?: string | null }) {
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <TrendingUp className="h-5 w-5 text-primary" />
          <span>Aegis</span>
          <span className="text-xs font-normal text-muted-foreground">AI Paper Trader</span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          {email && <span className="hidden text-muted-foreground sm:inline">{email}</span>}
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
