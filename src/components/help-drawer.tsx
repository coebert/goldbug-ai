import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  HelpCircle,
  Compass,
  BookOpen,
  Keyboard,
  Plug,
  Rocket,
  Activity,
} from "lucide-react";

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: "?", label: "Open this Help panel" },
  { keys: "g h", label: "Go to Home" },
  { keys: "g c", label: "Go to Compare" },
  { keys: "g l", label: "Go to Learn" },
  { keys: "g b", label: "Go to Broker" },
  { keys: "Esc", label: "Close dialogs & sheets" },
];

const TOUR: { icon: typeof Rocket; title: string; body: string }[] = [
  {
    icon: Rocket,
    title: "1 · Start a demo portfolio",
    body: "Home → New portfolio. Pick a name, funding mode, and risk level. Simulated cash is free — no real money moves.",
  },
  {
    icon: Activity,
    title: "2 · Let the hourly loop run",
    body: "Aegis checks the market and news every hour. Each decision shows the signals, news, and guardrail checks that produced it.",
  },
  {
    icon: Plug,
    title: "3 · Connect Saxo when ready",
    body: "Only needed for real-money portfolios. Broker → Connect. You can keep everything paper-traded with the LIVE_SIM_PAPER_ONLY switch.",
  },
  {
    icon: Compass,
    title: "4 · Compare & learn",
    body: "Use Compare to overlay portfolios across time ranges. Learn explains every term used in the app in plain English.",
  },
];

/**
 * Slide-over Help panel exposed from the header. Bundles a quick tour, live
 * status link, keyboard shortcuts and a jump into /learn so beginners have a
 * single "what do I do next" affordance instead of hunting through pages.
 */
export function HelpDrawer() {
  const [open, setOpen] = useState(false);

  // "?" shortcut to open the panel (ignored while typing in inputs).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (!typing && e.key === "?") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open help"
          className="h-10 w-10"
        >
          <HelpCircle className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[92vw] max-w-md overflow-y-auto p-0">
        <SheetHeader className="border-b border-border px-4 py-4 text-left sm:px-6">
          <SheetTitle className="flex items-center gap-2">
            <HelpCircle className="h-5 w-5 text-primary" /> Help & quick tour
          </SheetTitle>
          <SheetDescription>
            A 5-minute overview of Aegis plus the shortcuts you'll use most.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 px-4 py-5 sm:px-6">
          <section aria-labelledby="help-tour-h">
            <h3
              id="help-tour-h"
              className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              5-minute tour
            </h3>
            <ol className="space-y-3">
              {TOUR.map(({ icon: Icon, title, body }) => (
                <li
                  key={title}
                  className="flex gap-3 rounded-lg border border-border bg-card p-3"
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{title}</div>
                    <p className="mt-1 text-xs text-muted-foreground">{body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section aria-labelledby="help-status-h">
            <h3
              id="help-status-h"
              className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              What's happening right now
            </h3>
            <p className="text-xs text-muted-foreground">
              Aegis runs an hourly decision loop and a daily summary. Check the header
              status pill for the last successful run, or open the Admin dashboard for
              full timings, broker status, and manual triggers.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button asChild size="sm" variant="secondary" onClick={() => setOpen(false)}>
                <Link to="/admin">Admin dashboard</Link>
              </Button>
              <Button asChild size="sm" variant="secondary" onClick={() => setOpen(false)}>
                <Link to="/saxo-status">Broker status</Link>
              </Button>
            </div>
          </section>

          <section aria-labelledby="help-shortcuts-h">
            <h3
              id="help-shortcuts-h"
              className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              <Keyboard className="h-3.5 w-3.5" aria-hidden /> Keyboard shortcuts
            </h3>
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {SHORTCUTS.map(({ keys, label }) => (
                <li
                  key={keys}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <span className="text-muted-foreground">{label}</span>
                  <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                    {keys}
                  </kbd>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Shortcuts are ignored while you're typing in a field.
            </p>
          </section>

          <section aria-labelledby="help-learn-h">
            <h3
              id="help-learn-h"
              className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Glossary & deep dive
            </h3>
            <p className="text-xs text-muted-foreground">
              Every trading term used in the app has a plain-English explanation on the
              Learn page. Terms with a dotted underline anywhere in Aegis open the same
              short definition.
            </p>
            <Button
              asChild
              size="sm"
              className="mt-3"
              onClick={() => setOpen(false)}
            >
              <Link to="/learn">
                <BookOpen className="h-4 w-4" /> Open Learn
              </Link>
            </Button>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
