// Compact live/offline toggle for a portfolio.
// - Backtest portfolios: shows a disabled "Offline (backtest)" indicator.
// - live_sim / live_prod portfolios: shows a green Switch that flips
//   `live_paused` via pauseLive, controlling whether the hourly cron trades it.

import { Switch } from "@/components/ui/switch";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { pauseLive } from "@/lib/live.functions";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Info } from "lucide-react";
import { qk } from "@/lib/query-keys";

interface Props {
  portfolioId: string;
  mode: string;
  livePaused: boolean | null | undefined;
  size?: "sm" | "md";
}

export function LiveToggle({ portfolioId, mode, livePaused, size = "md" }: Props) {
  const qc = useQueryClient();
  const pause = useServerFn(pauseLive);
  const isLive = mode === "live_sim" || mode === "live_prod";
  const active = isLive && !livePaused;

  const mut = useMutation({
    mutationFn: (paused: boolean) => pause({ data: { portfolioId, paused } }),
    onSuccess: (r) => {
      toast.success(r.paused ? "Portfolio set to Offline — cron will skip it" : "Portfolio Active — cron will trade it hourly");
      qc.invalidateQueries({ queryKey: qk.portfolios.all() });
      qc.invalidateQueries({ queryKey: qk.live.status(portfolioId) });
      qc.invalidateQueries({ queryKey: qk.portfolio.detail(portfolioId) });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const textSize = size === "sm" ? "text-[11px]" : "text-xs";
  const dot = `inline-block h-2 w-2 rounded-full ${active ? "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.9)] animate-pulse" : "bg-muted-foreground/50"}`;

  if (!isLive) {
    return (
      <TooltipProvider delayDuration={100}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={`inline-flex cursor-help items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 ${textSize} text-muted-foreground`}>
              <span className={dot} />
              Offline · backtest
              <Info className="h-3 w-3 opacity-60" />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            Backtest portfolios don't trade automatically. Open the portfolio and use the Live Trading (Saxo) card to Activate SIM or PRODUCTION so the hourly AI cron can trade it.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <label
            className={`inline-flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1 ${textSize} transition-colors ${
              active
                ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-border bg-muted/40 text-muted-foreground"
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <span className={dot} />
            <span className="font-semibold uppercase tracking-wide">{active ? "Active" : "Offline"}</span>
            <Switch
              checked={active}
              disabled={mut.isPending}
              onCheckedChange={(v) => mut.mutate(!v)}
              aria-label={active ? "Set portfolio to Offline" : "Set portfolio to Active"}
            />
          </label>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {active
            ? "Active: the hourly AI cron will evaluate this portfolio each hour and place trades (subject to guardrails). Flip off to pause without losing history."
            : "Offline: the hourly cron will skip this portfolio. Positions stay put; stop-loss/take-profit still apply on the next active run. Flip on to resume trading."}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
