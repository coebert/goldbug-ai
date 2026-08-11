// Side panel listing every pinned market, with quick jump-to-chart, reorder
// and unpin actions. Pin state itself lives in the SMA card, which owns
// persistence; this panel is a pure view over it.

import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, LineChart, Star, StarOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { symbolMeta } from "@/lib/market-symbol-history";

export function FavoritesPanel({
  favorites,
  onUnpin,
  onMove,
}: {
  favorites: readonly string[];
  onUnpin: (symbol: string) => void;
  onMove: (symbol: string, direction: "up" | "down") => void;
}) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 px-2.5 text-xs">
          <Star className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          Pinned ({favorites.length})
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>Pinned markets</SheetTitle>
          <SheetDescription>
            Jump straight to a chart, reorder the sequence, or unpin.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-2">
          {favorites.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No pinned markets yet — tap the star beside a market to pin it here.
            </p>
          )}
          {favorites.map((s, i) => {
            const label = symbolMeta(s)?.label ?? s;
            return (
              <div
                key={s}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-1.5"
              >
                <span className="w-5 shrink-0 text-xs tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <Link
                  to="/market/$symbol"
                  params={{ symbol: s }}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-sm hover:text-primary"
                >
                  <LineChart className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{label}</span>
                </Link>
                <button
                  type="button"
                  aria-label={`Move ${label} up`}
                  disabled={i === 0}
                  onClick={() => onMove(s, "up")}
                  className="rounded p-1 text-muted-foreground hover:text-primary disabled:opacity-30"
                >
                  <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${label} down`}
                  disabled={i === favorites.length - 1}
                  onClick={() => onMove(s, "down")}
                  className="rounded p-1 text-muted-foreground hover:text-primary disabled:opacity-30"
                >
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`Unpin ${label}`}
                  onClick={() => onUnpin(s)}
                  className="rounded p-1 text-muted-foreground hover:text-destructive"
                >
                  <StarOff className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
