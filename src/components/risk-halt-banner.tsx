// Compact banner shown on portfolio pages when a hard risk halt is active.
// Explains what tripped, how far past the threshold we are, and what it means
// (new buys paused; sells still allowed to de-risk).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertOctagon, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  clearRiskHalt,
  getPortfolioRiskHalts,
  reinstateRiskHalt,
} from "@/lib/risk-halts.functions";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { JargonText } from "@/components/jargon-text";
import { cn } from "@/lib/utils";
import { POLL } from "@/lib/query-keys";

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

export function RiskHaltBanner({ portfolioId, className }: { portfolioId: string; className?: string }) {
  const fetchHalts = useServerFn(getPortfolioRiskHalts);
  const clearHalt = useServerFn(clearRiskHalt);
  const reinstate = useServerFn(reinstateRiskHalt);
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["risk-halts", portfolioId] });
  };

  const clearMutation = useMutation({
    mutationFn: (hours: number) => clearHalt({ data: { portfolioId, hours } }),
    onSuccess: (r) => {
      toast.success(`Buys resumed for ${r.hours}h — halt re-arms automatically after that.`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || "Could not clear the halt."),
  });

  const reinstateMutation = useMutation({
    mutationFn: () => reinstate({ data: { portfolioId } }),
    onSuccess: () => {
      toast.success("Risk halt re-armed.");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || "Could not re-arm the halt."),
  });
  const { data } = useQuery({
    queryKey: ["risk-halts", portfolioId],
    queryFn: () => fetchHalts({ data: { portfolioId } }),
    refetchInterval: POLL.SEMI_LIVE,
    staleTime: 30_000,
  });

  if (!data) return null;
  const bothOff =
    data.thresholds.max_daily_loss_pct === 0 &&
    data.thresholds.max_drawdown_halt_pct === 0;
  if (bothOff) return null;

  const override = data.override;

  if (!data.any_halt) {
    if (override && data.halted_by_rule) {
      return (
        <Alert className={cn("border-amber-500/40 bg-amber-500/5", className)}>
          <ShieldCheck className="h-4 w-4 text-amber-500" />
          <AlertTitle className="text-sm">Halt cleared — buys allowed</AlertTitle>
          <AlertDescription className="space-y-2 text-xs text-muted-foreground">
            <div>
              You cleared the risk halt manually. It re-arms automatically at{" "}
              {new Date(override.expires_at).toLocaleString("en-GB")}.
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={reinstateMutation.isPending}
              onClick={() => reinstateMutation.mutate()}
            >
              Re-arm halt now
            </Button>
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <Alert className={cn("border-emerald-500/30 bg-emerald-500/5", className)}>
        <ShieldCheck className="h-4 w-4 text-emerald-500" />
        <AlertTitle className="text-sm">Risk halts armed</AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">
          <JargonText>{`Buys pause automatically if today drops past −${pct(data.thresholds.max_daily_loss_pct)} or peak-to-current drawdown exceeds ${pct(data.thresholds.max_drawdown_halt_pct)}. Currently today ${pct(data.daily_loss_pct)}, drawdown ${pct(data.drawdown_pct)}.`}</JargonText>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive" className={className}>
      <AlertOctagon className="h-4 w-4" />
      <AlertTitle>Trading halted — new buys blocked</AlertTitle>
      <AlertDescription className="text-xs">
        {data.daily_loss_halt && (
          <div>
            Daily loss <strong>{pct(data.daily_loss_pct)}</strong> breached cap of −
            {pct(data.thresholds.max_daily_loss_pct)}.
          </div>
        )}
        {data.drawdown_halt && (
          <div>
            Drawdown <strong>{pct(data.drawdown_pct)}</strong> breached cap of{" "}
            {pct(data.thresholds.max_drawdown_halt_pct)} from peak.
          </div>
        )}
        <div className="mt-1 opacity-80">
          <JargonText>
            Automatic sells (stop-loss, take-profit, trailing) still fire. Buys resume when the condition clears, the caps are widened in Risk controls, or you clear the halt below.
          </JargonText>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={clearMutation.isPending}
            onClick={() => clearMutation.mutate(8)}
          >
            Clear halt for 8h
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={clearMutation.isPending}
            onClick={() => clearMutation.mutate(24)}
          >
            24h
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
