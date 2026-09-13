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
import { POLL } from "@/lib/query-keys";

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
    refetchInterval: POLL.SEMI_LIVE,
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

  // Auto-close: a critical breach means the leg is already through the loss
  // budget, so it is unwound immediately rather than waiting for a click. One
  // attempt per symbol per mount; failures surface as a toast and the manual
  // close button on the FX dashboard stays available.
  const qc = useQueryClient();
  const closeFn = useServerFn(closeFxLeg);
  const attempted = useRef<Set<string>>(new Set());
  const [autoClosed, setAutoClosed] = useState<string[]>([]);
  const criticalSymbols =
    report.level === "critical" ? report.breaches.map((b) => b.symbol).join(",") : "";

  useEffect(() => {
    if (!criticalSymbols) return;
    for (const symbol of criticalSymbols.split(",")) {
      if (!symbol || attempted.current.has(symbol)) continue;
      attempted.current.add(symbol);
      void (async () => {
        try {
          const r = await closeFn({ data: { portfolioId, symbol } });
          if (r.ok) {
            setAutoClosed((prev) => [...prev, symbol]);
            toast.success(`Auto-closed ${symbol}`, {
              description: `${r.execution === "spot" ? "Broker spot" : "Wallet"} close at ${r.rate.toFixed(4)} — see the order status card.`,
            });
            void qc.invalidateQueries();
          } else {
            toast.error(`Could not auto-close ${symbol}`, { description: r.detail });
          }
        } catch (e) {
          toast.error(`Could not auto-close ${symbol}`, {
            description: e instanceof Error ? e.message : "close failed",
          });
        }
      })();
    }
  }, [criticalSymbols, portfolioId, closeFn, qc]);

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
          {report.level === "critical" && (
            <p className="font-medium">
              {autoClosed.length > 0
                ? `Auto-closed: ${autoClosed.join(", ")} — the close is logged in the order status card.`
                : "Over-budget legs are being closed automatically at the live rate."}
            </p>
          )}
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
