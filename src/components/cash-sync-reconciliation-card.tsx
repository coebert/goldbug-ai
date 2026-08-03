import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw, ArrowDownCircle, ShieldAlert, Minus, AlertTriangle } from "lucide-react";
import {
  getCashSyncReconciliation,
  type CashSyncReconRow,
} from "@/lib/cash-sync-reconciliation.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function fmtMoney(n: number | null, ccy: string | null) {
  if (n == null || !Number.isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: ccy || "GBP",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return n.toFixed(2);
  }
}

function fmtDelta(n: number | null, ccy: string | null) {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${fmtMoney(Math.abs(n), ccy)}`;
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Verdict = "adjusted" | "blocked" | "no-drift" | "error";

function verdictOf(row: CashSyncReconRow): Verdict {
  if (row.error || (row.status != null && row.status >= 400)) return "error";
  if (row.starting_cash_adjusted) return "adjusted";
  if (row.delta != null && Math.abs(row.delta) < 0.5) return "no-drift";
  return "blocked";
}

function VerdictBadge({ v }: { v: Verdict }) {
  if (v === "adjusted") {
    return (
      <Badge className="gap-1 bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300">
        <ArrowDownCircle className="h-3 w-3" /> Deposit booked
      </Badge>
    );
  }
  if (v === "blocked") {
    return (
      <Badge className="gap-1 bg-amber-500/15 text-amber-800 hover:bg-amber-500/20 dark:text-amber-300">
        <ShieldAlert className="h-3 w-3" /> Gate blocked
      </Badge>
    );
  }
  if (v === "error") {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertTriangle className="h-3 w-3" /> Error
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1">
      <Minus className="h-3 w-3" /> No drift
    </Badge>
  );
}

export function CashSyncReconciliationCard() {
  const fetcher = useServerFn(getCashSyncReconciliation);
  const query = useQuery({
    queryKey: ["cash-sync-reconciliation"],
    queryFn: () => fetcher({ data: { limit: 50 } }),
    staleTime: 30_000,
  });

  const data = query.data;
  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Cash-sync reconciliation</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          CashΔ vs TotalValueΔ decisions from every live CASH_SYNC. Blocked rows
          are drifts the deposit gate refused to book as external inflows.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {data && (
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <Tile label="Syncs" value={String(data.totals.total)} />
            <Tile label="Booked" value={String(data.totals.adjusted)} tone="emerald" />
            <Tile label="Blocked" value={String(data.totals.blocked)} tone="amber" />
            <Tile label="No drift" value={String(data.totals.noDrift)} />
          </div>
        )}

        {query.isLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {query.error && (
          <p className="text-sm text-destructive">
            {(query.error as Error).message}
          </p>
        )}
        {!query.isLoading && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No CASH_SYNC events yet for your live portfolios.
          </p>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[720px] text-xs">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-2 py-2 font-medium">When</th>
                  <th className="px-2 py-2 font-medium">Portfolio</th>
                  <th className="px-2 py-2 font-medium text-right">CashΔ</th>
                  <th className="px-2 py-2 font-medium text-right">Broker cash</th>
                  <th className="px-2 py-2 font-medium text-right">TotalValue</th>
                  <th className="px-2 py-2 font-medium text-right">Starting</th>
                  <th className="px-2 py-2 font-medium">Outcome</th>
                  <th className="px-2 py-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const v = verdictOf(r);
                  const startingChange =
                    r.previous_starting != null && r.new_starting != null
                      ? r.new_starting - r.previous_starting
                      : null;
                  return (
                    <tr key={r.id} className="border-t align-top">
                      <td className="px-2 py-2 whitespace-nowrap text-muted-foreground">
                        {fmtTime(r.created_at)}
                      </td>
                      <td className="px-2 py-2">{r.portfolio_name}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {fmtDelta(r.delta, r.currency)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {fmtMoney(r.broker_cash, r.currency)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {fmtMoney(r.broker_total_value, r.currency)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {fmtMoney(r.new_starting, r.currency)}
                        {startingChange != null && startingChange !== 0 && (
                          <div className="text-[10px] text-muted-foreground">
                            {fmtDelta(startingChange, r.currency)}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <VerdictBadge v={v} />
                      </td>
                      <td className="px-2 py-2 text-muted-foreground max-w-[280px]">
                        {r.error ?? r.deposit_gate_reason ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "emerald" | "amber";
}) {
  const toneClass =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "amber"
        ? "text-amber-600 dark:text-amber-400"
        : "text-foreground";
  return (
    <div className="rounded-md border bg-card p-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={`text-lg font-semibold tabular-nums ${toneClass}`}>
        {value}
      </div>
    </div>
  );
}
