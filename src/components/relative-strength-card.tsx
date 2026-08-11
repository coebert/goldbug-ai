import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Gauge, TrendingDown, TrendingUp } from "lucide-react";
import { getRelativeStrength } from "@/lib/relative-strength.functions";
import { RS_WINDOWS, type HoldingComparison } from "@/lib/relative-strength";
import { formatMoney } from "@/lib/format-money";

function pp(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`;
}

function toneClass(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "text-muted-foreground";
  if (v > 0.05) return "text-emerald-400";
  if (v < -0.05) return "text-rose-400";
  return "text-muted-foreground";
}

function VerdictBadge({ row }: { row: HoldingComparison }) {
  if (row.verdict === "leading") {
    return (
      <Badge variant="outline" className="border-emerald-500/40 text-emerald-400">
        <TrendingUp className="mr-1 h-3 w-3" aria-hidden /> Beating index
      </Badge>
    );
  }
  if (row.verdict === "lagging") {
    return (
      <Badge variant="outline" className="border-rose-500/40 text-rose-400">
        <TrendingDown className="mr-1 h-3 w-3" aria-hidden /> Behind index
      </Badge>
    );
  }
  if (row.verdict === "inline") {
    return <Badge variant="outline">Tracking index</Badge>;
  }
  return <Badge variant="outline">Too new</Badge>;
}

/**
 * Continuous read on whether the stocks we own are actually beating the market
 * average they should be judged against. Refreshes on a timer so the answer
 * stays current while the page is open.
 */
export function RelativeStrengthCard({
  portfolioId,
  currency = "GBP",
  enabled = true,
}: {
  portfolioId: string;
  currency?: string;
  enabled?: boolean;
}) {
  const fetchRs = useServerFn(getRelativeStrength);
  const q = useQuery({
    queryKey: ["relative-strength", portfolioId],
    queryFn: () => fetchRs({ data: { portfolioId } }),
    enabled,
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });

  const data = q.data;
  const headline = useMemo(() => {
    if (!data) return null;
    const v = data.weightedSincePurchaseExcess;
    if (v == null) return "Not enough history yet to score the book against the market.";
    if (v >= 1) return `The book is ahead of its benchmarks by ${pp(v)} since purchase.`;
    if (v <= -1) return `The book is behind its benchmarks by ${pp(v)} since purchase.`;
    return `The book is broadly in line with its benchmarks (${pp(v)}).`;
  }, [data]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="h-4 w-4 text-primary" aria-hidden />
          Owned stocks vs the market
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Each holding is measured against the index for its own market — London stocks
          against the FTSE 100, US stocks against the S&amp;P 500.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isPending && <p className="text-sm text-muted-foreground">Comparing holdings…</p>}
        {q.isError && (
          <p className="text-sm text-muted-foreground">Comparison unavailable right now.</p>
        )}

        {data && data.holdings.length === 0 && (
          <p className="text-sm text-muted-foreground">No open holdings to compare.</p>
        )}

        {data && data.holdings.length > 0 && (
          <>
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
              <p className="text-sm">{headline}</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  Value vs index:{" "}
                  <span className={toneClass(data.totalExcessValue)}>
                    {formatMoney(data.totalExcessValue, currency)}
                  </span>
                </span>
                <span>{data.leaders} ahead</span>
                <span>{data.laggards} behind</span>
                {data.asOf && <span>as of {data.asOf}</span>}
              </div>
              <div className="mt-3 grid grid-cols-4 gap-2">
                {RS_WINDOWS.map((w) => (
                  <div key={w.key} className="rounded-md bg-background/60 p-2 text-center">
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      {w.label}
                    </div>
                    <div className={`text-sm font-semibold tabular-nums ${toneClass(data.weightedExcess[w.key])}`}>
                      {pp(data.weightedExcess[w.key])}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <ul className="space-y-2">
              {data.holdings.map((row) => (
                <li
                  key={row.symbol}
                  className="rounded-lg border border-border/60 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{row.symbol}</div>
                      <div className="text-xs text-muted-foreground">vs {row.benchmark.label}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-semibold tabular-nums ${toneClass(row.sincePurchaseExcessPct)}`}>
                        {pp(row.sincePurchaseExcessPct)}
                      </span>
                      <VerdictBadge row={row} />
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-4 gap-2 text-center text-xs">
                    {row.windows.map((w) => (
                      <div key={w.key} className="rounded-md bg-muted/20 py-1">
                        <div className="text-[10px] uppercase text-muted-foreground">{w.label}</div>
                        <div className={`tabular-nums ${toneClass(w.excessPct)}`}>{pp(w.excessPct)}</div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">{row.note}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
