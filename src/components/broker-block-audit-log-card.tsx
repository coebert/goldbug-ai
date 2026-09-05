import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, ScrollText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listBrokerBlockEvents } from "@/lib/broker-instrument-blocks.functions";

const REASON_LABEL: Record<string, string> = {
  suitability: "Suitability test required",
  not_tradable: "Not tradable",
  not_permitted: "Permission missing",
  kid_unavailable: "No KID (retail-restricted)",
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { timeZone: "Europe/London" });
}

export function BrokerBlockAuditLogCard() {
  const list = useServerFn(listBrokerBlockEvents);
  const q = useQuery({
    queryKey: ["broker-block-events"],
    queryFn: () => list({ data: { limit: 50 } }),
  });

  const events = q.data?.events ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <ScrollText className="h-4 w-4 text-muted-foreground" />
          Rejection audit log
        </CardTitle>
        {events.length > 0 && (
          <Badge variant="outline">{events.length} events</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isLoading && (
          <p className="text-sm text-muted-foreground">Loading audit log…</p>
        )}
        {q.error && (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Could not load the audit log.
          </p>
        )}
        {!q.isLoading && !q.error && events.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No broker suitability or permission rejections recorded.
          </p>
        )}

        {events.map((e) => (
          <div key={e.id} className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold text-foreground">
                {e.symbol}
              </span>
              <Badge variant="outline">{REASON_LABEL[e.reason] ?? e.reason}</Badge>
              {e.firstBlock && <Badge variant="secondary">first block</Badge>}
              <span className="text-xs text-muted-foreground">{fmtWhen(e.createdAt)}</span>
            </div>

            <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
              <div>
                <dt className="inline font-medium text-foreground">Order: </dt>
                <dd className="inline">
                  {(e.side ?? "—").toUpperCase()} {e.quantity ?? "—"} · {e.orderId ?? "no id"}
                </dd>
              </div>
              <div>
                <dt className="inline font-medium text-foreground">Broker: </dt>
                <dd className="inline">
                  {e.broker.toUpperCase()}
                  {e.errorCode ? ` · ${e.errorCode}` : ""} · attempt #{e.hitCount}
                </dd>
              </div>
            </dl>

            {e.rejectReason && (
              <p className="mt-2 rounded border border-border bg-background p-2 font-mono text-xs text-muted-foreground">
                {e.rejectReason}
              </p>
            )}

            <p className="mt-2 text-sm text-foreground">
              <span className="font-medium">Next action: </span>
              <span className="text-muted-foreground">{e.recommendedAction}</span>
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
