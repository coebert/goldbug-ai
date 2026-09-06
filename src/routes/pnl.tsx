// P&L dashboard: the broker's real money against the AI's shadow backtest over
// the same days, with the dealing costs (commission, stamp duty, exchange fees,
// slippage) that explain most of the gap.
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/layout/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listPortfolios } from "@/lib/portfolios.functions";
import { getBacktestVsReal } from "@/lib/backtest-vs-real.functions";
import { verdictFor } from "@/lib/backtest-vs-real";
import { formatUk } from "@/lib/uk-time";
import { useLiveFillStream } from "@/hooks/use-live-fill-stream";

const BacktestVsRealCard = lazy(() =>
  import("@/components/backtest-vs-real-card").then((m) => ({ default: m.BacktestVsRealCard })),
);

export const Route = createFileRoute("/pnl")({
  component: PnlDashboard,
  head: () => ({
    meta: [
      { title: "P&L vs AI shadow backtest | Goldbug" },
      {
        name: "description",
        content:
          "Compare your broker's real profit and loss with the AI's shadow backtest over the same days, net of commission, stamp duty, exchange fees and slippage.",
      },
      { property: "og:title", content: "P&L vs AI shadow backtest" },
      {
        property: "og:description",
        content:
          "Real broker P&L against the AI's shadow backtest, with every fee and tax that explains the gap.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

type PortfolioRow = {
  id: string;
  name: string;
  currency?: string | null;
  mode?: string | null;
};

function money(n: number, ccy: string): string {
  const sign = n < 0 ? "−" : "";
  return `${sign}${ccy} ${Math.abs(n).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;
}

function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "up" | "down";
}) {
  const cls = tone === "up" ? "text-emerald-500" : tone === "down" ? "text-rose-400" : "";
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${cls}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground tabular-nums">{sub}</div>}
    </div>
  );
}

function PnlDashboard() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const fetchPortfolios = useServerFn(listPortfolios);
  const portfoliosQ = useQuery({
    queryKey: ["pnl", "portfolios"],
    queryFn: () => fetchPortfolios(),
    staleTime: 60_000,
  });
  const portfolios = (portfoliosQ.data ?? []) as PortfolioRow[];

  useEffect(() => {
    if (selectedId || portfolios.length === 0) return;
    const live =
      portfolios.find((p) => p.mode === "live_prod") ??
      portfolios.find((p) => p.mode === "live_sim") ??
      portfolios[0];
    if (live) setSelectedId(live.id);
  }, [portfolios, selectedId]);

  const portfolio = portfolios.find((p) => p.id === selectedId) ?? null;
  const ccy = portfolio?.currency ?? "GBP";

  const fetchCompare = useServerFn(getBacktestVsReal);
  const q = useQuery({
    queryKey: ["pnl", "compare", selectedId, runId],
    queryFn: () => fetchCompare({ data: { portfolioId: selectedId!, runId } }),
    enabled: Boolean(selectedId),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
  const c = q.data;

  // Refresh the comparison the moment the broker reports a new fill or an
  // order changes state, so the chart tracks real money as it happens.
  const stream = useLiveFillStream(selectedId, () => {
    void q.refetch();
  });
  const updatedAt = q.dataUpdatedAt ? new Date(q.dataUpdatedAt) : null;

  const chart = useMemo(
    () =>
      (c?.points ?? []).map((p) => ({
        date: p.date,
        Real: Number(p.realMoney.toFixed(2)),
        Shadow: Number(p.shadowMoney.toFixed(2)),
        Gap: Number(p.moneyGap.toFixed(2)),
      })),
    [c],
  );

  const cost = c?.costBreakdown;
  const costRows = cost
    ? [
        { label: "Commission", value: cost.commission, note: "Broker's dealing charge" },
        { label: "Stamp duty & levies", value: cost.tax, note: "Tax on UK share purchases" },
        { label: "Exchange & clearing", value: cost.exchange, note: "Market venue charges" },
        { label: "Other charges", value: cost.other, note: "Anything else the broker took" },
        { label: "Slippage", value: cost.slippage, note: "Worse price than the order asked for" },
      ].filter((r) => Math.abs(r.value) > 0.004)
    : [];

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <PageShell
        title="P&L: real vs the AI's shadow"
        purpose="What your broker account actually made, next to what the AI's replay of the same days would have made — with every fee and tax that explains the difference."
        context={
          <div className="flex flex-wrap items-center gap-2">
            <Select value={selectedId ?? undefined} onValueChange={(v) => { setSelectedId(v); setRunId(null); }}>
              <SelectTrigger className="w-full sm:w-[280px]">
                <SelectValue placeholder="Choose account" />
              </SelectTrigger>
              <SelectContent>
                {portfolios.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} · {p.mode ?? "unknown"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(c?.availableRuns.length ?? 0) > 1 && (
              <Select value={runId ?? c?.runId ?? undefined} onValueChange={(v) => setRunId(v)}>
                <SelectTrigger className="w-full sm:w-[240px] text-xs">
                  <SelectValue placeholder="Choose a replay" />
                </SelectTrigger>
                <SelectContent>
                  {(c?.availableRuns ?? []).map((r) => (
                    <SelectItem key={r.id} value={r.id} className="text-xs">
                      {formatUk(r.ran_at, { dateStyle: "medium", timeStyle: "short" })}
                      {r.risk_level ? ` · ${r.risk_level}` : ""} · {r.days}d
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {c?.from && c?.to && (
              <Badge variant="secondary" className="text-[11px]">
                {c.from} → {c.to} · {c.days} shared days
              </Badge>
            )}
            {cost && (
              <Badge variant={cost.invoiced ? "default" : "outline"} className="text-[11px]">
                {cost.invoiced ? "Charges invoiced by the broker" : "Charges estimated from the tariff"}
              </Badge>
            )}
            {selectedId && (
              <Badge variant="outline" className="gap-1.5 text-[11px]">
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    stream.connected ? "bg-emerald-500" : "bg-muted-foreground"
                  } ${q.isFetching ? "animate-pulse" : ""}`}
                />
                {stream.connected ? "Live" : "Reconnecting"}
                {updatedAt
                  ? ` · updated ${formatUk(updatedAt.toISOString(), { timeStyle: "short" })}`
                  : ""}
                {stream.events > 0
                  ? ` · ${stream.events} fill update${stream.events === 1 ? "" : "s"}`
                  : ""}
              </Badge>
            )}
          </div>
        }
      >
        <div className="space-y-4">
          {q.isLoading && <p className="text-sm text-muted-foreground">Lining your account up against the replay…</p>}
          {q.isError && (
            <p className="text-sm text-destructive">Could not build the comparison: {(q.error as Error).message}</p>
          )}
          {c?.note && <p className="text-sm text-muted-foreground">{c.note}</p>}

          {c && c.days >= 2 && (
            <>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <Tile
                  label="Real P&L"
                  value={money(c.realPnl, ccy)}
                  sub={`${pct(c.realStats.totalReturnPct)} · worst drop ${pct(c.realStats.maxDrawdownPct)}`}
                  tone={c.realPnl >= 0 ? "up" : "down"}
                />
                <Tile
                  label="Shadow backtest P&L"
                  value={money(c.backtestPnl, ccy)}
                  sub={`${pct(c.backtestStats.totalReturnPct)} on the same starting money`}
                  tone={c.backtestPnl >= 0 ? "up" : "down"}
                />
                <Tile
                  label="Gap"
                  value={money(c.pnlGap, ccy)}
                  sub={
                    c.daysBehind != null
                      ? `Real money is ${c.daysBehind} shared days behind`
                      : "Real money is level or ahead"
                  }
                  tone={c.pnlGap >= 0 ? "up" : "down"}
                />
                <Tile
                  label="Fees, taxes & slippage"
                  value={money(-(cost?.total ?? 0), ccy)}
                  sub={`${c.totalCostsBps.toFixed(1)} bps of the account${
                    c.feeShareOfGap != null ? ` · ${(c.feeShareOfGap * 100).toFixed(0)}% of the gap` : ""
                  }`}
                  tone="down"
                />
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Money side by side</CardTitle>
                  <p className="text-xs text-muted-foreground">{verdictFor(c)}</p>
                </CardHeader>
                <CardContent>
                  <div className="h-[280px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="pnlReal" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                            <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                        <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={24} />
                        <YAxis
                          tick={{ fontSize: 10 }}
                          width={70}
                          domain={["auto", "auto"]}
                          tickFormatter={(v: number) => v.toLocaleString("en-GB", { maximumFractionDigits: 0 })}
                        />
                        <Tooltip
                          formatter={(v: number, name: string) => [money(Number(v), ccy), name]}
                          contentStyle={{ fontSize: 12 }}
                        />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Area
                          type="monotone"
                          dataKey="Real"
                          stroke="hsl(var(--primary))"
                          fill="url(#pnlReal)"
                          strokeWidth={2}
                          dot={false}
                        />
                        <Area
                          type="monotone"
                          dataKey="Shadow"
                          stroke="hsl(var(--muted-foreground))"
                          fill="none"
                          strokeDasharray="4 3"
                          strokeWidth={2}
                          dot={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="mt-3 h-[140px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chart} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                        <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={24} />
                        <YAxis
                          tick={{ fontSize: 10 }}
                          width={70}
                          tickFormatter={(v: number) => v.toLocaleString("en-GB", { maximumFractionDigits: 0 })}
                        />
                        <Tooltip formatter={(v: number) => money(Number(v), ccy)} contentStyle={{ fontSize: 12 }} />
                        <ReferenceLine y={0} className="stroke-border" />
                        <Area
                          type="monotone"
                          dataKey="Gap"
                          name="Real minus shadow"
                          stroke="hsl(var(--destructive))"
                          fill="hsl(var(--destructive))"
                          fillOpacity={0.15}
                          strokeWidth={2}
                          dot={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Worst shortfall reached in this window: {money(c.worstMoneyLost, ccy)} ·{" "}
                    {c.underperformDays} of {c.days} days the account moved less than the replay.
                  </p>
                </CardContent>
              </Card>

              {selectedId && <RealMoneyCostPanel portfolioId={selectedId} />}

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">What dealing actually cost</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Every charge on your fills inside this window. The shadow replay pays modelled costs on its own
                    trades, so anything above that shows up in the gap.
                  </p>
                </CardHeader>
                <CardContent>
                  {costRows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No charges recorded on fills in this window.</p>
                  ) : (
                    <table className="w-full text-sm">
                      <tbody>
                        {costRows.map((r) => (
                          <tr key={r.label} className="border-b border-border/60 last:border-0">
                            <td className="py-2">
                              <div className="font-medium">{r.label}</div>
                              <div className="text-[11px] text-muted-foreground">{r.note}</div>
                            </td>
                            <td className="py-2 text-right tabular-nums">{money(r.value, ccy)}</td>
                            <td className="w-24 py-2 text-right tabular-nums text-[11px] text-muted-foreground">
                              {c.startEquity > 0 ? `${((r.value / c.startEquity) * 10_000).toFixed(1)} bps` : "—"}
                            </td>
                          </tr>
                        ))}
                        <tr className="border-t">
                          <td className="py-2 font-semibold">Total cost of dealing</td>
                          <td className="py-2 text-right font-semibold tabular-nums">
                            {money(cost?.total ?? 0, ccy)}
                          </td>
                          <td className="py-2 text-right text-[11px] tabular-nums text-muted-foreground">
                            {c.totalCostsBps.toFixed(1)} bps
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  )}
                </CardContent>
              </Card>
            </>
          )}

          {selectedId && (
            <Suspense
              fallback={
                <Card>
                  <CardContent className="py-8 text-sm text-muted-foreground">Loading the detail view…</CardContent>
                </Card>
              }
            >
              <BacktestVsRealCard portfolioId={selectedId} currency={ccy} />
            </Suspense>
          )}
        </div>
      </PageShell>
    </div>
  );
}
