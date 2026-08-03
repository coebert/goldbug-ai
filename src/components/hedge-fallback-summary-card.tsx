import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, ArrowRight, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getHedgeFallbackReport } from "@/lib/hedging/hedge-fallback-analytics.functions";
import type { FallbackGroup, HedgeOutcome } from "@/lib/hedging/hedge-fallback-analytics";

const OUTCOME_LABEL: Record<HedgeOutcome, string> = {
  established: "Hedge on",
  partial: "Partly on",
  failed: "Never got on",
  pending: "Awaiting next run",
};

const OUTCOME_VARIANT: Record<HedgeOutcome, "default" | "secondary" | "destructive" | "outline"> = {
  established: "default",
  partial: "secondary",
  failed: "destructive",
  pending: "outline",
};

function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

function money(v: number, ccy: string): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: ccy || "GBP",
      maximumFractionDigits: 0,
    }).format(v);
  } catch {
    return `${Math.round(v)}`;
  }
}

function GroupTable({ title, groups, ccy }: { title: string; groups: FallbackGroup[]; ccy: string }) {
  if (groups.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border">
              <th className="py-1 text-left font-medium">Group</th>
              <th className="py-1 text-right font-medium">Uses</th>
              <th className="py-1 text-right font-medium">Hedge on</th>
              <th className="py-1 text-right font-medium">Failed</th>
              <th className="py-1 text-right font-medium">Success</th>
              <th className="py-1 text-right font-medium">Notional</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key} className="border-b border-border/50 last:border-0">
                <td className="py-1.5 pr-2 font-mono text-foreground">{g.label}</td>
                <td className="py-1.5 text-right tabular-nums">{g.events}</td>
                <td className="py-1.5 text-right tabular-nums">{g.established}</td>
                <td className="py-1.5 text-right tabular-nums">{g.failed}</td>
                <td className="py-1.5 text-right tabular-nums">{pct(g.successRate)}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {money(g.substitutedNotional, ccy)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function HedgeFallbackSummaryCard({ days = 90 }: { days?: number }) {
  const load = useServerFn(getHedgeFallbackReport);
  const q = useQuery({
    queryKey: ["hedge-fallback-report", days],
    queryFn: () => load({ data: { days } }),
  });

  const report = q.data;
  const baseCcy = report?.byCurrency[0]?.label ?? "GBP";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          Hedge instrument fallbacks
        </CardTitle>
        {report && report.totals.events > 0 && (
          <Badge variant="outline">{pct(report.totals.successRate)} eventually hedged</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          When the primary gold hedge is unusable (broker block, no price, not in universe), the
          executor walks the ladder to a substitute. This shows how often that happened over the
          last {days} days, by account currency and instrument pair, and whether the hedge actually
          got on afterwards.
        </p>

        {q.isLoading && <p className="text-sm text-muted-foreground">Loading hedge fallbacks…</p>}
        {q.error && (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Could not load the hedge fallback report.
          </p>
        )}

        {report && report.totals.events === 0 && !q.isLoading && (
          <p className="text-sm text-muted-foreground">
            No hedge substitutions in this window — every tail hedge used its primary instrument.
          </p>
        )}

        {report && report.totals.events > 0 && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["Substitutions", String(report.totals.events)],
                ["Hedge on", String(report.totals.established)],
                ["Never got on", String(report.totals.failed)],
                ["Pairs used", String(report.totals.distinctPairs)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-border bg-muted/30 p-2">
                  <div className="text-[11px] text-muted-foreground">{label}</div>
                  <div className="text-lg font-semibold tabular-nums text-foreground">{value}</div>
                </div>
              ))}
            </div>

            <GroupTable title="By account currency" groups={report.byCurrency} ccy={baseCcy} />
            <GroupTable title="By instrument pair" groups={report.byPair} ccy={baseCcy} />

            <div className="space-y-2">
              <h3 className="text-sm font-medium text-foreground">Substitution log</h3>
              {report.events.slice(0, 30).map((e) => (
                <div
                  key={`${e.decisionId}-${e.from}-${e.to}`}
                  className="rounded-lg border border-border bg-muted/30 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex items-center gap-1 font-mono text-sm text-foreground">
                      {e.from}
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      {e.to}
                    </span>
                    <Badge variant={OUTCOME_VARIANT[e.outcome]}>{OUTCOME_LABEL[e.outcome]}</Badge>
                    <Badge variant="outline">{e.currency}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {e.runDate} · {e.portfolioName}
                    </span>
                  </div>
                  <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
                    <div>
                      <dt className="inline font-medium text-foreground">Why substituted: </dt>
                      <dd className="inline">{e.why}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-foreground">Side: </dt>
                      <dd className="inline">{e.side}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-foreground">Target hedge: </dt>
                      <dd className="inline tabular-nums">
                        {money(e.targetNotional, e.currency)}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-foreground">Best observed: </dt>
                      <dd className="inline tabular-nums">
                        {money(e.bestObservedNotional, e.currency)}
                      </dd>
                    </div>
                    {e.succeededOn && (
                      <div>
                        <dt className="inline font-medium text-foreground">Hedge on from: </dt>
                        <dd className="inline">{e.succeededOn}</dd>
                      </div>
                    )}
                    {e.deferralReason && (
                      <div>
                        <dt className="inline font-medium text-foreground">Deferral: </dt>
                        <dd className="inline">{e.deferralReason}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
