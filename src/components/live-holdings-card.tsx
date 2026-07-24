import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Briefcase, Wallet, TrendingUp } from "lucide-react";

type Holding = {
  id: string;
  symbol: string;
  quantity: number | string;
  avg_cost: number | string;
  asset_class?: string | null;
};

export function LiveHoldingsCard({
  holdings,
  currency,
  cash,
  totalValue,
  mode,
}: {
  holdings: Holding[];
  currency: string;
  cash: number;
  totalValue: number;
  mode: string;
}) {
  const isLive = mode === "live_prod";

  const rows = holdings
    .map((h) => {
      const qty = Number(h.quantity);
      const avg = Number(h.avg_cost);
      const value = qty * avg;
      return { ...h, qty, avg, value };
    })
    .sort((a, b) => b.value - a.value);

  const holdingsValue = rows.reduce((s, r) => s + r.value, 0);
  const denom = totalValue > 0 ? totalValue : holdingsValue + cash;
  const cashPct = denom > 0 ? (cash / denom) * 100 : 0;

  const fmt = (n: number) =>
    `${currency} ${n.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  return (
    <Card className={isLive ? "border-primary/40 shadow-sm" : undefined}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Briefcase className="h-4 w-4" />
            {isLive ? "Live positions" : "Holdings"}
            <Badge variant={isLive ? "default" : "secondary"} className="ml-1">
              {rows.length} {rows.length === 1 ? "position" : "positions"}
            </Badge>
          </CardTitle>
          {isLive && (
            <Badge variant="outline" className="uppercase tracking-wide text-[10px]">
              Real cash
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <TrendingUp className="h-3.5 w-3.5" /> Invested
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{fmt(holdingsValue)}</div>
            <div className="text-[11px] text-muted-foreground">
              {denom > 0 ? `${(100 - cashPct).toFixed(0)}% of portfolio` : "—"}
            </div>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Wallet className="h-3.5 w-3.5" /> Cash
            </div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{fmt(cash)}</div>
            <div className="text-[11px] text-muted-foreground">
              {denom > 0 ? `${cashPct.toFixed(0)}% of portfolio` : "—"}
            </div>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {isLive
              ? "No positions held at your broker right now. The AI will open positions on the next run when opportunities fit your budget."
              : "Fully in cash."}
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => {
              const pct = denom > 0 ? (r.value / denom) * 100 : 0;
              return (
                <li
                  key={r.id}
                  className="rounded-lg border p-3 hover:bg-muted/40 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-base font-semibold tracking-tight">{r.symbol}</span>
                        {r.asset_class && (
                          <Badge variant="secondary" className="uppercase text-[9px] px-1.5 py-0">
                            {r.asset_class}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                        {r.qty.toLocaleString(undefined, { maximumFractionDigits: 4 })} @ {currency}{" "}
                        {r.avg.toFixed(2)}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-base font-semibold tabular-nums">{fmt(r.value)}</div>
                      <div className="text-[11px] text-muted-foreground tabular-nums">
                        {pct.toFixed(1)}% of portfolio
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary/70"
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {isLive && (
          <p className="text-[11px] text-muted-foreground">
            Values shown at average cost from your broker. Live market prices are re-synced during
            each run and reconciliation.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
