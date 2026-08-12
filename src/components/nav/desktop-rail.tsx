import { useCallback, useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import { PRIMARY, areaForPath } from "@/components/nav/destinations";
import { MoreSheet } from "@/components/nav/more-sheet";

const KEY = "aegis.railCollapsed";

/**
 * Persistent left rail for the five top-level areas, desktop only
 * (`lg:` and up). Mobile keeps the floating tab bar. Collapsible to an
 * icon strip; the choice is remembered.
 */
export function DesktopRail() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(KEY) === "1");
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      window.localStorage.setItem(KEY, next ? "1" : "0");
      window.dispatchEvent(new Event("aegis:rail"));
      return next;
    });
  }, []);

  if (pathname.startsWith("/auth")) return null;
  const activeArea = areaForPath(pathname);

  return (
    <>
      <nav
        aria-label="Sections"
        data-collapsed={collapsed ? "true" : "false"}
        className={`fixed inset-y-0 left-0 z-40 hidden shrink-0 flex-col gap-1 border-r border-border bg-surface-2/80 py-3 backdrop-blur lg:flex ${
          collapsed ? "w-[4.25rem] px-2" : "w-52 px-3"
        }`}
      >
        {PRIMARY.map((d) => {
          const Icon = d.icon;
          const active = activeArea === d.area;
          return (
            <Link
              key={d.to}
              to={d.to as never}
              title={collapsed ? d.label : undefined}
              aria-current={active ? "page" : undefined}
              className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm transition-colors ${
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              } ${collapsed ? "justify-center px-0" : ""}`}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              {!collapsed && <span className="truncate">{d.label}</span>}
            </Link>
          );
        })}

        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${
            collapsed ? "justify-center px-0" : ""
          }`}
          title={collapsed ? "All pages" : undefined}
        >
          <MoreHorizontal className="h-4 w-4 shrink-0" aria-hidden />
          {!collapsed && <span className="truncate">All pages</span>}
        </button>

        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          className="mt-auto flex min-h-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </nav>

      <MoreSheet open={moreOpen} onOpenChange={setMoreOpen} />
    </>
  );
}

/** Live read of the rail width so the page content can offset itself. */
export function useRailCollapsed(): boolean {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const read = () => setCollapsed(window.localStorage.getItem(KEY) === "1");
    read();
    window.addEventListener("aegis:rail", read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener("aegis:rail", read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return collapsed;
}
