// Delivery status for outbound coverage-trend alert webhooks.
//
// Alerts that never leave the building are worse than no alerts, so the last
// few delivery attempts (including retries and the failure reason) are shown
// next to the coverage chart.

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, MinusCircle } from "lucide-react";
import { getWebhookDeliveries } from "@/lib/alert-webhook.functions";
import { describeDeliveryStatus } from "@/lib/alert-webhook-retry";
import { cn } from "@/lib/utils";

function StatusIcon({ status }: { status: string }) {
  if (status === "delivered") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
  if (status === "failed") return <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />;
  return <MinusCircle className="h-3.5 w-3.5 opacity-60" />;
}

export function WebhookDeliveryStatusStrip({
  category,
  portfolioId,
  className,
}: {
  category: string;
  portfolioId?: string;
  className?: string;
}) {
  const fetchDeliveries = useServerFn(getWebhookDeliveries);
  const { data } = useQuery({
    queryKey: ["webhook-deliveries", category, portfolioId ?? "all"],
    queryFn: () =>
      fetchDeliveries({ data: { category, ...(portfolioId ? { portfolioId } : {}), limit: 5 } }),
    staleTime: 120_000,
    refetchInterval: POLL.SLOW,
  });

  if (!data || data.length === 0) return null;

  return (
    <div className={cn("mt-3 rounded-md border border-border/60 bg-muted/20 p-3", className)}>
      <div className="mb-2 text-xs font-medium opacity-80">Alert webhook delivery</div>
      <ul className="space-y-1.5 text-xs">
        {data.map((d) => (
          <li key={d.id} className="flex items-start justify-between gap-3 tabular-nums">
            <span className="flex items-center gap-1.5">
              <StatusIcon status={d.status} />
              <span className="opacity-80">
                {new Date(d.createdAt).toLocaleString("en-GB", { timeZone: "Europe/London" })}
              </span>
            </span>
            <span className="text-right">
              <span className={d.status === "failed" ? "text-amber-300" : "opacity-80"}>
                {describeDeliveryStatus(d.status, d.attempts)}
              </span>
              {d.endpointHost ? <span className="ml-1 opacity-60">→ {d.endpointHost}</span> : null}
              {d.error ? <div className="opacity-70">{d.error}</div> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
