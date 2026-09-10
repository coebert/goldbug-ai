import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Target } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SymbolTicker } from "@/components/symbol-ticker";
import { formatMoney, formatMoneySigned } from "@/lib/format-money";
import { getNextBestTrade } from "@/lib/next-best-trade.functions";
import { placeManualOrder, type ManualOrderResult } from "@/lib/manual-order.functions";

function priceLabel(price: number, currency: string) {
  return formatMoney(price, currency);
}

export function NextBestTradeCard({
  portfolioId,
  mode,
}: {
  portfolioId: string;
  mode?: string;
}) {
  const qc = useQueryClient();
  const isLive = mode === "live_prod" || mode === "live_sim";
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [placed, setPlaced] = useState<ManualOrderResult | null>(null);
  const fetchNext = useServerFn(getNextBestTrade);
  const placeFn = useServerFn(placeManualOrder);
  const query = useQuery({
    queryKey: ["next-best-trade", portfolioId],
    queryFn: () => fetchNext({ data: { portfolioId } }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
  const data = query.data;
  const top = data?.rows.find((r) => r.recommended) ?? null;
  const others = (data?.rows ?? []).filter((r) => r !== top).slice(0, 4);

  // The suggestion is only useful if it can become a real order: route it
  // through exactly the same broker path the AI and the order ticket use, so
  // the buy lands in the live order book and then on the trades list.
  const place = useMutation({
    mutationFn: () => {
      if (!top) throw new Error("No suggestion to place.");
      return placeFn({
        data: {
          portfolioId,
          symbol: top.symbol,
          side: "buy" as const,
          quantity: top.quantity,
        },
      });
    },
    onSuccess: (r) => {
      setPlaced(r);
      if (r.ok) {
        toast.success(
          `Buy ${r.quantity} ${r.symbol} sent to the broker${
            r.brokerOrderId ? ` (order ${r.brokerOrderId})` : ""
          }`,
        );
      } else {
        toast.error(`Order not placed: ${r.reason ?? r.status}`);
      }
      void qc.invalidateQueries();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });


  return (
    <Card data-testid="next-best-trade-card">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Target className="h-4 w-4" /> Next best buy
          </CardTitle>
          {data && (
            <Badge variant="outline">
              {formatMoney(data.cashBase, data.currency)} cash free
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          The holding worth adding to next, sized to what your cash and limits allow, after your
          real dealing costs.
        </p>
      </CardHeader>
      <CardContent>
        {query.isLoading && (
          <p className="text-sm text-muted-foreground">Looking at your holdings…</p>
        )}
        {query.isError && (
          <p className="text-sm text-destructive">
            Could not work out a suggestion: {(query.error as Error).message}
          </p>
        )}

        {data && !top && (
          <p className="text-sm text-muted-foreground">
            {data.rows.length === 0
              ? "Nothing to suggest right now — there is no holding with enough cash and room left to add to."
              : "No holding is worth adding to today: none of them is expected to move enough to pay its dealing costs."}
          </p>
        )}

        {data && top && (
          <div className="rounded-lg border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <SymbolTicker symbol={top.symbol} className="truncate text-lg font-semibold" />
                  <Badge variant="secondary" className="text-[10px]">
                    {(top.conviction * 100).toFixed(0)}% confidence
                  </Badge>
                  {top.sizedUp && (
                    <Badge variant="outline" className="text-[10px]">sized up to be worth dealing</Badge>
                  )}
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {top.name ?? top.symbol} · already holding {top.heldQuantity}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase text-muted-foreground">Expected profit</div>
                <div className="text-lg font-semibold tabular-nums text-emerald-500">
                  {formatMoneySigned(top.expectedProfitBase, data.currency)}
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 text-sm tabular-nums sm:grid-cols-4">
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">Buy</div>
                {top.quantity} share{top.quantity === 1 ? "" : "s"}
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">Price each</div>
                {priceLabel(top.price, top.currency)}
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">Costs you</div>
                {formatMoney(top.ticketBase, data.currency)}
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">Dealing charges</div>
                {formatMoney(top.costBase, data.currency)}
              </div>
            </div>

            {top.signals.length > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                Why: {top.signals.join(", ")}.
              </p>
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">
              Expected move {top.expectedMoveBps.toFixed(0)}bps against {top.roundTripBps.toFixed(0)}bps
              of buying and selling costs.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                data-testid="next-best-trade-place"
                disabled={!isLive || place.isPending}
                onClick={() => setConfirmOpen(true)}
              >
                {place.isPending
                  ? "Placing…"
                  : `Buy ${top.quantity} ${top.symbol.split(":")[0]}`}
              </Button>
              {!isLive && (
                <span className="text-xs text-muted-foreground">
                  This account is not connected to the broker, so the buy cannot be placed here.
                </span>
              )}
            </div>

            {placed && (
              <div className="mt-3 rounded-md border p-3 text-xs">
                <p className="font-medium">
                  Buy {placed.quantity} {placed.symbol} — {placed.status}
                </p>
                <p className="text-muted-foreground">
                  Broker order {placed.brokerOrderId ?? "—"} at{" "}
                  {formatMoney(placed.price, placed.instrumentCcy)}
                  {placed.reason ? ` · ${placed.reason}` : ""}
                </p>
                <p className="mt-1 text-muted-foreground">
                  It appears on your trades list as soon as the broker fills it.
                </p>
              </div>
            )}
          </div>
        )}


        {data && others.length > 0 && (
          <div className="mt-4 space-y-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Also considered
            </div>
            {others.map((row) => (
              <div
                key={row.symbol}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-xs"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <SymbolTicker symbol={row.symbol} className="truncate font-medium" />
                  <span className="text-muted-foreground">
                    {(row.conviction * 100).toFixed(0)}% confidence
                  </span>
                </div>
                <div className="text-right tabular-nums">
                  {row.recommended ? (
                    <span className="text-emerald-500">
                      {formatMoneySigned(row.expectedProfitBase, data.currency)} on{" "}
                      {formatMoney(row.ticketBase, data.currency)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Not worth the costs today</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
