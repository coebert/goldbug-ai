import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { JargonText } from "@/components/jargon-text";
import { ReconcileFillsCard } from "@/components/reconcile-fills-card";
import { OrderConfidenceBadge } from "@/components/order-confidence-badge";
import { SymbolTicker } from "@/components/symbol-ticker";
import { formatUk, ukZoneAbbr } from "@/lib/uk-time";

export type TradeRow = {
  id: string;
  trade_date: string;
  executed_at?: string | null;
  symbol: string;
  side: string;
  quantity: number | string;
  price: number | string;
  value: number | string;
  reason?: string | null;
  /** Model self-rated confidence 0..1 recorded when the order was placed. */
  conviction?: number | string | null;
};

type SortKey = "date" | "symbol" | "side" | "qty" | "price" | "value";

export function TradesSection({
  portfolioId,
  trades,
}: {
  portfolioId: string;
  trades: TradeRow[];
}) {
  const [tradeSort, setTradeSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "date",
    dir: "desc",
  });

  const sortedTrades = useMemo(() => {
    const arr = [...trades];
    const dir = tradeSort.dir === "asc" ? 1 : -1;
    const val = (t: TradeRow): string | number => {
      switch (tradeSort.key) {
        case "date":
          return `${t.trade_date} ${t.executed_at ?? ""}`;
        case "symbol":
          return t.symbol;
        case "side":
          return t.side;
        case "qty":
          return Number(t.quantity);
        case "price":
          return Number(t.price);
        case "value":
          return Number(t.value);
      }
    };
    arr.sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return 0;
    });
    return arr;
  }, [trades, tradeSort]);

  return (
    <>
      <ReconcileFillsCard portfolioId={portfolioId} className="mb-4" />
      {trades.length === 0 && <p className="text-sm text-muted-foreground">No trades yet.</p>}
      {trades.length > 0 && (
        <>
          {/* Desktop / tablet: sortable table with sticky header */}
          <div className="hidden md:block overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="sticky top-0 z-10 bg-muted/70 backdrop-blur text-xs uppercase text-muted-foreground">
                <tr>
                  {(
                    [
                      { key: "date", label: `Date & time (${ukZoneAbbr()})`, align: "left" },
                      { key: "symbol", label: "Symbol", align: "left" },
                      { key: "side", label: "Side", align: "left" },
                      { key: "qty", label: "Qty", align: "right" },
                      { key: "price", label: "Price", align: "right" },
                      { key: "value", label: "Value", align: "right" },
                    ] as const
                  ).map((col) => {
                    const active = tradeSort.key === col.key;
                    const Icon = active
                      ? tradeSort.dir === "asc"
                        ? ArrowUp
                        : ArrowDown
                      : ArrowUpDown;
                    return (
                      <th
                        key={col.key}
                        className={`px-3 py-2 select-none ${col.align === "right" ? "text-right" : "text-left"}`}
                      >
                        <button
                          type="button"
                          className={`inline-flex items-center gap-1 hover:text-foreground ${active ? "text-foreground" : ""}`}
                          onClick={() =>
                            setTradeSort((s) =>
                              s.key === col.key
                                ? { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" }
                                : {
                                    key: col.key,
                                    dir:
                                      col.key === "date" ||
                                      col.key === "value" ||
                                      col.key === "qty" ||
                                      col.key === "price"
                                        ? "desc"
                                        : "asc",
                                  },
                            )
                          }
                        >
                          {col.label}
                          <Icon className="h-3 w-3 opacity-70" />
                        </button>
                      </th>
                    );
                  })}
                  <th className="px-3 py-2 text-left">Confidence</th>
                  <th className="px-3 py-2 text-left">Reason</th>
                </tr>
              </thead>
              <tbody>
                {sortedTrades.map((t) => {
                  const executedAt = t.executed_at ? new Date(t.executed_at) : null;
                  const timeUk =
                    executedAt && !isNaN(executedAt.getTime())
                      ? formatUk(executedAt, {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                          hour12: false,
                        })
                      : null;
                  const zoneUk =
                    executedAt && !isNaN(executedAt.getTime()) ? ukZoneAbbr(executedAt) : "";
                  const conviction = t.conviction !== null && t.conviction !== undefined && Number.isFinite(Number(t.conviction))
                    ? Number(t.conviction)
                    : null;
                  return (
                    <tr key={t.id} className="border-t border-border">
                      <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                        <span>{t.trade_date}</span>
                        {timeUk && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {timeUk} {zoneUk}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-medium">
                        <SymbolTicker symbol={t.symbol} />
                      </td>
                      <td
                        className={`px-3 py-2 ${t.side === "buy" ? "text-primary" : "text-accent"}`}
                      >
                        {t.side.toUpperCase()}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Number(t.quantity).toFixed(4)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Number(t.price).toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Number(t.value).toFixed(2)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {conviction === null ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <OrderConfidenceBadge
                            side={t.side === "sell" ? "sell" : "buy"}
                            conviction={conviction}
                          />
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        <JargonText>{t.reason}</JargonText>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile: accordion cards — tap to expand full details */}
          <div className="md:hidden space-y-2">
            {sortedTrades.map((t) => {
              const executedAt = t.executed_at ? new Date(t.executed_at) : null;
              const timeUk =
                executedAt && !isNaN(executedAt.getTime())
                  ? formatUk(executedAt, {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                      hour12: false,
                    })
                  : null;
              const zoneUk =
                executedAt && !isNaN(executedAt.getTime()) ? ukZoneAbbr(executedAt) : "";
              const conviction = t.conviction !== null && t.conviction !== undefined && Number.isFinite(Number(t.conviction))
                ? Number(t.conviction)
                : null;
              return (
                <details
                  key={t.id}
                  className="group rounded-lg border border-border bg-card text-sm [&_summary::-webkit-details-marker]:hidden"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-2 p-3">
                    <Badge
                      className={`shrink-0 ${t.side === "buy" ? "bg-primary/15 text-primary hover:bg-primary/15" : "bg-accent/15 text-accent hover:bg-accent/15"}`}
                    >
                      {t.side.toUpperCase()}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate font-medium">{t.symbol}</span>
                    <span className="shrink-0 tabular-nums font-semibold">
                      {Number(t.value).toFixed(2)}
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="border-t border-border px-3 py-2 space-y-1.5">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
                      <span>
                        {t.trade_date}
                        {timeUk ? ` · ${timeUk} ${zoneUk}` : ""}
                      </span>
                      <span>Qty {Number(t.quantity).toFixed(4)}</span>
                      <span>@ {Number(t.price).toFixed(2)}</span>
                    </div>
                    {conviction !== null && (
                      <OrderConfidenceBadge
                        side={t.side === "sell" ? "sell" : "buy"}
                        conviction={conviction}
                      />
                    )}
                    {t.reason && (
                      <p className="text-xs text-muted-foreground break-words">
                        <JargonText>{t.reason}</JargonText>
                      </p>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
