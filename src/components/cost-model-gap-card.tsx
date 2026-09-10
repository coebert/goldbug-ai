import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Scale } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SymbolTicker } from "@/components/symbol-ticker";
import { formatMoney, formatMoneySigned } from "@/lib/format-money";
import { getCostModelGap } from "@/lib/cost-model-gap.functions";
import { useLiveFillStream } from "@/hooks/use-live-fill-stream";

const pct = (v: number) => `${(v * 100).toFixed(v >= 0.999 ? 0 : 1)}%`;
const bpsLabel = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}bps`;
const gapClass = (v: number) =>
  v > 0.5 ? "text-rose-400" : v < -0.5 ? "text-emerald-500" : "text-muted-foreground";

function dayLabel(iso: string | null) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

export function CostModelGapCard({ portfolioId }: { portfolioId: string }) {
  const fetchGap = useServerFn(getCostModelGap);
  const query = useQuery({
    queryKey: ["cost-model-gap", portfolioId],
    queryFn: () => fetchGap({ data: { portfolioId, limit: 40 } }),
    staleTime: 30_000,
    refetchInterval: 120_000,
  });
  useLiveFillStream(portfolioId, () => void query.refetch());

  const data = query.data;
  const s = data?.summary;

  return (
    <Card data-testid="cost-model-gap-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Scale className="h-4 w-4" /> Real charges vs simulation
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          What each order actually cost and how much of it filled, against what the
          simulation assumed{data ? ` (${data.assumptions})` : ""}.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {query.error && (
          <p className="text-sm text-rose-400">Couldn&apos;t load the comparison.</p>
        )}
        {s && s.orders === 0 && (
          <p className="text-sm text-muted-foreground">No broker orders yet.</p>
        )}

        {data && s && s.orders > 0 && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <p className="text-xs text-muted-foreground">Charged for real</p>
                <p className="text-lg font-semibold">
                  {formatMoney(s.actualFeeBase, data.currency)}
                </p>
                <p className="text-xs text-muted-foreground">{s.actualFeeBps.toFixed(1)}bps</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Simulation assumed</p>
                <p className="text-lg font-semibold">
                  {formatMoney(s.modelledFeeBase, data.currency)}
                </p>
                <p className="text-xs text-muted-foreground">{s.modelledFeeBps.toFixed(1)}bps</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Gap</p>
                <p className={`text-lg font-semibold ${gapClass(s.feeGapBps)}`}>
                  {formatMoneySigned(s.feeGapBase, data.currency)}
                </p>
                <p className={`text-xs ${gapClass(s.feeGapBps)}`}>{bpsLabel(s.feeGapBps)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Filled of what we asked</p>
                <p className="text-lg font-semibold">{pct(s.fillRate)}</p>
                <p className="text-xs text-muted-foreground">
                  {s.fullyFilled} full · {s.partiallyFilled} part · {s.unfilled} none
                </p>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              {s.underModelled} order{s.underModelled === 1 ? "" : "s"} cost more than the
              simulation assumed, {s.overModelled} cost less.{" "}
              {pct(s.brokerBilledShare)} of the charges are billed by the broker; the rest are
              still estimates.
            </p>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="py-2 text-left font-medium">Order</th>
                    <th className="py-2 text-right font-medium">Filled</th>
                    <th className="py-2 text-right font-medium">Value</th>
                    <th className="py-2 text-right font-medium">Real charge</th>
                    <th className="py-2 text-right font-medium">Assumed</th>
                    <th className="py-2 text-right font-medium">Gap</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.id} className="border-b border-border/50 last:border-0">
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <SymbolTicker symbol={row.symbol} />
                          <Badge variant="outline" className="text-[10px] uppercase">
                            {row.side}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {dayLabel(row.filledAt ?? row.createdAt)}
                          {row.feeSource === "broker" ? " · broker billed" : " · estimated"}
                        </p>
                      </td>
                      <td className="py-2 text-right">
                        {pct(row.fillRate)}
                        <p className="text-xs text-muted-foreground">
                          {row.filledQuantity} of {row.orderedQuantity}
                        </p>
                      </td>
                      <td className="py-2 text-right">
                        {formatMoney(row.notionalBase, data.currency)}
                      </td>
                      <td className="py-2 text-right">
                        {formatMoney(row.actualFeeBase, data.currency)}
                      </td>
                      <td className="py-2 text-right text-muted-foreground">
                        {formatMoney(row.modelledFeeBase, data.currency)}
                      </td>
                      <td className={`py-2 text-right ${gapClass(row.feeGapBps)}`}>
                        {formatMoneySigned(row.feeGapBase, data.currency)}
                        <p className="text-xs">{bpsLabel(row.feeGapBps)}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
