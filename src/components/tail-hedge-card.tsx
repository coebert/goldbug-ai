// Phase 6 — Tail hedge overlay UI.
//
// Shows the advisory hedge decision for the portfolio: target NAV %,
// notional, and the buy/sell/hold action vs the previously targeted
// hedge. Advisory-only for now — no broker routing.

import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ShieldAlert, ShieldCheck, Shield } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getTailHedgeStatus } from "@/lib/hedging/tail-hedge.functions";

function formatMoney(n: number, currency: string) {
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

export function TailHedgeCard({
  portfolioId,
  currency,
}: {
  portfolioId: string;
  currency: string;
}) {
  const fetchStatus = useServerFn(getTailHedgeStatus);
  const { data, isLoading, error } = useQuery({
    queryKey: ["tail-hedge", portfolioId],
    queryFn: () => fetchStatus({ data: { portfolioId } }),
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Tail hedge overlay</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">Loading…</CardContent>
      </Card>
    );
  }
  if (error || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Tail hedge overlay</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-destructive">
          Unable to compute hedge status.
        </CardContent>
      </Card>
    );
  }

  const Icon =
    data.action === "buy" ? ShieldAlert : data.action === "sell" ? Shield : ShieldCheck;
  const actionLabel =
    data.action === "buy"
      ? "Add hedge"
      : data.action === "sell"
        ? "Trim hedge"
        : "Hold hedge";
  const tone =
    data.action === "buy"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
      : data.action === "sell"
        ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
        : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Icon className="h-4 w-4" />
          Tail hedge overlay
          <Badge variant="outline" className="ml-auto text-[10px] uppercase">
            {data.regime.replace(/_/g, " ")}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <div className="text-muted-foreground">Target</div>
            <div className="text-sm font-medium">
              {(data.targetPctNav * 100).toFixed(2)}% of NAV
            </div>
            <div className="text-[11px] text-muted-foreground">
              {formatMoney(data.targetNotional, currency)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Currently modelled</div>
            <div className="text-sm font-medium">
              {formatMoney(data.currentNotional, currency)}
            </div>
            <div className="text-[11px] text-muted-foreground">
              on NAV {formatMoney(data.nav, currency)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>
            {actionLabel}
          </span>
          {data.action !== "hold" && (
            <span className="text-[11px] text-muted-foreground">
              Δ {formatMoney(data.deltaNotional, currency)}
            </span>
          )}
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {data.reason}. Advisory only — hedge orders are not yet routed to
          the broker; sizing rescales with regime and NAV each tick.
        </p>
      </CardContent>
    </Card>
  );
}
