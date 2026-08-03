import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listSecurityAudit,
  type SecurityAuditRow,
} from "@/lib/security-audit.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShieldAlert, RefreshCw } from "lucide-react";
import { POLL } from "@/lib/query-keys";

const ANY = "__any__";

// Admin review card for the security_audit_log table. Filters (event,
// reason, op, portfolio, time window) are enforced server-side; the UI just
// binds inputs and re-runs the query.
export function SecurityAuditCard() {
  const list = useServerFn(listSecurityAudit);

  const [event, setEvent] = useState<string>("pending_slices");
  const [reason, setReason] = useState<string>(ANY);
  const [op, setOp] = useState<string>(ANY);
  const [portfolioId, setPortfolioId] = useState<string>("");
  const [sinceHours, setSinceHours] = useState<number>(24);
  const [limit, setLimit] = useState<number>(100);

  const filters = useMemo(
    () => ({
      event: event.trim() || undefined,
      reason: reason === ANY ? undefined : reason,
      op: op === ANY ? undefined : op,
      portfolioId: portfolioId.trim() || undefined,
      sinceHours,
      limit,
    }),
    [event, reason, op, portfolioId, sinceHours, limit],
  );

  const q = useQuery({
    queryKey: ["security-audit", filters],
    queryFn: () => list({ data: filters }),
    refetchInterval: POLL.SEMI_LIVE,
  });

  const rows: SecurityAuditRow[] = q.data?.rows ?? [];
  const distinctReasons = q.data?.distinct.reasons ?? [];
  const distinctOps = q.data?.distinct.ops ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-4 w-4 text-amber-500" />
            Security audit log
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${q.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
          <Input
            placeholder="event"
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            aria-label="Event filter"
          />
          <Select value={reason} onValueChange={setReason}>
            <SelectTrigger aria-label="Reason filter">
              <SelectValue placeholder="reason" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any reason</SelectItem>
              {distinctReasons.map((r) => (
                <SelectItem key={r} value={r}>{r}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={op} onValueChange={setOp}>
            <SelectTrigger aria-label="Op filter">
              <SelectValue placeholder="op" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any op</SelectItem>
              {distinctOps.map((o) => (
                <SelectItem key={o} value={o}>{o}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            placeholder="portfolio uuid"
            value={portfolioId}
            onChange={(e) => setPortfolioId(e.target.value)}
            aria-label="Portfolio filter"
          />
          <Select
            value={String(sinceHours)}
            onValueChange={(v) => setSinceHours(Number(v))}
          >
            <SelectTrigger aria-label="Time window">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Last 1h</SelectItem>
              <SelectItem value="6">Last 6h</SelectItem>
              <SelectItem value="24">Last 24h</SelectItem>
              <SelectItem value="168">Last 7d</SelectItem>
              <SelectItem value="720">Last 30d</SelectItem>
            </SelectContent>
          </Select>
          <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
            <SelectTrigger aria-label="Row limit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="50">50 rows</SelectItem>
              <SelectItem value="100">100 rows</SelectItem>
              <SelectItem value="250">250 rows</SelectItem>
              <SelectItem value="500">500 rows</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {q.isError ? (
          <p className="text-sm text-destructive">
            {q.error instanceof Error ? q.error.message : "Failed to load audit log"}
          </p>
        ) : q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No security events match these filters.
          </p>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted/60 text-left">
                <tr>
                  <th className="p-2 font-medium">When</th>
                  <th className="p-2 font-medium">Event</th>
                  <th className="p-2 font-medium">Op</th>
                  <th className="p-2 font-medium">Reason</th>
                  <th className="p-2 font-medium">Portfolio</th>
                  <th className="p-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t align-top">
                    <td className="whitespace-nowrap p-2 text-muted-foreground">
                      {new Date(r.created_at).toLocaleString("en-GB", { timeZone: "Europe/London" })}
                    </td>
                    <td className="p-2">
                      <Badge variant="outline">{r.event}</Badge>
                    </td>
                    <td className="p-2 font-mono">{r.op ?? "—"}</td>
                    <td className="p-2 font-mono text-amber-600 dark:text-amber-400">
                      {r.reason ?? "—"}
                    </td>
                    <td className="p-2 font-mono text-[10px]">
                      {r.portfolio_id ? r.portfolio_id.slice(0, 8) + "…" : "—"}
                    </td>
                    <td className="p-2">
                      <pre className="max-w-md overflow-x-auto whitespace-pre-wrap break-all text-[10px] text-muted-foreground">
                        {typeof r.details === "string"
                          ? r.details
                          : JSON.stringify(r.details, null, 0)}
                      </pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          Showing {rows.length} row{rows.length === 1 ? "" : "s"} attributed to
          your account. Rows with no actor (anonymous callers, cron paths) are
          hidden by policy and reviewed via server logs.
        </p>
      </CardContent>
    </Card>
  );
}
