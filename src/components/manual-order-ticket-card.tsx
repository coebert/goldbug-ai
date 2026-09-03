import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  getManualOrderQuote,
  placeManualOrder,
  type ManualOrderResult,
} from "@/lib/manual-order.functions";

/**
 * Hand-entered order ticket. Buys and sells route to the broker through the
 * same executor the AI uses, so what appears here is a real working order —
 * never a local simulation.
 */
export function ManualOrderTicketCard({
  portfolioId,
  currency,
  mode,
}: {
  portfolioId: string;
  currency: string;
  mode: string;
}) {
  const qc = useQueryClient();
  const isLive = mode === "live_prod" || mode === "live_sim";
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quantity, setQuantity] = useState("1");
  const [limitPrice, setLimitPrice] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [last, setLast] = useState<ManualOrderResult | null>(null);

  const quoteFn = useServerFn(getManualOrderQuote);
  const placeFn = useServerFn(placeManualOrder);

  const trimmed = symbol.trim().toUpperCase();
  const quote = useQuery({
    queryKey: ["manual-order-quote", portfolioId, trimmed],
    queryFn: () => quoteFn({ data: { portfolioId, symbol: trimmed } }),
    enabled: trimmed.length >= 1,
    refetchInterval: 30_000,
  });

  const qty = Number(quantity);
  const limit = limitPrice.trim() === "" ? undefined : Number(limitPrice);
  const price = limit ?? quote.data?.price ?? null;
  const estimate = price != null && Number.isFinite(qty) ? price * qty : null;

  const place = useMutation({
    mutationFn: () =>
      placeFn({
        data: {
          portfolioId,
          symbol: trimmed,
          side,
          quantity: qty,
          ...(limit != null && Number.isFinite(limit) && limit > 0 ? { limitPrice: limit } : {}),
        },
      }),
    onSuccess: (r) => {
      setLast(r);
      if (r.ok) {
        toast.success(
          `${r.side.toUpperCase()} ${r.quantity} ${r.symbol} sent to the broker${
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

  const canPlace =
    isLive && trimmed.length > 0 && Number.isFinite(qty) && qty > 0 && !place.isPending;

  const fmt = (n: number | null | undefined, ccy: string) =>
    n == null || !Number.isFinite(n)
      ? "—"
      : new Intl.NumberFormat("en-GB", {
          style: "currency",
          currency: ccy || "GBP",
          maximumFractionDigits: 4,
        }).format(n);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
        <CardTitle className="text-base">Order ticket</CardTitle>
        <Badge variant={isLive ? "default" : "secondary"} className="text-[11px]">
          {isLive ? "Routes to Saxo" : "Not connected to broker"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Places a real order with the broker and confirms it back here once it fills. Quantities
          are checked against what you actually hold — no shorting, no leverage.
        </p>

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="ticket-symbol">Symbol</Label>
            <Input
              id="ticket-symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="AAPL:xnas"
              autoCapitalize="characters"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Side</Label>
            <div className="flex gap-1">
              {(["buy", "sell"] as const).map((s) => (
                <Button
                  key={s}
                  type="button"
                  size="sm"
                  variant={side === s ? "secondary" : "ghost"}
                  className="h-9 flex-1 capitalize"
                  onClick={() => setSide(s)}
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ticket-qty">Quantity</Label>
            <Input
              id="ticket-qty"
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ticket-limit">Limit (optional)</Label>
            <Input
              id="ticket-limit"
              inputMode="decimal"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              placeholder="market"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-border bg-surface-1 p-3 text-sm">
          <span className="text-muted-foreground">
            Live price:{" "}
            <span className="tabular-nums text-foreground">
              {fmt(quote.data?.price, quote.data?.currency ?? currency)}
            </span>
          </span>
          <span className="text-muted-foreground">
            Bid / ask:{" "}
            <span className="tabular-nums text-foreground">
              {fmt(quote.data?.bid, quote.data?.currency ?? currency)} /{" "}
              {fmt(quote.data?.ask, quote.data?.currency ?? currency)}
            </span>
          </span>
          <span className="text-muted-foreground">
            Estimated value:{" "}
            <span className="tabular-nums text-foreground">
              {fmt(estimate, quote.data?.currency ?? currency)}
            </span>
          </span>
          <Badge variant="outline" className="text-[11px]">
            {quote.data?.source === "broker"
              ? "Saxo live"
              : quote.data?.source === "cache"
                ? "cached close"
                : "no price"}
          </Badge>
        </div>

        <Button disabled={!canPlace} onClick={() => setConfirmOpen(true)}>
          {place.isPending ? "Placing…" : `Place ${side} order`}
        </Button>

        {last && (
          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="font-medium">
              {last.side.toUpperCase()} {last.quantity} {last.symbol} — {last.status}
            </p>
            <p className="text-muted-foreground">
              Broker order {last.brokerOrderId ?? "—"} at {fmt(last.price, last.instrumentCcy)}
              {last.reason ? ` · ${last.reason}` : ""}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Fills appear in the order status card below and in holdings once the broker confirms.
            </p>
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Place a real ${side} order?`}
        description={`${side.toUpperCase()} ${quantity} ${trimmed} at about ${fmt(
          price,
          quote.data?.currency ?? currency,
        )} (estimated ${fmt(estimate, quote.data?.currency ?? currency)}). This sends real money to the broker.`}
        confirmLabel={`Place ${side}`}
        onConfirm={() => {
          setConfirmOpen(false);
          place.mutate();
        }}
      />
    </Card>
  );
}
