import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, SignalHigh } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHeader } from "@/components/home/section-header";
import { getPriceFeedStatus } from "@/lib/price-feed-status.functions";

function when(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Which instruments are priced live and which are showing an older saved price
 * because the feed could not be reached under any known ticker.
 */
export function PriceFeedStatusCard() {
  const fetchStatus = useServerFn(getPriceFeedStatus);
  const { data, isLoading } = useQuery({
    queryKey: ["price-feed-status"],
    queryFn: () => fetchStatus(),
    staleTime: 5 * 60 * 1000,
  });

  const fallbacks = data?.fallbacks ?? [];

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <SectionHeader
          icon={SignalHigh}
          title="Price feed health"
          description="Instruments showing a saved older price because the live feed could not be reached."
        />

        {isLoading ? (
          <div className="skeleton-shimmer h-24 w-full rounded-lg" aria-hidden="true" />
        ) : fallbacks.length === 0 ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            Every tracked instrument is pricing from the live feed.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {fallbacks.map((f) => (
              <li key={f.symbol} className="min-w-0 space-y-1 py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-sm font-semibold">{f.symbol}</span>
                  <Badge variant="destructive" className="shrink-0">
                    saved price
                  </Badge>
                </div>
                <p className="break-words text-xs text-muted-foreground">
                  Last live price {when(f.lastOkAt)} · {f.consecutiveFailures} failed attempt
                  {f.consecutiveFailures === 1 ? "" : "s"}
                  {f.feedSymbol && f.feedSymbol !== f.symbol ? ` · tried ${f.feedSymbol}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
