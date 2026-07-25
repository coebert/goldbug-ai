// Banner shown on portfolio pages when Saxo's precheck endpoint keeps
// returning InsufficientCash / InsufficientBuyingPower rejections. That
// pattern almost always means the app's local cash assumption drifted
// from the real broker cash (external deposits/withdrawals, unbooked
// commissions, or over-aggressive per-symbol sizing). Surfacing it early
// lets the user reconcile cash or tighten risk before further ticks are
// wasted on unfundable buys.

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Wrench } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { JargonText } from "@/components/jargon-text";
import { getPrecheckCashRejects } from "@/lib/precheck-alerts.functions";
import { cn } from "@/lib/utils";

// Only warn once we've seen sustained rejections, not a one-off unlucky
// tick. Three cash-side precheck rejects inside 24h is the threshold —
// low enough to catch a bad hourly cron cycle, high enough to avoid
// alarming the user on isolated blips.
const CASH_REJECT_THRESHOLD = 3;
const WINDOW_HOURS = 24;

function formatWhen(iso: string | null): string {
  if (!iso) return "recently";
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

export function PrecheckCashAlertBanner({
  portfolioId,
  className,
}: {
  portfolioId: string;
  className?: string;
}) {
  const fetchRejects = useServerFn(getPrecheckCashRejects);
  const { data } = useQuery({
    queryKey: ["precheck-cash-rejects", portfolioId],
    queryFn: () => fetchRejects({ data: { portfolioId, sinceHours: WINDOW_HOURS } }),
    // Trading ticks run hourly, so re-check every 2 minutes to pick up a
    // freshly-recorded rejection without hammering the DB.
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  if (!data || data.cashRejects < CASH_REJECT_THRESHOLD) return null;

  const first = formatWhen(data.firstAt);
  const last = formatWhen(data.lastAt);
  const example = data.samples[0]?.message ?? data.samples[0]?.code ?? "InsufficientCash";

  return (
    <Alert
      variant="destructive"
      className={cn("border-amber-500/50 bg-amber-500/5 text-amber-100", className)}
    >
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Broker keeps rejecting buys for cash</AlertTitle>
      <AlertDescription className="text-xs">
        <JargonText>
          {`Saxo precheck rejected ${data.cashRejects} buy${data.cashRejects === 1 ? "" : "s"} in the last ${WINDOW_HOURS} hours because the broker account doesn't have the cash to cover them (first at ${first}, most recent ${last}). Latest reason: "${example}".`}
        </JargonText>
        <ul className="mt-2 list-disc pl-4 space-y-0.5 opacity-90">
          <li>
            <JargonText>
              Reconcile cash: check whether an external deposit or withdrawal happened on the Saxo account.
            </JargonText>
          </li>
          <li>
            <JargonText>
              Lower per-symbol position size or cash floor in Risk controls so orders fit the real broker balance.
            </JargonText>
          </li>
          <li>Pause the portfolio if you're actively investigating.</li>
        </ul>
        <div className="mt-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="border-amber-500/60 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20 hover:text-amber-50"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent("lovable:reconcile-cash", { detail: { portfolioId } }),
              );
            }}
          >
            <Wrench className="mr-1 h-4 w-4" /> Reconcile cash now
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
