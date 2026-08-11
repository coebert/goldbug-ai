// Dashboard banner for broker charge-report problems detected during the
// hourly run. When Saxo's cost report fails or only partially covers our
// fills, the friction figures silently fall back to modelled estimates —
// this makes that visible instead of leaving a plausible-looking number.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, ReceiptText, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { JargonText } from "@/components/jargon-text";
import { getCostSyncAlert, dismissCostSyncAlert } from "@/lib/cost-sync-alerts.functions";
import { cn } from "@/lib/utils";

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      timeZone: "Europe/London",
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
    });
  } catch {
    return "recently";
  }
}

export function CostSyncAlertBanner({
  portfolioId,
  className,
}: {
  portfolioId: string;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const fetchAlert = useServerFn(getCostSyncAlert);
  const dismissFn = useServerFn(dismissCostSyncAlert);

  const { data } = useQuery({
    queryKey: ["cost-sync-alert", portfolioId],
    queryFn: () => fetchAlert({ data: { portfolioId, sinceHours: 24 } }),
    refetchInterval: 180_000,
    staleTime: 120_000,
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => dismissFn({ data: { id } }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["cost-sync-alert", portfolioId] }),
  });

  const alert = data?.alert;
  if (!alert || alert.readAt) return null;

  const failed = alert.status === "failed";

  return (
    <Alert
      variant="destructive"
      className={cn(
        failed
          ? "border-red-500/50 bg-red-500/5 text-red-100"
          : "border-amber-500/50 bg-amber-500/5 text-amber-100",
        className,
      )}
    >
      {failed ? <AlertTriangle className="h-4 w-4" /> : <ReceiptText className="h-4 w-4" />}
      <AlertTitle className="flex items-center justify-between gap-2">
        <span>
          {failed ? "Broker charge report failed" : "Broker charges only partly synced"}
        </span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Dismiss broker charge alert"
          className="h-6 w-6 shrink-0 opacity-70 hover:opacity-100"
          onClick={() => dismiss.mutate(alert.id)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </AlertTitle>
      <AlertDescription className="text-xs">
        <JargonText>{alert.body}</JargonText>
        <div className="mt-2 opacity-80">
          Detected {formatWhen(alert.at)} · coverage {alert.coveragePct}% of{" "}
          {alert.fillsConsidered} recent fills
          {alert.unmatchedFills > 0 ? ` · ${alert.unmatchedFills} still unpriced` : ""}.
        </div>
        <div className="mt-2 opacity-90">
          <JargonText>
            Until this clears, treat the cost figures as modelled estimates. Use “Sync broker
            charges” on the trading cost card to retry the fetch.
          </JargonText>
        </div>
      </AlertDescription>
    </Alert>
  );
}
