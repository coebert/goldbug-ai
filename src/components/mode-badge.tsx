// Visual badge that unambiguously distinguishes simulated cash from real money.
// - backtest / live_sim  => SIMULATED CASH (safe, no real money)
// - live_prod            => REAL MONEY (routes to broker)

import { Badge } from "@/components/ui/badge";
import { FlaskConical, Beaker, Banknote } from "lucide-react";

export type PortfolioMode = "backtest" | "live_sim" | "live_prod" | string;

interface Props {
  mode: PortfolioMode;
  className?: string;
  size?: "sm" | "md";
}

export function ModeBadge({ mode, className = "", size = "md" }: Props) {
  const pad = size === "sm" ? "px-1.5 py-0 text-[10px]" : "px-2 py-0.5 text-xs";
  const iconSize = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";

  if (mode === "live_prod") {
    return (
      <Badge
        className={`gap-1 border border-destructive/60 bg-destructive/15 text-destructive font-semibold uppercase tracking-wide ${pad} ${className}`}
        title="Real money — orders route to your broker"
      >
        <Banknote className={iconSize} />
        Real money
      </Badge>
    );
  }
  if (mode === "live_sim") {
    return (
      <Badge
        className={`gap-1 border border-amber-500/50 bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold uppercase tracking-wide ${pad} ${className}`}
        title="Simulated cash — paper-traded live, no real money at risk"
      >
        <Beaker className={iconSize} />
        Simulated cash · live
      </Badge>
    );
  }
  // backtest / fallback
  return (
    <Badge
      className={`gap-1 border border-sky-500/50 bg-sky-500/15 text-sky-600 dark:text-sky-400 font-semibold uppercase tracking-wide ${pad} ${className}`}
      title="Simulated cash — historical backtest, no real money"
    >
      <FlaskConical className={iconSize} />
      Simulated cash · backtest
    </Badge>
  );
}
