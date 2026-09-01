import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getFxLegQuotes } from "@/lib/fx-leg-quotes.functions";
import { getFxStressReport } from "@/lib/fx-stress-report.functions";
import { closeFxLeg } from "@/lib/fx-leg-close.functions";
import { assessFxRisk } from "@/lib/fx-risk-alert";

/**
 * Live FX risk banner: red when an open funding leg's stress worst case eats
 * too much of the cash buffer or the leg is already through the cut-loss band.
 * Links straight to the FX risk dashboard where the leg can be closed.
 */
export function FxRiskAlertCard({
  portfolioId,
  cashBase,
}: {
  portfolioId: string;
  cashBase: number;
}) {
  const quotesFn = useServerFn(getFxLegQuotes);
  const stressFn = useServerFn(getFxStressReport);

  const quotes = useQuery({
    queryKey: ["fx-leg-quotes", portfolioId],
    queryFn: () => quotesFn({ data: { portfolioId } }),
    refetchInterval: 60_000,
  });
  const stress = useQuery({
    queryKey: ["fx-stress-report", portfolioId],
    queryFn: () => stressFn({ data: { portfolioId, years: 20 } }),
    staleTime: 30 * 60_000,
  });

  const baseCcy = quotes.data?.baseCcy ?? "GBP";
  const stressByPair = new Map(
    (stress.data?.legs ?? []).filter((l) => l.actual && !l.error).map((l) => [l.pair, l]),
  );

  const report = assessFxRisk({
    cashBase,
    legs: (quotes.data?.legs ?? []).map((l) => {
      const pair = `${l.pairBase}${l.quoteCcy}`;
      const st = stressByPair.get(pair);
      return {
        symbol: l.symbol,
        pair,
        quantity: l.quantity,
        notionalBase: l.notionalBase,
        pnlBaseNet: l.pnlBaseNet,
        worstCaseBase: st?.report.worstCaseBase ?? 0,
        worstCaseLabel: st?.report.worstCaseLabel ?? "worst modelled move",
        stale: l.stale || l.rate == null,
      };
    }),
  });

  if (report.level === "ok" || report.breaches.length === 0) return null;

  const money = (n: number) =>
    new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: baseCcy,
      maximumFractionDigits: 0,
      signDisplay: "exceptZero",
    }).format(n);

  return (
    <Alert variant={report.level === "critical" ? "destructive" : "default"}>
      <AlertTitle>
        {report.level === "critical" ? "FX risk over budget" : "FX risk elevated"}
      </AlertTitle>
      <AlertDescription>
        <div className="space-y-2 text-xs">
          <p>{report.summary}</p>
          <ul className="space-y-1">
            {report.breaches.map((b) => (
              <li key={b.symbol}>
                <span className="font-medium">{b.headline}</span> — worst case{" "}
                {money(b.worstCaseBase)}, close now {money(b.pnlBaseNet)}. {b.suggestion}
              </li>
            ))}
          </ul>
          <Button asChild size="sm" variant="outline" className="h-7 px-2 text-xs">
            <Link to="/portfolio/$id/fx-risk" params={{ id: portfolioId }}>
              Review and close legs
            </Link>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
