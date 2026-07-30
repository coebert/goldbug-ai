// Phase 6 — Tail hedge report card.
//
// Companion to <TailHedgeCard/>: shows the accumulated history of hedge
// advisories vs executed fills for the portfolio — trade log, notional /
// fees / slippage totals, an advised-vs-observed area chart, and (when the
// engine persisted it) the leave-one-out phase attribution table so the
// user can compare Phase 6's contribution against Phases 2–5.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  Area,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getTailHedgeReport, type HedgeReport } from "@/lib/hedging/tail-hedge-report.functions";
import { AXIS_TICK } from "@/lib/chart-palette";

function money(n: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(0)}`;
  }
}

function pct(n: number) {
  return `${(n * 100).toFixed(2)}%`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

const WINDOWS: Array<{ label: string; days?: number }> = [
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
  { label: "All" },
];

export function TailHedgeReportCard({
  portfolioId,
  currency,
}: {
  portfolioId: string;
  currency: string;
}) {
  const fetchReport = useServerFn(getTailHedgeReport);
  const queryClient = useQueryClient();
  const [win, setWin] = useState(1); // default 90d
  const sinceDays = WINDOWS[win].days;

  const { data, isLoading, error } = useQuery({
    queryKey: ["tail-hedge-report", portfolioId, sinceDays ?? "all"],
    queryFn: () =>
      fetchReport({ data: sinceDays ? { portfolioId, sinceDays } : { portfolioId } }),
    staleTime: 60 * 1000,
  });

  // Live hedging monitor — refresh the Phase 6 rollup whenever the engine
  // persists a new decision (advisory + execution + reconciliation blocks all
  // land in `decisions.raw`) or the broker records a fill for this portfolio.
  // Both tables are in the `supabase_realtime` publication and RLS scopes rows
  // to this user's portfolios, so subscribers only receive their own updates.
  useEffect(() => {
    if (!portfolioId) return;
    const invalidate = () =>
      queryClient.invalidateQueries({ queryKey: ["tail-hedge-report", portfolioId] });
    const channel = supabase
      .channel(`tail-hedge-live:${portfolioId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "decisions", filter: `portfolio_id=eq.${portfolioId}` },
        invalidate,
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "decisions", filter: `portfolio_id=eq.${portfolioId}` },
        invalidate,
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "live_fills", filter: `portfolio_id=eq.${portfolioId}` },
        invalidate,
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [portfolioId, queryClient]);


  const chartData = useMemo(() => {
    if (!data) return [];
    return data.series.map((p) => ({
      date: fmtDate(p.date),
      advised: p.advisedNotional,
      observed: p.observedNotional,
    }));
  }, [data]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base flex items-center gap-2">
          Tail hedge report (Phase 6)
          <span
            className="inline-flex items-center gap-1 text-[10px] font-normal text-muted-foreground"
            title="Auto-refreshes when the engine records a new hedge decision or the broker files a fill for this portfolio."
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            live
          </span>
        </CardTitle>
        <div className="flex gap-1">
          {WINDOWS.map((w, i) => (
            <Button
              key={w.label}
              size="sm"
              variant={i === win ? "default" : "outline"}
              onClick={() => setWin(i)}
              className="h-7 px-2 text-xs"
            >
              {w.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <div className="text-sm text-muted-foreground">Loading hedge history…</div>}
        {error && (
          <div className="text-sm text-destructive">Failed to load: {(error as Error).message}</div>
        )}
        {data && data.totals.decisions === 0 && (
          <div className="text-sm text-muted-foreground">
            No tail-hedge advisories persisted for this portfolio yet.
          </div>
        )}
        {data && data.totals.decisions > 0 && (
          <>
            <TotalsGrid report={data} currency={currency} />
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ left: 4, right: 4, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="date" tick={AXIS_TICK} minTickGap={20} />
                  <YAxis tick={AXIS_TICK} width={64} />
                  <Tooltip
                    formatter={(v: number) => money(v, currency)}
                    labelStyle={{ color: "var(--foreground)" }}
                    contentStyle={{ background: "var(--card)", borderRadius: 6, fontSize: 11 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="advised"
                    name="Advised notional"
                    stroke="var(--primary)"
                    fill="color-mix(in oklab, var(--primary) 20%, transparent)"
                  />
                  <Line
                    type="monotone"
                    dataKey="observed"
                    name="Observed notional"
                    stroke="var(--foreground)"
                    dot={false}
                    strokeWidth={1.5}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <TradesTable report={data} currency={currency} />
            <DeferralsRow report={data} currency={currency} />
            <PhaseAttributionTable report={data} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TotalsGrid({ report, currency }: { report: HedgeReport; currency: string }) {
  const t = report.totals;
  const netCost = t.estFees + t.estSlippage;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Stat label="Advisories" value={String(t.decisions)} sub={`${t.applied} applied`} />
      <Stat label="Gross notional" value={money(t.grossNotional, currency)} sub={`net ${money(t.netNotional, currency)}`} />
      <Stat label="Est. fees + slippage" value={money(netCost, currency)} sub={`${t.buyCount}B / ${t.sellCount}S`} />
      <Stat label="Unfilled advised" value={money(t.unfilledAdvisedNotional, currency)} sub={`${t.deferred} deferred`} />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function TradesTable({ report, currency }: { report: HedgeReport; currency: string }) {
  if (report.trades.length === 0) {
    return <div className="text-xs text-muted-foreground">No hedge fills in this window.</div>;
  }
  const recent = report.trades.slice(-10).reverse();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border/60">
            <th className="py-1 text-left font-medium">Date</th>
            <th className="text-left font-medium">Action</th>
            <th className="text-left font-medium">Symbol</th>
            <th className="text-right font-medium">Qty</th>
            <th className="text-right font-medium">Notional</th>
            <th className="text-right font-medium">Fee</th>
            <th className="text-right font-medium">Slip</th>
            <th className="text-right font-medium">vs Advised</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {recent.map((t, i) => (
            <tr key={i} className="border-b border-border/40 last:border-0">
              <td className="py-1">{fmtDate(t.date)}</td>
              <td>
                <Badge variant={t.action === "buy" ? "default" : "secondary"} className="h-4 px-1 text-[10px]">
                  {t.action.toUpperCase()}
                </Badge>
              </td>
              <td>{t.symbol ?? "—"}</td>
              <td className="text-right">{t.qty.toFixed(2)}</td>
              <td className="text-right">{money(t.notional, currency)}</td>
              <td className="text-right">{money(t.estFee, currency)}</td>
              <td className="text-right">{money(t.estSlippage, currency)}</td>
              <td className="text-right">{money(t.slippageVsAdvised, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {report.trades.length > 10 && (
        <div className="pt-1 text-[10px] text-muted-foreground">
          Showing latest 10 of {report.trades.length} fills.
        </div>
      )}
    </div>
  );
}

function DeferralsRow({ report, currency }: { report: HedgeReport; currency: string }) {
  const entries = Object.entries(report.totals.deferralBreakdown).filter(([, n]) => n > 0);
  if (entries.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        Deferral reasons — {money(report.totals.unfilledAdvisedNotional, currency)} unfilled
      </div>
      <div className="flex flex-wrap gap-1">
        {entries.map(([k, n]) => (
          <Badge key={k} variant="outline" className="text-[10px]">
            {k}: {n}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function PhaseAttributionTable({ report }: { report: HedgeReport }) {
  if (report.phaseAttribution.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        Phase attribution (leave-one-out vs full run)
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border/60">
              <th className="py-1 text-left font-medium">Phase</th>
              <th className="text-right font-medium">ΔCAGR</th>
              <th className="text-right font-medium">ΔMDD</th>
              <th className="text-right font-medium">ΔWinRate</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {report.phaseAttribution.map((r) => {
              const isHedge = r.phase.toLowerCase().includes("hedge") || r.phase.toLowerCase().includes("phase6");
              return (
                <tr key={r.phase} className={`border-b border-border/40 last:border-0 ${isHedge ? "bg-primary/5" : ""}`}>
                  <td className="py-1">{r.phase}</td>
                  <td className="text-right">{pct(r.cagrDelta)}</td>
                  <td className="text-right">{pct(r.ddDelta)}</td>
                  <td className="text-right">{pct(r.winRateDelta)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
