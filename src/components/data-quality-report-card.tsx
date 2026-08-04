import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, FileSearch, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getDataQualityReport } from "@/lib/data-quality-report.functions";
import type { CostBasisSource, PortfolioDataQuality } from "@/lib/data-quality-report";

const SOURCE_LABEL: Record<CostBasisSource, string> = {
  fills_ledger: "From trade ledger",
  broker_avg_cost: "Broker average cost",
  mixed: "Part ledger, part broker",
  unknown: "No cost basis",
};

function qty(n: number): string {
  return n.toLocaleString("en-GB", { maximumFractionDigits: 4 });
}

function money(n: number, ccy: string): string {
  return `${ccy} ${n.toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;
}

function signed(n: number, ccy: string): string {
  return `${n < 0 ? "−" : "+"}${money(Math.abs(n), ccy)}`;
}

function PortfolioBlock({ p }: { p: PortfolioDataQuality }) {
  // Only the positions the ledger cannot fully explain are worth the space —
  // a fully backed book needs no explanation.
  const gaps = p.positions.filter((x) => x.costBasisSource !== "fills_ledger");

  return (
    <div
      className={`min-w-0 rounded-lg border p-3 ${
        p.severity === "warn"
          ? "border-destructive/40 bg-destructive/5"
          : p.severity === "info"
            ? "border-border bg-muted/30"
            : "border-border"
      }`}
    >
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-2">
        <p className="min-w-0 break-words text-sm font-semibold text-foreground">
          {p.portfolioName}
          <span className="ml-2 text-xs font-normal uppercase tracking-wide text-muted-foreground">
            {p.mode ?? "—"}
          </span>
        </p>
        <Badge
          variant="outline"
          className={`w-fit shrink-0 ${
            p.severity === "warn"
              ? "border-destructive/50 text-destructive"
              : "border-border text-muted-foreground"
          }`}
        >
          {p.summary.fullyBacked}/{p.summary.positions} fully backed
        </Badge>
      </div>

      {gaps.length === 0 ? (
        <p className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          Every position replays from the trade ledger, so cost basis and historical cash both come
          from recorded fills.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {gaps.map((x) => (
            <li key={x.holdingSymbol} className="min-w-0 rounded-md border border-border/60 p-2.5">
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-2">
                <p className="min-w-0 break-all font-mono text-sm font-semibold text-foreground">
                  {x.holdingSymbol}
                </p>
                <Badge
                  variant="outline"
                  className={`w-fit shrink-0 text-xs ${
                    x.severity === "warn"
                      ? "border-destructive/50 text-destructive"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  {SOURCE_LABEL[x.costBasisSource]}
                </Badge>
              </div>
              <dl className="mt-2 grid grid-cols-1 gap-1 text-xs text-muted-foreground sm:grid-cols-4 sm:gap-2">
                {[
                  { label: "Held", value: qty(x.quantity) },
                  { label: "From fills", value: qty(x.backedQuantity) },
                  { label: "No fill", value: qty(x.unbackedQuantity) },
                  {
                    label: "Unexplained cost",
                    value: money(x.unbackedCostBase, p.baseCcy),
                  },
                ].map((m) => (
                  <div
                    key={m.label}
                    className="flex min-w-0 items-baseline justify-between gap-2 sm:block"
                  >
                    <dt className="shrink-0 uppercase tracking-wide">{m.label}</dt>
                    <dd className="min-w-0 break-words text-right font-medium tabular-nums text-foreground sm:mt-0.5 sm:text-left">
                      {m.value}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{x.explanation}</p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 rounded-md bg-muted/40 p-2.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          How cash history was reconstructed
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{p.cash.explanation}</p>
        {p.cash.legs.length > 0 && (
          <ul className="mt-2 space-y-1">
            {p.cash.legs.map((leg) => (
              <li
                key={leg.kind}
                className="flex min-w-0 flex-col gap-0.5 text-xs sm:flex-row sm:items-baseline sm:justify-between sm:gap-3"
              >
                <span className="min-w-0 break-words text-muted-foreground">
                  {leg.label} <span className="tabular-nums">({leg.count})</span>
                </span>
                <span className="shrink-0 font-medium tabular-nums text-foreground">
                  {signed(leg.amountBase, p.baseCcy)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {p.cash.blockers.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs text-destructive">
            {p.cash.blockers.map((b) => (
              <li key={b} className="min-w-0 break-words">
                {b}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function DataQualityReportCard({
  portfolioId,
  className,
}: {
  portfolioId?: string;
  className?: string;
}) {
  const load = useServerFn(getDataQualityReport);
  const q = useQuery({
    queryKey: ["data-quality-report", portfolioId ?? "all"],
    queryFn: () => load({ data: { portfolioId } }),
    staleTime: 60_000,
  });

  const report = q.data;

  return (
    <Card className={className}>
      <CardHeader className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <CardTitle className="flex min-w-0 items-center gap-2 text-base">
          <FileSearch className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 break-words">Data quality: broker-synced positions</span>
        </CardTitle>
        {report && (
          <Badge variant="outline" className="w-fit shrink-0">
            {report.totals.positions} position{report.totals.positions === 1 ? "" : "s"} audited
          </Badge>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {q.isLoading && (
          <p className="text-sm text-muted-foreground">Auditing positions against the fills ledger…</p>
        )}
        {q.error && (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Could not build the data-quality report.
          </p>
        )}

        {report && (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            {report.totals.portfoliosWithGaps === 0 ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            ) : (
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span className="min-w-0">
              {report.totals.portfoliosWithGaps === 0
                ? "Every position across all accounts is backed by recorded fills — no reconstructed cost basis anywhere."
                : `${report.totals.unbackedPositions + report.totals.partiallyBackedPositions} position${
                    report.totals.unbackedPositions + report.totals.partiallyBackedPositions === 1
                      ? ""
                      : "s"
                  } across ${report.totals.portfoliosWithGaps} account${
                    report.totals.portfoliosWithGaps === 1 ? "" : "s"
                  } arrived by broker sync without matching fills. Their cost basis and the cash they consumed were reconstructed as described below.`}
            </span>
          </p>
        )}

        {(report?.portfolios ?? []).map((p) => (
          <PortfolioBlock key={p.portfolioId} p={p} />
        ))}
      </CardContent>
    </Card>
  );
}
