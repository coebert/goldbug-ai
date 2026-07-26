import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Globe2 } from "lucide-react";
import {
  listInvestableUniverse,
  type InvestableUniverseEntry,
} from "@/lib/universe-list.functions";

const CLASS_ORDER: InvestableUniverseEntry["asset_class"][] = [
  "stock",
  "etf",
  "crypto",
  "commodity",
  "fx",
];

const CLASS_LABEL: Record<InvestableUniverseEntry["asset_class"], string> = {
  stock: "Equities",
  etf: "ETFs",
  crypto: "Crypto ETPs",
  commodity: "Commodities",
  fx: "FX",
};

// Panel that surfaces the full AI candidate universe grouped by asset class,
// so the user can see at a glance that the Saxo-tradable crypto ETPs sit
// alongside equities, ETFs, commodities and FX. Non-tradable spot/futures
// references (e.g. BTC-USD, GC=F, GBPUSD=X) are still shown because the
// price/backtest pipeline uses them, but are flagged so it's obvious they
// don't route to the broker.
export function InvestableUniverseCard() {
  const fetchUniverse = useServerFn(listInvestableUniverse);
  const { data, isLoading, error } = useQuery({
    queryKey: ["investable-universe"],
    queryFn: () => fetchUniverse(),
    staleTime: 5 * 60_000,
  });

  const grouped = useMemo(() => {
    const g = new Map<
      InvestableUniverseEntry["asset_class"],
      InvestableUniverseEntry[]
    >();
    for (const c of CLASS_ORDER) g.set(c, []);
    for (const row of data ?? []) g.get(row.asset_class)?.push(row);
    for (const arr of g.values()) arr.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return g;
  }, [data]);

  const totalTradable = (data ?? []).filter((r) => r.saxo_tradable).length;
  const totalCount = data?.length ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe2 className="h-4 w-4" aria-hidden />
          Investable universe
          {data ? (
            <Badge variant="secondary" className="ml-2 font-normal">
              {totalTradable} Saxo-tradable / {totalCount} total
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading universe…</p>
        ) : error ? (
          <p className="text-sm text-destructive">Failed to load universe.</p>
        ) : (
          CLASS_ORDER.map((cls) => {
            const rows = grouped.get(cls) ?? [];
            if (rows.length === 0) return null;
            const tradable = rows.filter((r) => r.saxo_tradable).length;
            return (
              <section key={cls} aria-labelledby={`universe-${cls}`}>
                <div className="mb-2 flex items-center gap-2">
                  <h3
                    id={`universe-${cls}`}
                    className="text-sm font-semibold"
                  >
                    {CLASS_LABEL[cls]}
                  </h3>
                  <Badge variant="outline" className="font-normal">
                    {tradable}/{rows.length} tradable
                  </Badge>
                </div>
                <ul className="flex flex-wrap gap-1.5">
                  {rows.map((r) => (
                    <li key={r.symbol}>
                      <Badge
                        variant={r.saxo_tradable ? "secondary" : "outline"}
                        className={
                          r.saxo_tradable
                            ? "font-mono text-xs"
                            : "font-mono text-xs opacity-60"
                        }
                        title={
                          r.saxo_tradable
                            ? `${r.name} — Saxo-tradable`
                            : `${r.name} — reference only (not Saxo-routable)`
                        }
                      >
                        {r.symbol}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
        <p className="text-xs text-muted-foreground">
          Crypto ETPs are physically-backed exchange-traded products (BTCE.DE,
          VBTC.L, ABTC.SW, ZETH.SW, ETHE.DE, HODL.SW) — cash-account safe on
          Saxo, no futures or leverage. Spot pairs like BTC-USD are shown for
          reference but cannot be routed to the broker.
        </p>
      </CardContent>
    </Card>
  );
}
