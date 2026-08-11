import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Home,
  Receipt,
  GitCompare,
  BookOpen,
  Plug,
  Shield,
  Sparkles,
  PlusCircle,
  RefreshCw,
  LogOut,
  Briefcase,
  Grid3x3,
} from "lucide-react";
import { listPortfolios } from "@/lib/trading.functions";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { qk } from "@/lib/query-keys";

/**
 * Global Cmd/Ctrl-K command palette. Provides fast access to every
 * primary destination, direct portfolio jumps, and a handful of
 * high-frequency actions ("New portfolio", "Reconnect broker",
 * "Sign out"). Opens from anywhere via keyboard or from the search
 * pill in the header.
 */
export function CommandPalette({
  enabled = true,
  triggerClassName,
}: {
  enabled?: boolean;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const list = useServerFn(listPortfolios);
  const q = useQuery({
    queryKey: qk.portfolios.list(),
    queryFn: () => list(),
    enabled: enabled && open,
    staleTime: 60_000,
  });

  const portfolios = useMemo(
    () => (q.data ?? []) as Array<{ id: string; name: string; mode: string }>,
    [q.data],
  );

  const go = (fn: () => void) => {
    setOpen(false);
    // Defer so the dialog can unmount before route changes.
    setTimeout(fn, 0);
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className={
          triggerClassName ??
          "hidden h-9 min-w-[220px] justify-between gap-3 border-border/70 bg-surface-sunken text-muted-foreground hover:text-foreground md:inline-flex"
        }
        aria-label="Open command palette (Ctrl+K)"
        data-shortcut="command-palette-trigger"
      >
        <span className="flex items-center gap-2 text-sm">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          Search or jump to…
        </span>
        <kbd className="pointer-events-none inline-flex select-none items-center gap-1 rounded border border-border/70 bg-background px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
          ⌘K
        </kbd>
      </Button>

      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput placeholder="Type a command or search portfolios…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>

          <CommandGroup heading="Go to">
            <CommandItem onSelect={() => go(() => navigate({ to: "/" }))}>
              <Home className="mr-2 h-4 w-4" /> Home
              <CommandShortcut>g h</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => go(() => navigate({ to: "/trades" }))}>
              <Receipt className="mr-2 h-4 w-4" /> Trades
              <CommandShortcut>g t</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => go(() => navigate({ to: "/compare" }))}>
              <GitCompare className="mr-2 h-4 w-4" /> Compare portfolios
              <CommandShortcut>g c</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => go(() => navigate({ to: "/learn" }))}>
              <BookOpen className="mr-2 h-4 w-4" /> Learn
              <CommandShortcut>g l</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => go(() => navigate({ to: "/spillover" }))}>
              <Grid3x3 className="mr-2 h-4 w-4" /> Cluster spillover heatmap
            </CommandItem>
            <CommandItem onSelect={() => go(() => navigate({ to: "/saxo-status" }))}>
              <Plug className="mr-2 h-4 w-4" /> Broker status
            </CommandItem>
            <CommandItem onSelect={() => go(() => navigate({ to: "/admin" }))}>
              <Shield className="mr-2 h-4 w-4" /> Admin
            </CommandItem>
          </CommandGroup>

          {portfolios.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Portfolios">
                {portfolios.map((p) => (
                  <CommandItem
                    key={p.id}
                    value={`portfolio ${p.name} ${p.mode}`}
                    onSelect={() =>
                      go(() =>
                        navigate({ to: "/portfolio/$id", params: { id: p.id } }),
                      )
                    }
                  >
                    <Briefcase className="mr-2 h-4 w-4" />
                    <span className="truncate">{p.name}</span>
                    <span className="ml-2 text-[10px] uppercase text-muted-foreground">
                      {p.mode === "live_prod" ? "real" : "sim"}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          <CommandSeparator />
          <CommandGroup heading="Actions">
            <CommandItem
              onSelect={() =>
                go(() => navigate({ to: "/", hash: "create-portfolio" }))
              }
            >
              <PlusCircle className="mr-2 h-4 w-4" /> New portfolio
              <CommandShortcut>n</CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={() => go(() => navigate({ to: "/get-started" }))}>
              <Sparkles className="mr-2 h-4 w-4" /> Start £1000 demo
            </CommandItem>
            <CommandItem
              onSelect={() => go(() => navigate({ to: "/saxo-reconnect" }))}
            >
              <RefreshCw className="mr-2 h-4 w-4" /> Reconnect broker
            </CommandItem>
            <CommandItem
              onSelect={() =>
                go(async () => {
                  await supabase.auth.signOut();
                })
              }
            >
              <LogOut className="mr-2 h-4 w-4" /> Sign out
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
