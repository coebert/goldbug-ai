import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, ScaleIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getHoldingsFillsRecon } from "@/lib/holdings-fills-recon.functions";
import type { MismatchKind } from "@/lib/holdings-fills-recon";

const KIND_LABEL: Record<Exclude<MismatchKind, "ok">, string> = {
  phantom_short: "Phantom short",
  holding_without_fills: "Unbacked holding",
  fills_without_holding: "Missing holding",
  quantity_mismatch: "Quantity drift",
};

function qty(n: number): string {
  return n.toLocaleString("en-GB", { maximumFractionDigits: 4 });
}

export function HoldingsFillsReconCard({
  portfolioId,
  className,
}: {
  portfolioId?: string;
  className?: string;
}) {
  const load = useServerFn(getHoldingsFillsRecon);
  const q = useQuery({
    queryKey: ["holdings-fills-recon", portfolioId ?? "all"],
    queryFn: () => load({ data: { portfolioId } }),
    staleTime: 60_000,
  });

  const report = q.data;
  const names = new Map((report?.portfolios ?? []).map((p) => [p.id, p.name ?? "Portfolio"]));
  const rows = report?.rows ?? [];

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ScaleIcon className="h-4 w-4 text-muted-foreground" />
          Ledger vs holdings check
        </CardTitle>
        {report && (
          <Badge variant="outline">
            {report.checked} position{report.checked === 1 ? "" : "s"} checked
          </Badge>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {q.isLoading && (
          <p className="text-sm text-muted-foreground">Replaying the fills ledger…</p>
        )}
        {q.error && (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Could not run the reconciliation check.
          </p>
        )}

        {report && rows.length === 0 && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-primary" />
            Every position replays exactly from the trade ledger — no phantom shorts or unbacked
            holdings.
          </p>
        )}

        {rows.length > 0 && (
          <>
            <p className="text-sm text-muted-foreground">
              {report?.mismatches} mismatch{report?.mismatches === 1 ? "" : "es"}
              {report?.critical ? ` · ${report.critical} needing attention` : ""}
            </p>
            <ul className="space-y-2">
              {rows.map((r) => (
                <li
                  key={`${r.portfolioId}-${r.symbol}`}
                  className={`rounded-lg border p-3 ${
                    r.severity === "critical"
                      ? "border-destructive/40 bg-destructive/5"
                      : "border-border bg-muted/30"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-mono text-sm font-semibold text-foreground">
                      {r.symbol}
                      <span className="ml-2 font-sans text-xs font-normal text-muted-foreground">
                        {names.get(r.portfolioId) ?? "Portfolio"}
                      </span>
                    </p>
                    <Badge
                      variant="outline"
                      className={
                        r.severity === "critical"
                          ? "border-destructive/50 text-destructive"
                          : "border-border text-muted-foreground"
                      }
                    >
                      {r.kind === "ok" ? "Matches" : KIND_LABEL[r.kind]}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Ledger {qty(r.fillsQuantity)} · holdings {qty(r.holdingsQuantity)} · difference{" "}
                    {qty(r.difference)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{r.detail}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
