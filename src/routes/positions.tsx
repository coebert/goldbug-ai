// Portfolio positions: every open symbol with its size, cost basis, live
// value and P&L — split into what's still riding (unrealised) and what's
// already banked (realised) — plus the live cost hurdle and reserve rules
// the AI is trading under right now.
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/layout/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listPortfolios } from "@/lib/portfolios.functions";
import { getPortfolioPositions, type PositionRow } from "@/lib/portfolio-positions.functions";
import { RealMoneyCostPanel } from "@/components/real-money-cost-panel";
import { formatUkDate, formatUkTime } from "@/lib/uk-time";

export const Route = createFileRoute("/positions")({
  component: PositionsPage,
  head: () => ({
    meta: [
      { title: "Portfolio positions, cost and P&L | Goldbug" },
      {
        name: "description",
        content:
          "Each holding's size, cost basis, live value and unrealised and realised P&L, alongside the AI's live cost hurdle and reserve rules.",
      },
      { property: "og:title", content: "Portfolio positions, cost and P&L" },
      {
        property: "og:description",
        content:
          "Per-symbol position, cost and P&L with the live dealing-cost hurdle and reserve rules the AI trades under.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const money = (n: number | null, ccy: string, digits = 2) =>
  n == null
    ? "—"
    : `${n < 0 ? "−" : ""}${ccy} ${Math.abs(n).toLocaleString("en-GB", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })}`;

const num = (n: number, digits = 2) =>
  n.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });

function Pnl({ value, ccy }: { value: number | null; ccy: string }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const cls = value >= 0 ? "text-emerald-500" : "text-rose-400";
  return <span className={`tabular-nums ${cls}`}>{money(value, ccy)}</span>;
}

const PRICE_SOURCE_LABEL: Record<PositionRow["priceSource"], string> = {
  broker: "broker",
  public: "public feed",
  cache: "last close",
  cost: "at cost",
  none: "no price",
};

function PositionsPage() {
  const fetchPortfolios = useServerFn(listPortfolios);
  const fetchPositions = useServerFn(getPortfolioPositions);
  const { data: portfolios } = useQuery({
    queryKey: ["positions-portfolios"],
    queryFn: () => fetchPortfolios(),
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = useMemo(() => (Array.isArray(portfolios) ? portfolios : []), [portfolios]);
  const portfolioId =
    selectedId ??
    (list.find((p: any) => p.mode === "live_prod" || p.mode === "live_sim")?.id as string | undefined) ??
    ((list[0] as any)?.id as string | undefined) ??
    null;

  const { data, isLoading } = useQuery({
    queryKey: ["portfolio-positions", portfolioId],
    queryFn: () => fetchPositions({ data: { portfolioId: portfolioId! } }),
    enabled: !!portfolioId,
    refetchInterval: 60_000,
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AppHeader />
      <PageShell
        width="wide"
        title="Portfolio positions"
        purpose={
          data
            ? `${data.portfolioName} · ${data.rows.length} open position${data.rows.length === 1 ? "" : "s"} · ${data.brokerPriced} priced off the broker's tape`
            : "Each symbol's size, cost and P&L."
        }
        actions={
          <div className="flex items-center gap-2">
            {list.length > 1 && (
              <Select value={portfolioId ?? ""} onValueChange={(v) => setSelectedId(v)}>
                <SelectTrigger className="w-52">
                  <SelectValue placeholder="Pick a portfolio" />
                </SelectTrigger>
                <SelectContent>
                  {list.map((p: any) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {portfolioId && (
              <Button asChild variant="outline" size="sm">
                <Link to="/portfolio/$id" params={{ id: portfolioId }}>
                  Full portfolio page
                </Link>
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-6">


        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading positions…</p>
        )}

        {data && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Card>
                <CardHeader className="pb-1">
                  <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
                    Holdings value
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-xl font-semibold tabular-nums">
                    {money(data.totals.marketValueBase, data.currency, 0)}
                  </div>
                  {data.nav != null && (
                    <div className="text-xs text-muted-foreground">
                      of {money(data.nav, data.currency, 0)} total · cash{" "}
                      {money(data.cash, data.currency, 0)}
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-1">
                  <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
                    Cost basis
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-xl font-semibold tabular-nums">
                    {money(data.totals.costBasisBase, data.currency, 0)}
                  </div>
                  <div className="text-xs text-muted-foreground">including buy-side charges</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-1">
                  <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
                    Unrealised P&amp;L
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-xl font-semibold">
                    <Pnl value={data.totals.unrealizedBase} ccy={data.currency} />
                  </div>
                  <div className="text-xs text-muted-foreground">still riding</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-1">
                  <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
                    Realised P&amp;L
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-xl font-semibold">
                    <Pnl value={data.totals.realizedBase} ccy={data.currency} />
                  </div>
                  <div className="text-xs text-muted-foreground">banked on closed tickets</div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-1">
                  <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground">
                    Charges paid
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-xl font-semibold tabular-nums">
                    {money(data.totals.feesBase, data.currency)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    commission, stamp and levies
                  </div>
                </CardContent>
              </Card>
            </div>

            {data.warnings.length > 0 && (
              <p className="text-xs text-amber-500">{data.warnings.join(" ")}</p>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Open positions</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0 sm:p-6 sm:pt-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Symbol</TableHead>
                      <TableHead className="text-right">Size</TableHead>
                      <TableHead className="text-right">Cost / share</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                      <TableHead className="text-right">Unrealised</TableHead>
                      <TableHead className="text-right">Realised</TableHead>
                      <TableHead className="text-right">Charges</TableHead>
                      <TableHead className="text-right">Weight</TableHead>
                      <TableHead className="text-right">Cost floor</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows.map((r) => (
                      <TableRow key={r.symbol}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{r.symbol}</span>
                            {r.short && (
                              <Badge variant="destructive" className="text-[10px]">
                                short
                              </Badge>
                            )}
                          </div>
                          {r.openedAt && (
                            <div className="text-[11px] text-muted-foreground">
                              opened {formatUkDate(r.openedAt)}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {num(r.quantity, Math.abs(r.quantity) < 10 ? 4 : 2)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.avgCost > 0 ? money(r.avgCost, r.currency, r.avgCost < 1 ? 4 : 2) : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.price != null ? money(r.price, r.currency, r.price < 1 ? 4 : 2) : "—"}
                          <div className="text-[10px] text-muted-foreground">
                            {PRICE_SOURCE_LABEL[r.priceSource]}
                            {r.pricedAt ? ` · ${formatUkTime(r.pricedAt)}` : ""}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(r.marketValueBase, data.currency, 0)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Pnl value={r.unrealizedBase} ccy={data.currency} />
                        </TableCell>
                        <TableCell className="text-right">
                          <Pnl value={r.realizedBase} ccy={data.currency} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(r.feesBase, data.currency)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.weight != null ? `${(r.weight * 100).toFixed(1)}%` : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.roundTripBps != null ? `${r.roundTripBps.toFixed(0)} bps` : "—"}
                          {r.roundTripBps != null && (
                            <div className="text-[10px] text-muted-foreground">
                              {r.costMeasured ? "measured" : "tariff"}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {data.rows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={10} className="text-center text-muted-foreground">
                          No open positions in this account.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <RealMoneyCostPanel portfolioId={data.portfolioId} />
          </>
        )}
        </div>
      </PageShell>
    </div>
  );
}
