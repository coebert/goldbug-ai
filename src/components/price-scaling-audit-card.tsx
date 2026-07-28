import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw, AlertTriangle, ShieldCheck, ShieldAlert } from "lucide-react";
import { runPriceScalingAudit, type ScalingAuditResponse } from "@/lib/price-scaling-audit.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const CATEGORY_LABEL: Record<string, string> = {
  asset_class_mismatch: "Asset class mismatch",
  asset_class_missing: "Missing asset class",
  lse_stock_out_of_gbx_range: "LSE stock outside GBX range",
  lse_etf_out_of_gbp_range: "LSE ETF outside GBP range",
  price_ratio_jump: "Suspicious price jump",
  non_finite_price: "Non-finite price",
  non_positive_price: "Non-positive price",
};

export function PriceScalingAuditCard() {
  const runAudit = useServerFn(runPriceScalingAudit);
  const q = useQuery<ScalingAuditResponse>({
    queryKey: ["price-scaling-audit"],
    queryFn: () => runAudit({ data: {} }),
    staleTime: 60_000,
  });

  const totals = q.data?.totals ?? { scanned: 0, findings: 0, errors: 0, warnings: 0 };
  const findings = q.data?.findings ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            {totals.errors > 0 ? (
              <ShieldAlert className="h-4 w-4 text-destructive" />
            ) : (
              <ShieldCheck className="h-4 w-4 text-primary" />
            )}
            Price scaling audit
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Cross-checks every holding against the canonical asset-class registry
            and re-runs GBX/GBP normalisation to flag unit-mixing drift.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={`h-3 w-3 ${q.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-4 gap-2 text-center text-xs">
          <Tile label="Scanned" value={totals.scanned} />
          <Tile label="Findings" value={totals.findings} tone={totals.findings > 0 ? "warn" : "ok"} />
          <Tile label="Errors" value={totals.errors} tone={totals.errors > 0 ? "err" : "ok"} />
          <Tile label="Warnings" value={totals.warnings} tone={totals.warnings > 0 ? "warn" : "ok"} />
        </div>

        {q.isError && (
          <div className="rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
            Failed to run audit: {(q.error as Error)?.message ?? "unknown error"}
          </div>
        )}

        {q.data && findings.length === 0 && !q.isFetching && (
          <div className="rounded border border-primary/30 bg-primary/5 p-2 text-xs text-primary">
            All {totals.scanned} holdings re-normalised cleanly. No scaling drift detected.
          </div>
        )}

        {findings.length > 0 && (
          <div className="max-h-80 space-y-2 overflow-auto">
            {findings.map((f, i) => (
              <div
                key={`${f.symbol}-${f.category}-${i}`}
                className={`rounded border p-2 text-xs ${
                  f.severity === "error"
                    ? "border-destructive/40 bg-destructive/5"
                    : "border-amber-500/40 bg-amber-500/5"
                }`}
              >
                <div className="flex items-center gap-2">
                  <AlertTriangle
                    className={`h-3 w-3 ${f.severity === "error" ? "text-destructive" : "text-amber-500"}`}
                  />
                  <span className="font-mono font-semibold">{f.symbol}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {CATEGORY_LABEL[f.category] ?? f.category}
                  </Badge>
                  {f.portfolio_name && (
                    <span className="ml-auto text-muted-foreground">{f.portfolio_name}</span>
                  )}
                </div>
                <div className="mt-1 text-muted-foreground">{f.detail}</div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
                  <span>price={f.observed.price ?? "—"}</span>
                  <span>avg={f.observed.avg_cost ?? "—"}</span>
                  <span>qty={f.observed.quantity ?? "—"}</span>
                  <span>ac={f.observed.asset_class ?? "—"}</span>
                  {f.observed.canonical_asset_class && (
                    <span>canonical={f.observed.canonical_asset_class}</span>
                  )}
                  {f.observed.historical_median != null && (
                    <span>median={f.observed.historical_median}</span>
                  )}
                  {f.observed.ratio != null && <span>×{f.observed.ratio.toFixed(1)}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Tile({ label, value, tone = "ok" }: { label: string; value: number; tone?: "ok" | "warn" | "err" }) {
  const cls =
    tone === "err"
      ? "border-destructive/40 bg-destructive/5 text-destructive"
      : tone === "warn"
        ? "border-amber-500/40 bg-amber-500/5 text-amber-600"
        : "border-border bg-muted/30 text-foreground";
  return (
    <div className={`rounded border p-2 ${cls}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}
