import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck } from "lucide-react";
import { runStartingCashIntegrityCheck } from "@/lib/starting-cash-integrity.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

function fmt(n: number, ccy: string) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: ccy || "GBP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function StartingCashIntegrityCard() {
  const run = useServerFn(runStartingCashIntegrityCheck);
  const query = useQuery({
    queryKey: ["starting-cash-integrity"],
    queryFn: () => run(),
    staleTime: 60_000,
  });

  const report = query.data;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" />
            Starting-cash integrity
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={`h-3 w-3 ${query.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Verifies <code>starting_cash = seed + Σ recorded deposits</code> per
          portfolio and cross-checks against the earliest equity snapshot.
        </p>

        {query.isLoading && <p className="text-muted-foreground">Running check…</p>}
        {query.error && (
          <Alert className="border-destructive/50 text-destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Check failed</AlertTitle>
            <AlertDescription>{String((query.error as Error).message)}</AlertDescription>
          </Alert>
        )}

        {report && (
          <>
            <div className="flex items-center gap-2">
              {report.flaggedPortfolios === 0 ? (
                <Badge className="bg-emerald-600">
                  <CheckCircle2 className="mr-1 h-3 w-3" />
                  {report.totalPortfolios} portfolios OK
                </Badge>
              ) : (
                <Badge variant="destructive">
                  <AlertTriangle className="mr-1 h-3 w-3" />
                  {report.flaggedPortfolios} of {report.totalPortfolios} flagged
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                Generated {new Date(report.generatedAt).toLocaleTimeString("en-GB")}
              </span>
            </div>

            <div className="space-y-2">
              {report.results.map((r) => (
                <div
                  key={r.portfolioId}
                  className={`rounded border p-3 ${r.ok ? "border-border/50" : "border-destructive/50 bg-destructive/5"}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="font-medium">
                      {r.portfolioName}{" "}
                      <span className="text-xs text-muted-foreground">
                        · {r.mode} · {r.currency}
                      </span>
                    </div>
                    {r.ok ? (
                      <Badge variant="outline" className="text-emerald-600">
                        <CheckCircle2 className="mr-1 h-3 w-3" />
                        OK
                      </Badge>
                    ) : (
                      <Badge variant="destructive">
                        <AlertTriangle className="mr-1 h-3 w-3" />
                        {r.violations.length}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                    <div>
                      <div className="uppercase">Starting cash</div>
                      <div className="tabular-nums text-foreground">
                        {fmt(r.startingCash, r.currency)}
                      </div>
                    </div>
                    <div>
                      <div className="uppercase">Σ deposits</div>
                      <div className="tabular-nums text-foreground">
                        {fmt(r.totalDeposits, r.currency)}
                      </div>
                    </div>
                    <div>
                      <div className="uppercase">Implied seed</div>
                      <div className="tabular-nums text-foreground">
                        {fmt(r.impliedSeed, r.currency)}
                      </div>
                    </div>
                  </div>
                  {r.snapshotSeed != null && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      Earliest snapshot seed:{" "}
                      <span className="tabular-nums text-foreground">
                        {fmt(r.snapshotSeed, r.currency)}
                      </span>
                    </div>
                  )}
                  {!r.ok && (
                    <ul className="mt-2 space-y-1 text-xs">
                      {r.violations.map((v, i) => (
                        <li key={i} className="flex gap-2">
                          <Badge
                            variant={v.severity === "error" ? "destructive" : "outline"}
                            className="shrink-0"
                          >
                            {v.code}
                          </Badge>
                          <span className="text-muted-foreground">{v.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
