import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SymbolTicker } from "@/components/symbol-ticker";
import { formatMoney, formatMoneySigned } from "@/lib/format-money";
import { getNextBestTradeHistory } from "@/lib/next-best-trade-history.functions";
import { useLiveFillStream } from "@/hooks/use-live-fill-stream";

function dayLabel(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Europe/London",
  });
}

function toneClass(value: number | null) {
  if (value == null) return "text-muted-foreground";
  if (value > 0) return "text-emerald-500";
  if (value < 0) return "text-rose-400";
  return "";
}

export function NextBestTradeHistoryCard({ portfolioId }: { portfolioId: string }) {
  const fetchHistory = useServerFn(getNextBestTradeHistory);
  const query = useQuery({
    queryKey: ["next-best-trade-history", portfolioId],
    queryFn: () => fetchHistory({ data: { portfolioId, days: 60 } }),
    staleTime: 60_000,
    refetchInterval: 300_000,
  });
  useLiveFillStream(portfolioId, () => void query.refetch());

  const data = query.data;
  const s = data?.summary;
  const ccy = data?.currency ?? "GBP";

  return (
    <Card data-testid="next-best-trade-history-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4" /> Suggestions and what they did
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Every buy this page suggested over the last 60 days, whether it was actually
          bought, and what it has been worth since.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {query.error && (
          <p className="text-sm text-rose-400">Couldn&apos;t load the suggestion history.</p>
        )}
        {s && s.suggestions === 0 && (
          <p className="text-sm text-muted-foreground">
            No suggestions recorded yet — the first one is logged the next time this page
            works out a trade.
          </p>
        )}

        {data && s && s.suggestions > 0 && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <p className="text-xs text-muted-foreground">Suggestions</p>
                <p className="text-lg font-semibold">{s.suggestions}</p>
                <p className="text-xs text-muted-foreground">
                  {s.bought} bought · {s.skipped} skipped
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Right so far</p>
                <p className="text-lg font-semibold">
                  {s.hitRatePct == null ? "—" : `${s.hitRatePct.toFixed(0)}%`}
                </p>
                <p className="text-xs text-muted-foreground">price up since the call</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Made on bought ones</p>
                <p className={`text-lg font-semibold ${toneClass(s.actualBase)}`}>
                  {formatMoneySigned(s.actualBase, ccy)}
                </p>
                <p className="text-xs text-muted-foreground">
                  expected {formatMoneySigned(s.expectedBase, ccy)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Skipped ones would have</p>
                <p className={`text-lg font-semibold ${toneClass(s.missedBase)}`}>
                  {formatMoneySigned(s.missedBase, ccy)}
                </p>
                <p className="text-xs text-muted-foreground">on paper, charges included</p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="py-2 text-left font-medium">Suggested</th>
                    <th className="py-2 text-right font-medium">Ticket</th>
                    <th className="py-2 text-right font-medium">Outcome</th>
                    <th className="py-2 text-right font-medium">Since then</th>
                    <th className="py-2 text-right font-medium">Money</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <SymbolTicker symbol={r.symbol} />
                          {!r.recommended && (
                            <Badge variant="outline" className="text-[10px]">
                              held back
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {dayLabel(r.suggestedAt)} · {r.suggestedQuantity} @{" "}
                          {formatMoney(r.suggestedPrice, r.currency)}
                          {r.blockedReason ? ` · ${r.blockedReason}` : ""}
                        </p>
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(r.ticketBase, ccy)}
                        <span className="block text-xs text-muted-foreground">
                          expected {formatMoneySigned(r.expectedProfitBase, ccy)}
                        </span>
                      </td>
                      <td className="py-2 text-right">
                        <Badge
                          variant={r.status === "not_bought" ? "outline" : "secondary"}
                          className="text-[10px]"
                        >
                          {r.status === "bought"
                            ? "Bought"
                            : r.status === "partial"
                              ? "Part bought"
                              : "Not bought"}
                        </Badge>
                        {r.avgFillPrice != null && (
                          <span className="block text-xs text-muted-foreground">
                            {r.filledQuantity} @ {formatMoney(r.avgFillPrice, r.currency)}
                            {r.actualCostBase > 0
                              ? ` · ${formatMoney(r.actualCostBase, ccy)} charges`
                              : ""}
                          </span>
                        )}
                      </td>
                      <td className={`py-2 text-right tabular-nums ${toneClass(r.moveBps)}`}>
                        {r.moveBps == null ? "—" : `${(r.moveBps / 100).toFixed(2)}%`}
                      </td>
                      <td className={`py-2 text-right tabular-nums ${toneClass(r.outcomeBase)}`}>
                        {r.outcomeBase == null ? "—" : formatMoneySigned(r.outcomeBase, ccy)}
                        <span className="block text-xs text-muted-foreground">
                          {r.paper ? "on paper" : "real"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-xs text-muted-foreground">
              A suggestion counts as bought when a matching purchase filled within three days
              of the call. Skipped ones are scored as if they had been taken at the suggested
              price, with the quoted charges taken off.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
