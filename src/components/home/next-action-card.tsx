import { Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, AlertTriangle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { NextAction } from "@/lib/next-action";

const TONE = {
  attention: {
    Icon: AlertTriangle,
    ring: "border-warning/40",
    wash: "bg-warning-soft/40",
    icon: "text-warning",
  },
  action: {
    Icon: Sparkles,
    ring: "border-primary/45",
    wash: "bg-primary/8",
    icon: "text-primary",
  },
  calm: {
    Icon: CheckCircle2,
    ring: "border-border/70",
    wash: "bg-surface-2",
    icon: "text-primary",
  },
} as const;

/**
 * The guidance tile: exactly one thing worth doing or knowing right
 * now. Sits at the top of the bento grid so a newcomer always has a
 * place to land before the numbers.
 */
export function NextActionCard({ action, className = "" }: { action: NextAction; className?: string }) {
  const tone = TONE[action.tone];
  const Icon = tone.Icon;

  return (
    <section
      aria-labelledby="next-action-title"
      className={`flex flex-col justify-between rounded-2xl border ${tone.ring} ${tone.wash} p-4 shadow-[var(--shadow-card)] sm:p-5 ${className}`}
    >
      <div>
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <Icon className={`h-3.5 w-3.5 ${tone.icon}`} aria-hidden />
          What to do next
        </div>
        <h2
          id="next-action-title"
          className="mt-2 font-display text-lg font-semibold leading-snug tracking-tight sm:text-xl"
        >
          {action.title}
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{action.body}</p>
      </div>
      <div className="mt-4">
        <Link to={action.ctaTo} hash={action.ctaHash}>
          <Button size="sm" variant={action.tone === "calm" ? "secondary" : "default"}>
            {action.ctaLabel}
            <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden />
          </Button>
        </Link>
      </div>
    </section>
  );
}
