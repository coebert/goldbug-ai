// Core Progress: how much of the owner-set core allocation is actually built,
// what it still costs to finish, and when it gets there at the recent pace.
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Target } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { PageShell } from "@/components/layout/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney } from "@/lib/format-money";
import { getCoreProgress } from "@/lib/core-progress.functions";

const TITLE = "Core allocation progress | Goldbug";
const DESC =
  "How much of your long-term core holding is built, the cash still needed to reach the target, and the date it completes at the recent buying pace.";

export const Route = createFileRoute("/core-progress")({
  component: CoreProgressPage,
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: "Core allocation progress" },
      { property: "og:description", content: DESC },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
});

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

function CoreProgressPage() {
  const fetchProgress = useServerFn(getCoreProgress);
  const query = useQuery({
    queryKey: ["core-progress"],
    queryFn: () => fetchProgress({ data: {} }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const d = query.data;

  return (
    <>
      <AppHeader />
      <PageShell
        title="Core progress"
        purpose="Your long-term core holding, how far it is from its target share of the account, and what it still costs to finish."
      >
        <div className="space-y-4">
          {query.isLoading ? (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">Loading…</CardContent>
            </Card>
          ) : query.error ? (
            <Card>
              <CardContent className="p-6 text-sm text-destructive">
                {(query.error as Error).message}
              </CardContent>
            </Card>
          ) : !d ? null : (
            <>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Target className="h-4 w-4" aria-hidden />
                    {d.coreSymbol} core — {pct(d.targetPct)} of the account
                  </CardTitle>
                  <Badge variant={d.enabled ? "secondary" : "outline"}>
                    {d.enabled ? (d.gapBase > 0 ? "Building" : "Complete") : "Off"}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Progress value={Math.round(d.builtFraction * 100)} />
                    <p className="text-sm text-muted-foreground">
                      {pct(d.builtFraction)} built — holding{" "}
                      {formatMoney(d.coreValueBase, d.currency)} of a{" "}
                      {formatMoney(d.targetValueBase, d.currency)} target ({pct(d.currentPct)} of
                      the account today, band ±{pct(d.bandPct)}).
                    </p>
                  </div>

                  <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <Stat
                      label="Still to buy"
                      value={formatMoney(d.gapBase, d.currency)}
                      hint={`${d.ticketsRemaining} ticket${d.ticketsRemaining === 1 ? "" : "s"} at ${formatMoney(d.minTicketBase, d.currency)}`}
                    />
                    <Stat
                      label="Cash needed"
                      value={formatMoney(d.cashNeededBase, d.currency)}
                      hint={`includes about ${formatMoney(d.estimatedFeesBase, d.currency)} of charges`}
                    />
                    <Stat
                      label="Spare cash today"
                      value={formatMoney(d.deployableCashBase, d.currency)}
                      hint={
                        d.cashShortfallBase > 0
                          ? `${formatMoney(d.cashShortfallBase, d.currency)} short`
                          : "enough to finish"
                      }
                    />
                    <Stat
                      label="Target date"
                      value={d.projectedDate ?? "—"}
                      hint={
                        d.paceBasePerDay
                          ? `at ${formatMoney(d.paceBasePerDay * 7, d.currency)} a week`
                          : "no pace yet"
                      }
                    />
                  </dl>

                  <p className="text-sm text-muted-foreground">{d.note}</p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Recent core buys</CardTitle>
                </CardHeader>
                <CardContent>
                  {d.recentBuys.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No core buys filled yet, so no completion date can be estimated.
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Date</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {d.recentBuys.map((b, i) => (
                          <TableRow key={`${b.date}-${i}`}>
                            <TableCell>{b.date}</TableCell>
                            <TableCell className="text-right">
                              {formatMoney(b.amountBase, d.currency)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </PageShell>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
