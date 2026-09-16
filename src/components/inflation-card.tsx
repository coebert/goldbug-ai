import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Gauge } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SectionHeader } from "@/components/home/section-header";
import { getInflation } from "@/lib/inflation.functions";

/**
 * Latest official consumer-price inflation for every market the AI trades.
 * The same numbers are written into the AI's decision prompt each run.
 */
export function InflationCard() {
  const fetchInflation = useServerFn(getInflation);
  const { data, isLoading } = useQuery({
    queryKey: ["inflation-snapshot"],
    queryFn: () => fetchInflation(),
    staleTime: 60 * 60 * 1000,
  });

  const points = data?.points ?? [];

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <SectionHeader
          icon={<Gauge className="h-4 w-4 text-primary" aria-hidden />}
          title="Inflation by market"
          subtitle="Latest published consumer-price inflation, used by the AI when it judges the rate path."
        />

        {isLoading ? (
          <div className="skeleton-shimmer h-40 w-full rounded-lg" aria-hidden="true" />
        ) : points.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Inflation figures could not be loaded right now. The AI treats this as unknown rather
            than assuming prices are calm.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {points.map((p) => {
              const rising = p.read.direction === "rising";
              const falling = p.read.direction === "falling";
              const hot = p.read.stance === "hot" || p.read.stance === "above_target";
              return (
                <li key={p.area} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{p.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.period} · {p.currency}
                      {p.previousYoy != null ? ` · was ${p.previousYoy.toFixed(1)}%` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="tabular-nums text-sm font-semibold">{p.yoy.toFixed(1)}%</span>
                    <Badge variant={hot ? "destructive" : "secondary"}>
                      {rising ? "rising" : falling ? "falling" : "steady"}
                    </Badge>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
