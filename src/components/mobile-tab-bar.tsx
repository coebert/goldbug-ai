import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import { usePrefetchOnTouch } from "@/hooks/use-idle-prefetch";
import { PRIMARY, areaForPath } from "@/components/nav/destinations";
import { MoreSheet } from "@/components/nav/more-sheet";

const HIDDEN_PREFIXES = ["/auth"];

/**
 * Frosted floating pill with five *real* tabs, generated from the
 * shared destination registry, plus a More button that opens the
 * full destination sheet (it used to silently navigate to /compare).
 *
 * The raised "+" is gone: creating a portfolio is a rare action and
 * no longer earns a prime tap target — it lives in the Home header.
 */
export function MobileTabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const prefetchOnTouch = usePrefetchOnTouch();
  const [moreOpen, setMoreOpen] = useState(false);

  if (HIDDEN_PREFIXES.some((p) => pathname.startsWith(p))) return null;

  const activeArea = areaForPath(pathname);

  return (
    <>
      <nav
        aria-label="Primary"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-2 md:hidden"
        style={{
          paddingBottom: "max(0.5rem, min(env(safe-area-inset-bottom), 1.25rem))",
        }}
      >
        <div className="floating-nav pointer-events-auto mx-auto flex max-w-md items-stretch gap-0.5 rounded-full px-1.5 py-1.5">
          {PRIMARY.map((d) => {
            const Icon = d.icon;
            const active = activeArea === d.area;
            return (
              <Link
                key={d.to}
                to={d.to as never}
                onTouchStart={() => prefetchOnTouch({ to: d.to as never })}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[10px] transition-colors ${
                  active ? "text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                <span className="max-w-full truncate leading-none">{d.tabLabel ?? d.label}</span>
              </Link>
            );
          })}

          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-label="More destinations"
            aria-haspopup="dialog"
            className="flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <MoreHorizontal className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span className="leading-none">More</span>
          </button>
        </div>
      </nav>

      <MoreSheet open={moreOpen} onOpenChange={setMoreOpen} />
    </>
  );
}
