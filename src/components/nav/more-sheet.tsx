import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Search, X } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { AREAS, searchDestinations, type Destination } from "@/components/nav/destinations";

/**
 * Every destination in the app, grouped by area and searchable.
 *
 * This is the fix for the orphan-route problem: pages like
 * /broker-blocks, /spillover or /hedge-fallbacks used to be reachable
 * only through an in-card link you had to already know about.
 */
export function MoreSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => searchDestinations(query), [query]);

  const grouped = AREAS.map((a) => ({
    ...a,
    items: matches.filter((d) => d.area === a.id),
  })).filter((g) => g.items.length > 0);

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setQuery("");
      }}
    >
      <SheetContent
        side="bottom"
        className="max-h-[85vh] overflow-y-auto rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader className="sticky top-0 z-10 border-b border-border bg-surface-2/95 px-4 py-3 text-left backdrop-blur">
          <SheetTitle className="text-base">Go to…</SheetTitle>
          <div className="relative mt-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search every page"
              aria-label="Search destinations"
              className="h-11 w-full rounded-lg border border-border bg-surface-sunken pl-9 pr-9 text-sm outline-none focus:border-primary"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </SheetHeader>

        <div className="px-3 pb-6 pt-2">
          {grouped.length === 0 && (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">
              Nothing matches “{query}”.
            </p>
          )}
          {grouped.map((group) => (
            <section key={group.id} className="mb-3">
              <h3 className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label}
              </h3>
              <ul className="grid gap-1">
                {group.items.map((d) => (
                  <li key={d.to}>
                    <Row d={d} onNavigate={() => onOpenChange(false)} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Row({ d, onNavigate }: { d: Destination; onNavigate: () => void }) {
  const Icon = d.icon;
  return (
    <Link
      to={d.to as never}
      onClick={onNavigate}
      className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-muted [&.active]:bg-primary/10"
      activeOptions={d.exact ? { exact: true } : undefined}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-surface-sunken text-primary">
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{d.label}</span>
        <span className="block truncate text-xs text-muted-foreground">{d.hint}</span>
      </span>
    </Link>
  );
}
