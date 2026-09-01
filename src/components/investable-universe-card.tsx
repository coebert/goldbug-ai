import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Globe2, CheckCircle2, Ban } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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

const REASON_LABEL: Record<NonNullable<InvestableUniverseEntry["block_reason_code"]>, string> = {
  spot_fx_reference: "Spot FX reference",
  futures_pseudo_symbol: "Futures pseudo-symbol",
  crypto_spot_pair: "Crypto spot pair",
};

// Panel that surfaces the full AI candidate universe grouped by asset class,
// with an investability status indicator per symbol (candidate vs blocked)
// and a plain-English explanation when a symbol cannot be routed to Saxo.
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
    for (const arr of g.values())
      arr.sort((a, b) => {
        if (a.status !== b.status) return a.status === "candidate" ? -1 : 1;
        return a.symbol.localeCompare(b.symbol);
      });
    return g;
  }, [data]);

  const totalCandidate = (data ?? []).filter((r) => r.status === "candidate").length;
  const totalBlocked = (data ?? []).filter((r) => r.status === "blocked").length;
  const totalCount = data?.length ?? 0;

  return (
    <TooltipProvider delayDuration={150}>
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Globe2 className="h-4 w-4" aria-hidden />
            Investable universe
            {data ? (
              <>
                <Badge variant="secondary" className="font-normal">
                  {totalCandidate} candidate
                </Badge>
                <Badge variant="outline" className="font-normal">
                  {totalBlocked} blocked
                </Badge>
                <span className="text-xs font-normal text-muted-foreground">
                  of {totalCount} total
                </span>
              </>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading universe…</p>
          ) : error ? (
            <p className="text-sm text-destructive">Failed to load universe.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
                  Candidate — Saxo-routable
                </span>
                <span className="flex items-center gap-1">
                  <Ban className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  Blocked — hover the tag for the reason
                </span>
              </div>
              {CLASS_ORDER.map((cls) => {
                const rows = grouped.get(cls) ?? [];
                if (rows.length === 0) return null;
                const candidates = rows.filter((r) => r.status === "candidate").length;
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
                        {candidates}/{rows.length} candidate
                      </Badge>
                    </div>
                    <ul className="flex flex-wrap gap-1.5">
                      {rows.map((r) => {
                        const isCandidate = r.status === "candidate";
                        const Icon = isCandidate ? CheckCircle2 : Ban;
                        const reasonLabel =
                          r.block_reason_code
                            ? REASON_LABEL[r.block_reason_code]
                            : "Candidate";
                        return (
                          <li key={r.symbol}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge
                                  variant={isCandidate ? "secondary" : "outline"}
                                  aria-label={`${r.symbol} — ${isCandidate ? "candidate" : `blocked: ${reasonLabel}`}`}
                                  className={
                                    "flex items-center gap-1 font-mono text-xs " +
                                    (isCandidate
                                      ? "border-emerald-500/30"
                                      : "border-dashed opacity-70")
                                  }
                                >
                                  <Icon
                                    className={
                                      "h-3 w-3 " +
                                      (isCandidate
                                        ? "text-emerald-600"
                                        : "text-muted-foreground")
                                    }
                                    aria-hidden
                                  />
                                  {r.symbol}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs text-xs leading-snug">
                                <div className="mb-0.5 font-semibold">
                                  {isCandidate ? "Candidate" : `Blocked · ${reasonLabel}`}
                                </div>
                                <div>{r.status_explanation}</div>
                              </TooltipContent>
                            </Tooltip>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </>
          )}
          <p className="text-xs text-muted-foreground">
            Crypto ETPs are physically-backed exchange-traded products (BTCE.DE,
            BTCW.L, ABTC.SW, ZETH.SW, ZETH.DE, HODL.SW) — cash-account safe on
            Saxo, no futures or leverage. Spot pairs like BTC-USD, futures like
            GC=F and Yahoo FX pairs like GBPUSD=X are shown for reference but are
            blocked from broker routing.
          </p>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
