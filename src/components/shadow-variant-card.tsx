import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getShadowVariantReport } from "@/lib/insights.functions";
import { GitCompare } from "lucide-react";

const KIND_LABEL: Record<string, string> = {
  primary_only: "Primary only",
  shadow_only: "Shadow only",
  conflicting_side: "Opposite side",
  sizing_gap: "Sizing gap",
};

const KIND_COLOR: Record<string, string> = {
  primary_only: "text-sky-500",
  shadow_only: "text-violet-500",
  conflicting_side: "text-red-500",
  sizing_gap: "text-amber-500",
};

export function ShadowVariantCard({ portfolioId }: { portfolioId: string }) {
  const fetchFn = useServerFn(getShadowVariantReport);
  const { data, isLoading } = useQuery({
    queryKey: ["shadow-variant", portfolioId],
    queryFn: () => fetchFn({ data: { portfolioId } }),
    staleTime: 60_000,
  });

  const pct = (n: number | null | undefined) =>
    n == null ? "—" : `${(n * 100).toFixed(0)}%`;

  const recent = data?.recent ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GitCompare className="h-4 w-4" /> Shadow variant B ({data?.variant_name ?? "contrarian_v1"})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!isLoading && (
          <>
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div className="rounded-lg border p-2">
                <div className="text-xs text-muted-foreground">Samples</div>
                <div className="font-semibold">{data?.samples ?? 0}</div>
              </div>
              <div className="rounded-lg border p-2">
                <div className="text-xs text-muted-foreground">Avg agreement</div>
                <div className="font-semibold">{pct(data?.avg_agreement)}</div>
              </div>
              <div className="rounded-lg border p-2">
                <div className="text-xs text-muted-foreground">Divergences</div>
                <div className="font-semibold">{data?.total_divergences ?? 0}</div>
              </div>
            </div>

            {recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No shadow runs yet — the next hourly cycle will log the first comparison.
              </p>
            ) : (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Recent runs</div>
                {recent.map((r: any) => {
                  const divs = Array.isArray(r.divergences) ? r.divergences : [];
                  return (
                    <div key={r.id} className="rounded-md border p-2 text-xs space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">{String(r.run_date).slice(0, 10)}</span>
                        <span className="font-mono">
                          primary {r.primary_order_count} · shadow {r.shadow_order_count} · agree {pct(Number(r.agreement))}
                        </span>
                      </div>
                      {divs.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {divs.slice(0, 6).map((d, i) => (
                            <span
                              key={i}
                              className={`rounded border px-1.5 py-0.5 ${KIND_COLOR[d.kind] ?? ""}`}
                              title={`${d.symbol} — ${KIND_LABEL[d.kind] ?? d.kind}`}
                            >
                              {d.symbol} · {KIND_LABEL[d.kind] ?? d.kind}
                            </span>
                          ))}
                          {divs.length > 6 && (
                            <span className="text-muted-foreground">+{divs.length - 6}</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Variant B runs in shadow mode only — its orders are logged for comparison and never executed.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
