import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  getValuationConsistency,
  type ValuationConsistencyResult,
} from "@/lib/valuation-consistency.functions";
import type { SuspectedUnitSource } from "@/lib/valuation-consistency";

const SOURCE_LABEL: Record<SuspectedUnitSource, string> = {
  gbx_pence_fold: "Pence (GBX) fold",
  missing_fx_rate: "Missing FX rate",
  stale_or_missing_quote: "Stale / missing quote",
  cash_movement: "Cash movement",
  unknown: "Unidentified",
};

function fmt(value: number, dp = 2): string {
  return value.toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/**
 * Flags any day where the portfolio tile moved further than a market plausibly
 * can (>3x by default) and names the price-unit step most likely responsible.
 */
export function ValuationConsistencyAlert({
  portfolioId,
  className,
}: {
  portfolioId: string;
  className?: string;
}) {
  const run = useServerFn(getValuationConsistency);
  const { data } = useQuery<ValuationConsistencyResult>({
    queryKey: ["valuation-consistency", portfolioId],
    queryFn: () => run({ data: { portfolioId } }),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const jumps = data?.jumps ?? [];
  if (jumps.length === 0) return null;

  return (
    <div
      className={`rounded-xl border border-destructive/50 bg-destructive/10 p-4 ${className ?? ""}`}
      data-testid="valuation-consistency-alert"
      role="alert"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
        <div className="min-w-0 space-y-3">
          <div>
            <p className="text-sm font-semibold text-destructive">
              Implausible value {jumps.length === 1 ? "jump" : "jumps"} detected
            </p>
            <p className="text-xs text-muted-foreground">
              {jumps.length} day{jumps.length === 1 ? "" : "s"} moved more than{" "}
              {fmt(data?.threshold ?? 3, 0)}x versus the previous snapshot. That is a pricing-unit
              fault, not a market move.
            </p>
          </div>

          <ul className="space-y-3">
            {jumps.slice(0, 5).map((jump) => (
              <li key={`${jump.previous_date}-${jump.date}`} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-foreground">{jump.date}</span>
                  <Badge variant="destructive" className="text-[10px]">
                    {fmt(jump.ratio, 2)}x {jump.direction}
                  </Badge>
                  <Badge variant="outline" className="text-[10px]">
                    {SOURCE_LABEL[jump.suspected_source]}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">{jump.explanation}</p>
                {jump.suspect_symbols.length > 0 ? (
                  <ul className="space-y-0.5 pl-3">
                    {jump.suspect_symbols.map((s) => (
                      <li key={s.symbol} className="text-[11px] text-muted-foreground">
                        <span className="font-mono text-foreground">{s.symbol}</span> — {s.reason} ·{" "}
                        {fmt(s.value_base)} {data?.base_ccy} ({fmt(s.weight * 100, 1)}% of book)
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>

          <p className="text-[11px] text-muted-foreground">
            Use the price-unit audit trail below to see the full arithmetic for the affected day,
            then "Revalue history" to rewrite the stored snapshots.
          </p>
        </div>
      </div>
    </div>
  );
}
