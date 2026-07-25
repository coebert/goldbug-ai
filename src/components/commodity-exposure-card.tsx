import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Gem } from "lucide-react";
import type { HoldingSeriesInfo } from "@/components/live-holdings-card";
import {
  classifyCommoditySymbol,
  COMMODITY_GROUPS,
  type CommodityGroup,
} from "@/lib/commodity-groups";

const GROUP_ORDER: CommodityGroup[] = COMMODITY_GROUPS;

function classify(symbol: string): CommodityGroup | null {
  return classifyCommoditySymbol(symbol);
}

type Holding = {
  symbol: string;
  quantity: number | string;
  avg_cost: number | string;
  asset_class?: string | null;
};

type ExecutedRow = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  value?: number;
  rejected?: string;
};

type DecisionLike = {
  id: string;
  run_date: string;
  raw?: unknown;
};

export function CommodityExposureCard({
  holdings,
  decisions,
  currency,
  totalValue,
  series,
}: {
  holdings: Holding[];
  decisions: DecisionLike[];
  currency: string;
  totalValue: number;
  series?: Record<string, HoldingSeriesInfo>;
}) {
  const currentBreakdown = useMemo(() => {
    const rows = new Map<CommodityGroup, { notional: number; symbols: string[] }>();
    let totalCommodity = 0;
    for (const h of holdings) {
      const grp = classify(h.symbol);
      if (!grp) continue;
      const qty = Number(h.quantity);
      const mark = series?.[h.symbol]?.currentPrice ?? Number(h.avg_cost);
      const notional = qty * mark;
      totalCommodity += notional;
      const cur = rows.get(grp) ?? { notional: 0, symbols: [] };
      cur.notional += notional;
      if (!cur.symbols.includes(h.symbol)) cur.symbols.push(h.symbol);
      rows.set(grp, cur);
    }
    return {
      totalCommodity,
      rows: GROUP_ORDER
        .map((g) => ({ group: g, ...(rows.get(g) ?? { notional: 0, symbols: [] }) }))
        .filter((r) => r.notional > 0),
    };
  }, [holdings, series]);

  const recentBreakdown = useMemo(() => {
    // Look at the most recent 10 decisions and aggregate executed commodity
    // orders (approved only) per group; separate buys vs sells so users can
    // see whether the AI is adding or trimming exposure.
    const rows = new Map<CommodityGroup, { buy: number; sell: number; count: number }>();
    let total = 0;
    const latest = decisions.slice(0, 10);
    for (const d of latest) {
      const raw = (d.raw ?? {}) as { executed?: ExecutedRow[] };
      for (const e of raw.executed ?? []) {
        if (e.rejected) continue;
        const grp = classify(e.symbol);
        if (!grp) continue;
        const notional = Number(e.value ?? e.price * e.quantity);
        if (!Number.isFinite(notional) || notional <= 0) continue;
        const cur = rows.get(grp) ?? { buy: 0, sell: 0, count: 0 };
        if (e.side === "buy") cur.buy += notional;
        else cur.sell += notional;
        cur.count += 1;
        rows.set(grp, cur);
        total += notional;
      }
    }
    return {
      total,
      considered: latest.length,
      rows: GROUP_ORDER
        .map((g) => ({ group: g, ...(rows.get(g) ?? { buy: 0, sell: 0, count: 0 }) }))
        .filter((r) => r.buy > 0 || r.sell > 0),
    };
  }, [decisions]);

  const nav = totalValue > 0 ? totalValue : 0;
  const totalPct = nav > 0 ? (currentBreakdown.totalCommodity / nav) * 100 : 0;

  const fmt = (n: number) =>
    `${currency} ${n.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gem className="h-4 w-4 text-amber-500" />
          Commodity exposure
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-muted-foreground">Total commodity</span>
          <span className="text-sm tabular-nums">
            {fmt(currentBreakdown.totalCommodity)}{" "}
            <span className="text-muted-foreground">
              ({totalPct.toFixed(1)}% of NAV)
            </span>
          </span>
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
            Current holdings
          </div>
          {currentBreakdown.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No commodity holdings.
            </p>
          ) : (
            <div className="space-y-2">
              {currentBreakdown.rows.map((r) => {
                const pct = nav > 0 ? (r.notional / nav) * 100 : 0;
                return (
                  <div key={r.group} className="space-y-1">
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="flex items-center gap-2">
                        {r.group}
                        <span className="text-xs text-muted-foreground">
                          {r.symbols.join(", ")}
                        </span>
                      </span>
                      <span className="tabular-nums">
                        {fmt(r.notional)}{" "}
                        <span className="text-muted-foreground">
                          ({pct.toFixed(1)}%)
                        </span>
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
                      <div
                        className="h-full bg-amber-500"
                        style={{ width: `${Math.min(100, pct)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Recent decisions ({recentBreakdown.considered})
            </div>
            <div className="text-xs text-muted-foreground tabular-nums">
              Traded {fmt(recentBreakdown.total)}
            </div>
          </div>
          {recentBreakdown.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No commodity orders in the last {recentBreakdown.considered || 0} decisions.
            </p>
          ) : (
            <div className="space-y-1.5">
              {recentBreakdown.rows.map((r) => {
                const net = r.buy - r.sell;
                const netPct = nav > 0 ? (net / nav) * 100 : 0;
                return (
                  <div
                    key={r.group}
                    className="flex items-baseline justify-between text-sm"
                  >
                    <span className="flex items-center gap-2">
                      {r.group}
                      <Badge variant="outline" className="text-[10px]">
                        {r.count} order{r.count === 1 ? "" : "s"}
                      </Badge>
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      <span className="text-emerald-600">+{fmt(r.buy)}</span>{" "}
                      / <span className="text-rose-600">-{fmt(r.sell)}</span>{" "}
                      <span
                        className={
                          net >= 0
                            ? "text-emerald-600"
                            : "text-rose-600"
                        }
                      >
                        (net {net >= 0 ? "+" : "−"}
                        {fmt(Math.abs(net))}, {netPct >= 0 ? "+" : ""}
                        {netPct.toFixed(2)}% NAV)
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
