import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { X, Sparkles, ArrowRight } from "lucide-react";

const STORAGE_KEY = "aegis:coachmarks:home:v1";

type Step = {
  title: string;
  body: string;
  targetSelector: string;
};

const STEPS: Step[] = [
  {
    title: "Start here",
    body: "New portfolio kicks off the guided setup. Simulated cash portfolios are free — no broker connection needed.",
    targetSelector: '[data-coach="new-portfolio"]',
  },
  {
    title: "Follow global events",
    body: "The News reel explains which headlines shaped each AI decision. Filters and language translation are built in.",
    targetSelector: '[data-coach="news-reel"]',
  },
  {
    title: "Need a refresher?",
    body: "Tap the ? icon in the header any time for a quick tour, keyboard shortcuts, and a link to the glossary.",
    targetSelector: '[data-coach="help-button"]',
  },
];


/**
 * Dismissible first-run coach marks for the Home dashboard.
 * Renders a fixed banner + step indicator; targets are highlighted via a
 * temporary ring class applied to the element matched by `targetSelector`.
 * Once the user finishes or dismisses, the sequence never shows again for
 * this browser profile.
 */
export function HomeCoachMarks() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (!window.localStorage.getItem(STORAGE_KEY)) setVisible(true);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    const target = document.querySelector<HTMLElement>(STEPS[step].targetSelector);
    if (!target) return;
    target.classList.add(
      "ring-2",
      "ring-primary",
      "ring-offset-2",
      "ring-offset-background",
      "rounded-md",
      "transition",
    );
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    return () => {
      target.classList.remove(
        "ring-2",
        "ring-primary",
        "ring-offset-2",
        "ring-offset-background",
      );
    };
  }, [visible, step]);

  function dismiss() {
    try {
      window.localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    } catch {
      /* ignore */
    }
    setVisible(false);
  }

  if (!visible) return null;
  const current = STEPS[step];
  const last = step === STEPS.length - 1;

  return (
    <div
      role="dialog"
      aria-labelledby="coach-title"
      className="fixed inset-x-3 bottom-20 z-50 mx-auto max-w-md rounded-xl border border-primary/50 bg-card p-4 shadow-lg sm:bottom-6"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Sparkles className="h-4 w-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 id="coach-title" className="text-sm font-semibold">
              {current.title}
            </h2>
            <span className="text-[11px] text-muted-foreground">
              {step + 1}/{STEPS.length}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{current.body}</p>
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={dismiss}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Skip tour
            </button>
            <Button
              size="sm"
              onClick={() => (last ? dismiss() : setStep((s) => s + 1))}
            >
              {last ? "Got it" : "Next"}
              {!last && <ArrowRight className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
        <button
          type="button"
          aria-label="Close tour"
          onClick={dismiss}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
