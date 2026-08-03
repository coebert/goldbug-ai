import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Coins, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  getInstrumentCcyCheck,
  type InstrumentCcyCheckResult,
} from "@/lib/instrument-ccy-check.functions";
import {
  applyInstrumentCcyFixes,
  type InstrumentCcyFixResult,
} from "@/lib/instrument-ccy-fix.functions";
import { planInstrumentCcyFixes } from "@/lib/instrument-ccy-fix";
import type { Severity } from "@/lib/instrument-ccy-check";
import { qk } from "@/lib/query-keys";

const SEVERITY_VARIANT: Record<Severity, "destructive" | "default" | "secondary"> = {
  high: "destructive",
  medium: "default",
  low: "secondary",
};

/**
 * Flags holdings whose stored `instrument_ccy` disagrees with the listing
 * venue, or whose recent quotes imply a different pence/pound divisor than the
 * one valuation applies.
 */
export function InstrumentCcyAlert({
  portfolioId,
  className,
}: {
  portfolioId: string;
  className?: string;
}) {
  const run = useServerFn(getInstrumentCcyCheck);
  const { data } = useQuery<InstrumentCcyCheckResult>({
    queryKey: ["instrument-ccy-check", portfolioId],
    queryFn: () => run({ data: { portfolioId } }),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const findings = data?.findings ?? [];
  const plan = planInstrumentCcyFixes(findings);

  const fix = useServerFn(applyInstrumentCcyFixes);
  const queryClient = useQueryClient();
  const { mutate: applyFixes, isPending } = useMutation<InstrumentCcyFixResult>({
    mutationFn: () => fix({ data: { portfolioId } }),
    onSuccess: (result) => {
      if (result.errors.length) {
        toast.error(`Could not re-tag ${result.errors.length} holding(s)`, {
          description: result.errors.map((e) => `${e.symbol}: ${e.message}`).join("; "),
        });
      }
      if (result.applied.length) {
        toast.success(
          `Re-tagged ${result.applied.length} holding${result.applied.length === 1 ? "" : "s"}`,
          {
            description: result.applied
              .map((f) => `${f.symbol}: ${f.from_ccy ?? "untagged"} → ${f.to_ccy}`)
              .join(", "),
          },
        );
      } else if (!result.errors.length) {
        toast.info(result.summary);
      }
      void queryClient.invalidateQueries({ queryKey: ["instrument-ccy-check", portfolioId] });
      void queryClient.invalidateQueries({ queryKey: qk.holdings.all() });
      void queryClient.invalidateQueries({ queryKey: qk.portfolio.all() });
    },
    onError: (err: unknown) => {
      toast.error("Bulk currency fix failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    },
  });

  if (findings.length === 0) return null;

  return (
    <div
      className={`rounded-xl border border-destructive/50 bg-destructive/10 p-4 ${className ?? ""}`}
      data-testid="instrument-ccy-alert"
      role="alert"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
        <div className="min-w-0 space-y-3">
          <div>
            <p className="text-sm font-semibold text-destructive">
              Currency / price-unit mismatch on {findings.length} holding
              {findings.length === 1 ? "" : "s"}
            </p>
            <p className="text-xs text-muted-foreground">{data?.summary}</p>
          </div>

          <ul className="space-y-2">
            {findings.slice(0, 6).map((f) => (
              <li
                key={f.symbol}
                className="rounded-lg border border-border/60 bg-card/50 p-2.5"
                data-testid={`instrument-ccy-finding-${f.symbol}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Coins className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-mono text-sm font-semibold text-foreground">
                    {f.symbol}
                  </span>
                  <Badge variant={SEVERITY_VARIANT[f.severity ?? "low"]} className="text-[10px]">
                    {f.declared_ccy ?? "no ccy"} → {f.venue_ccy}
                  </Badge>
                  {f.implied_divisor && f.implied_divisor !== f.expected_divisor ? (
                    <Badge variant="destructive" className="text-[10px]">
                      divisor ÷{f.expected_divisor} vs ÷{f.implied_divisor}
                    </Badge>
                  ) : null}
                </div>
                <ul className="mt-1.5 space-y-1">
                  {f.issues.map((issue) => (
                    <li key={issue.code} className="text-xs text-muted-foreground">
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>

          {findings.length > 6 ? (
            <p className="text-xs text-muted-foreground">
              +{findings.length - 6} more holding{findings.length - 6 === 1 ? "" : "s"} flagged.
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              size="sm"
              variant="destructive"
              disabled={plan.fixes.length === 0 || isPending}
              onClick={() => applyFixes()}
              data-testid="instrument-ccy-bulk-fix"
            >
              <Wand2 className="mr-1.5 h-3.5 w-3.5" />
              {isPending
                ? "Re-tagging…"
                : plan.fixes.length > 0
                  ? `Auto-fix ${plan.fixes.length} currency tag${plan.fixes.length === 1 ? "" : "s"}`
                  : "No safe auto-fix available"}
            </Button>
            <p className="text-xs text-muted-foreground" data-testid="instrument-ccy-fix-summary">
              {plan.summary}
            </p>
          </div>

          {plan.fixes.length > 0 ? (
            <ul className="space-y-1">
              {plan.fixes.map((f) => (
                <li key={f.symbol} className="text-xs text-muted-foreground">
                  <span className="font-mono text-foreground">{f.symbol}</span>{" "}
                  {f.from_ccy ?? "untagged"} → <span className="font-semibold">{f.to_ccy}</span>{" "}
                  <span className="opacity-70">(by {f.source})</span>
                </li>
              ))}
            </ul>
          ) : null}

          {plan.skipped.length > 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="instrument-ccy-fix-skipped">
              Left for manual review: {plan.skipped.map((s) => s.symbol).join(", ")}.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
