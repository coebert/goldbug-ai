import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getCashSyncHistory } from "@/lib/live.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatUkDateTime } from "@/lib/uk-time";

type Row = {
  id: string;
  created_at: string;
  status: number | null;
  env: string | null;
  request: unknown;
  response: unknown;
  error: string | null;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function fmt(n: number | null, ccy?: string | null) {
  if (n === null) return "—";
  const s = n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return ccy ? `${s} ${ccy}` : s;
}

export function CashReconciliationLogCard({ portfolioId }: { portfolioId: string }) {
  const fetchFn = useServerFn(getCashSyncHistory);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const q = useQuery({
    queryKey: ["cash-sync-history", portfolioId],
    queryFn: () => fetchFn({ data: { portfolioId, limit: 50 } }),
    staleTime: 30_000,
  });

  const rows: Row[] = useMemo(() => (q.data?.rows ?? []) as Row[], [q.data]);

  return (
    <Card>
      <CardHeader className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between">
        <div className="min-w-0">
          <CardTitle>Broker cash reconciliation log</CardTitle>
          <CardDescription>
            Per-run audit of CASH_SYNC decisions: mode, currency match, and whether starting cash was adjusted.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No CASH_SYNC entries recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="text-left py-2 pr-2">When (UK)</th>
                  <th className="text-left py-2 pr-2">Env</th>
                  <th className="text-left py-2 pr-2">Mode</th>
                  <th className="text-left py-2 pr-2">Currency</th>
                  <th className="text-right py-2 pr-2">Prev cash</th>
                  <th className="text-right py-2 pr-2">Broker cash</th>
                  <th className="text-right py-2 pr-2">Δ</th>
                  <th className="text-right py-2 pr-2">Prev start</th>
                  <th className="text-right py-2 pr-2">New start</th>
                  <th className="text-left py-2 pr-2">Starting adjusted?</th>
                  <th className="text-left py-2 pr-2">Local holdings</th>
                  <th className="text-left py-2 pr-2">Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const req = asRecord(r.request);
                  const res = asRecord(r.response);
                  const mode = String(req.mode ?? "");
                  const portfolioCcy = req.portfolioCurrency ? String(req.portfolioCurrency) : null;
                  const brokerCcy = res.currency ? String(res.currency) : null;
                  const currencyMatches = req.currencyMatches === true;
                  const hasLocalHoldings = req.hasLocalHoldings === true;
                  const adjusted = res.startingCashAdjusted === true;
                  const prevCash = num(req.previousCash);
                  const prevStart = num(req.previousStarting);
                  const brokerCash = num(res.brokerCash);
                  const delta = num(res.delta);
                  const newStart = num(res.newStarting);
                  const open = !!expanded[r.id];
                  return (
                    <>
                      <tr key={r.id} className="border-b align-top">
                        <td className="py-2 pr-2 whitespace-nowrap">{formatUkDateTime(r.created_at)}</td>
                        <td className="py-2 pr-2">{r.env ?? "—"}</td>
                        <td className="py-2 pr-2">{mode || "—"}</td>
                        <td className="py-2 pr-2 whitespace-nowrap">
                          <span>{brokerCcy ?? "—"}</span>
                          {portfolioCcy && (
                            <span className="text-muted-foreground"> vs {portfolioCcy}</span>
                          )}{" "}
                          <Badge variant={currencyMatches ? "secondary" : "destructive"}>
                            {currencyMatches ? "match" : "mismatch"}
                          </Badge>
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums">{fmt(prevCash, portfolioCcy)}</td>
                        <td className="py-2 pr-2 text-right tabular-nums">{fmt(brokerCash, brokerCcy)}</td>
                        <td className={`py-2 pr-2 text-right tabular-nums ${delta !== null && delta < 0 ? "text-destructive" : ""}`}>
                          {delta === null ? "—" : (delta >= 0 ? "+" : "") + fmt(delta)}
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums">{fmt(prevStart, portfolioCcy)}</td>
                        <td className="py-2 pr-2 text-right tabular-nums">{fmt(newStart, portfolioCcy)}</td>
                        <td className="py-2 pr-2">
                          <Badge variant={adjusted ? "default" : "outline"}>
                            {adjusted ? "adjusted" : "unchanged"}
                          </Badge>
                        </td>
                        <td className="py-2 pr-2">
                          <Badge variant={hasLocalHoldings ? "secondary" : "outline"}>
                            {hasLocalHoldings ? "yes" : "no"}
                          </Badge>
                        </td>
                        <td className="py-2 pr-2">
                          {r.error ? (
                            <Badge variant="destructive">{r.status ?? "err"}</Badge>
                          ) : (
                            <Badge variant="secondary">{r.status ?? "—"}</Badge>
                          )}
                        </td>
                        <td className="py-2 pr-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setExpanded((s) => ({ ...s, [r.id]: !s[r.id] }))}
                          >
                            {open ? "Hide" : "Raw"}
                          </Button>
                        </td>
                      </tr>
                      {open && (
                        <tr key={`${r.id}-raw`} className="border-b bg-muted/30">
                          <td colSpan={13} className="py-2 pr-2">
                            {r.error && (
                              <p className="text-destructive mb-2">Error: {r.error}</p>
                            )}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div>
                                <p className="text-muted-foreground mb-1">Request</p>
                                <pre className="text-[10px] overflow-x-auto bg-background p-2 rounded border">{JSON.stringify(r.request, null, 2)}</pre>
                              </div>
                              <div>
                                <p className="text-muted-foreground mb-1">Response</p>
                                <pre className="text-[10px] overflow-x-auto bg-background p-2 rounded border">{JSON.stringify(r.response, null, 2)}</pre>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
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
