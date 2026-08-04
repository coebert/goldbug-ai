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

  // Deposits/withdrawals move the tile legitimately — those days are recorded
  // in the report for the audit trail but are not pricing faults.
  const jumps = (data?.jumps ?? []).filter((j) => !j.benign);
  const gaps = data?.gaps ?? [];
  if (jumps.length === 0 && gaps.length === 0) return null;

  const tone = jumps.length > 0 ? "destructive" : "amber";

  return (
    <div
      className={`rounded-xl border p-4 ${
        tone === "destructive"
          ? "border-destructive/50 bg-destructive/10"
          : "border-warning/50 bg-warning/10"
      } ${className ?? ""}`}
      data-testid="valuation-consistency-alert"
      role="alert"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          className={`mt-0.5 h-5 w-5 shrink-0 ${
            tone === "destructive" ? "text-destructive" : "text-warning"
          }`}
        />
        <div className="min-w-0 space-y-3">
          {jumps.length > 0 ? (
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
          ) : null}

          {jumps.length > 0 ? (
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
                  <ul className="space-y-1 pl-3">
                    {jump.suspect_symbols.map((s) => (
                      <li key={s.symbol} className="text-[11px] text-muted-foreground">
                        <span className="font-mono text-foreground">{s.symbol}</span> — {s.reason} ·{" "}
                        {fmt(s.value_base)} {data?.base_ccy} ({fmt(s.weight * 100, 1)}% of book)
                        <div className="font-mono text-[10px] text-muted-foreground/80">
                          FX {s.fx.from_ccy} → {s.fx.to_ccy} @ {fmt(s.fx.rate, 4)} ({s.fx.pair})
                          {s.fx.assumed ? " · no rate found, 1.0 assumed" : null}
                        </div>
                        <div className="font-mono text-[10px] text-muted-foreground/70">
                          {s.fx.detail}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {jump.fx_breakdown.length > 0 ? (
                  <div className="pl-3">
                    <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                      FX conversion on {jump.date}
                    </p>
                    <ul className="space-y-0.5">
                      {jump.fx_breakdown.map((leg) => (
                        <li
                          key={leg.from_ccy}
                          className="font-mono text-[10px] text-muted-foreground"
                        >
                          {leg.from_ccy} → {leg.to_ccy} @ {fmt(leg.rate, 4)} · {fmt(leg.value_from)}{" "}
                          {leg.from_ccy} = {fmt(leg.value_to)} {leg.to_ccy} ·{" "}
                          {fmt(leg.weight * 100, 1)}% of marks · {leg.positions}{" "}
                          {leg.positions === 1 ? "position" : "positions"}
                          {leg.assumed ? " · rate assumed 1.0" : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

              </li>
            ))}
          </ul>
          ) : null}

          {gaps.length > 0 ? (
            <div className="space-y-2" data-testid="snapshot-continuity-gaps">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  Missing snapshot {gaps.length === 1 ? "day" : "days"} detected
                </p>
                <p className="text-xs text-muted-foreground">
                  {gaps.length} gap{gaps.length === 1 ? "" : "s"} of{" "}
                  {fmt(data?.gapThreshold ?? 2, 0)}+ trading days. Values either side can look
                  plausible, so the jump check stays quiet while the chart interpolates.
                </p>
              </div>
              <ul className="space-y-1">
                {gaps.slice(0, 5).map((gap) => (
                  <li key={`${gap.from}-${gap.to}`} className="space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-foreground">
                        {gap.from} → {gap.to}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {gap.missing_weekdays} trading{" "}
                        {gap.missing_weekdays === 1 ? "day" : "days"} missing
                      </Badge>
                      <Badge variant="secondary" className="text-[10px]">
                        {gap.kind === "trailing" ? "Stale tail" : "Interior gap"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{gap.explanation}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <p className="text-[11px] text-muted-foreground">
            Use the price-unit audit trail below to see the full arithmetic for the affected day,
            then "Revalue history" to rewrite the stored snapshots.
          </p>
        </div>
      </div>
    </div>
  );
}
