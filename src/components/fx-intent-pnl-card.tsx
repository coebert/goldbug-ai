import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getFxIntentPnl } from "@/lib/fx-intent-pnl.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { POLL } from "@/lib/query-keys";

interface Props {
  portfolioId: string;
  active?: boolean;
}

const KIND_LABEL: Record<string, string> = {
  pre_fund: "Pre-fund",
  hedge: "Hedge",
  sweep_idle: "Sweep",
  carry_tilt: "Carry",
  close_hedge: "Close hedge",
};

function fmt(n: number, ccy: string) {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  const abs = Math.abs(n);
  return `${sign}${new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: ccy,
    maximumFractionDigits: 2,
  }).format(abs)}`;
}

/**
 * Realized/mark-to-market PnL attribution for FX intents, grouped by
 * intent kind. PnL is computed as the base-currency value of the received
 * leg at current spot minus the base-currency value of the sent leg at
 * current spot — i.e. how the conversion has played vs today's rate.
 */
export function FxIntentPnlCard({ portfolioId, active = true }: Props) {
  const fetchPnl = useServerFn(getFxIntentPnl);
  const query = useQuery({
    queryKey: ["fx-intent-pnl", portfolioId],
    queryFn: () => fetchPnl({ data: { portfolioId, sinceDays: 30 } }),
    enabled: active,
    staleTime: 60_000,
    refetchInterval: POLL.SLOW,
  });

  const data = query.data;
  const buckets = data?.buckets ?? [];
  const anyActivity = buckets.some((b) => b.count > 0);

  const total = data?.totalPnlBase ?? 0;
  const totalTone =
    total > 0 ? "text-emerald-500" : total < 0 ? "text-destructive" : "text-muted-foreground";
  const TotalIcon = total > 0 ? TrendingUp : total < 0 ? TrendingDown : Minus;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-base">
            <TotalIcon className={`h-4 w-4 ${totalTone}`} />
            FX intent PnL (30d)
          </CardTitle>
          {data && (
            <div className="flex items-center gap-2">
              {data.stale && (
                <Badge variant="outline" className="bg-amber-500/15 text-amber-500 border-amber-500/30">
                  stale rates
                </Badge>
              )}
              <span className={`text-sm font-mono ${totalTone}`}>
                {fmt(total, data.baseCcy)}
              </span>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !anyActivity ? (
          <p className="text-sm text-muted-foreground">
            No applied FX intents in the last 30 days.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-2 pr-2 font-normal">Kind</th>
                  <th className="text-right py-2 px-2 font-normal">#</th>
                  <th className="text-right py-2 px-2 font-normal">Notional</th>
                  <th className="text-right py-2 px-2 font-normal">PnL</th>
                  <th className="text-right py-2 pl-2 font-normal">Win %</th>
                </tr>
              </thead>
              <tbody>
                {buckets.map((b) => {
                  const tone =
                    b.pnlBase > 0
                      ? "text-emerald-500"
                      : b.pnlBase < 0
                        ? "text-destructive"
                        : "text-muted-foreground";
                  return (
                    <tr key={b.kind} className="border-b border-border/50 last:border-0">
                      <td className="py-2 pr-2">
                        <Badge variant="outline" className="font-normal">
                          {KIND_LABEL[b.kind] ?? b.kind}
                        </Badge>
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-muted-foreground">
                        {b.count}
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-muted-foreground">
                        {b.count > 0 ? fmt(b.notionalBase, data!.baseCcy).replace("+", "") : "—"}
                      </td>
                      <td className={`py-2 px-2 text-right font-mono ${tone}`}>
                        {b.count > 0 ? fmt(b.pnlBase, data!.baseCcy) : "—"}
                      </td>
                      <td className="py-2 pl-2 text-right font-mono text-muted-foreground">
                        {b.count > 0 ? `${Math.round(b.winRate * 100)}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-muted-foreground">
              Mark-to-market vs current spot: {" "}
              <span className="font-mono">amount_to·spot(to→{data!.baseCcy}) − amount_from·spot(from→{data!.baseCcy})</span>.
              Positive = the conversion is in the money at today's rates.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
