import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity } from "lucide-react";
import { listAlgoRegimeHistory } from "@/lib/algo-regime-history.functions";
import { AlgoRegimeCard } from "@/components/algo-regime-card";
import type { AlgoRegimeSnapshot } from "@/lib/microstructure/algo-regime";
import { POLL } from "@/lib/query-keys";

const TIER_BG: Record<AlgoRegimeSnapshot["tier"], string> = {
  normal: "bg-emerald-500/70",
  elevated: "bg-amber-500/80",
  extreme: "bg-red-500/90",
};

export function AlgoRegimeHistoryCard({ portfolioId }: { portfolioId: string }) {
  const fetchHistory = useServerFn(listAlgoRegimeHistory);
  const { data, isLoading, error } = useQuery({
    queryKey: ["algo-regime-history", portfolioId],
    queryFn: () => fetchHistory({ data: { portfolioId, limit: 60 } }),
    refetchInterval: POLL.SEMI_LIVE,
  });

  const rows = data ?? [];
  const latest = rows[0]?.snapshot ?? null;
  // Oldest → newest for the strip so time flows left-to-right.
  const strip = [...rows].reverse();

  const counts = rows.reduce(
    (acc, r) => {
      acc[r.snapshot.tier] = (acc[r.snapshot.tier] ?? 0) + 1;
      return acc;
    },
    { normal: 0, elevated: 0, extreme: 0 } as Record<AlgoRegimeSnapshot["tier"], number>,
  );

  return (
    <div className="space-y-4">
      <AlgoRegimeCard snapshot={latest} />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" /> Algo-regime history
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Tier per decision tick, oldest on the left. Hover for details.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {error && (
            <p className="text-sm text-destructive">{(error as Error).message}</p>
          )}
          {!isLoading && !error && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No algo-regime snapshots recorded yet.
            </p>
          )}
          {rows.length > 0 && (
            <>
              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                <span>
                  <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-500/70" />
                  Normal · {counts.normal}
                </span>
                <span>
                  <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-500/80" />
                  Elevated · {counts.elevated}
                </span>
                <span>
                  <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-red-500/90" />
                  Extreme · {counts.extreme}
                </span>
              </div>
              <div className="flex h-8 w-full items-stretch gap-[2px] overflow-hidden rounded">
                {strip.map((r) => (
                  <div
                    key={r.decisionId}
                    className={`flex-1 min-w-[3px] ${TIER_BG[r.snapshot.tier]}`}
                    title={`${new Date(r.createdAt).toLocaleString()} — ${r.snapshot.tier.toUpperCase()} (${r.snapshot.score}/5): ${r.snapshot.reason}`}
                  />
                ))}
              </div>
              <div className="max-h-64 overflow-y-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1 text-left">When</th>
                      <th className="px-2 py-1 text-left">Tier</th>
                      <th className="px-2 py-1 text-left">Score</th>
                      <th className="px-2 py-1 text-left">Signals</th>
                      <th className="px-2 py-1 text-left">Block buys</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 30).map((r) => {
                      const s = r.snapshot;
                      const active = (
                        ["volBurst", "liquidityVacuum", "whipsaw", "correlationSpike", "gapFade"] as const
                      ).filter((k) => s[k]);
                      return (
                        <tr key={r.decisionId} className="border-t">
                          <td className="px-2 py-1 font-mono">
                            {new Date(r.createdAt).toLocaleString()}
                          </td>
                          <td className="px-2 py-1 uppercase">{s.tier}</td>
                          <td className="px-2 py-1">{s.score}/5</td>
                          <td className="px-2 py-1 text-muted-foreground">
                            {active.length ? active.join(", ") : "—"}
                          </td>
                          <td className="px-2 py-1">
                            {s.multipliers.blockNewBuys ? "yes" : "no"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
