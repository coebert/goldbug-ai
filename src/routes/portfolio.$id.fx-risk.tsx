import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { PortfolioTabs } from "@/components/portfolio-detail/portfolio-tabs";
import { FxCashAtRiskCard } from "@/components/fx-cash-at-risk-card";
import { FxLegRowsCard } from "@/components/fx-leg-rows-card";
import { FxLegHistoryCard } from "@/components/fx-leg-history-card";
import { FxStressReportCard } from "@/components/fx-stress-report-card";
import { FxPlaybookBacktestCard } from "@/components/fx-playbook-backtest-card";
import { getFxLegQuotes } from "@/lib/fx-leg-quotes.functions";


const TITLE = "FX Risk Dashboard — Aegis";
const DESC =
  "Live FX funding-leg marks, decision log, playbook backtest and stress scenarios in one view, with a cash-at-risk summary.";

export const Route = createFileRoute("/portfolio/$id/fx-risk")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESC },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESC },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: FxRiskPage,
  errorComponent: ({ error, reset }) => (
    <div className="p-6 text-sm">
      <p className="text-destructive">{(error as Error).message}</p>
      <Button className="mt-3" onClick={reset}>
        Retry
      </Button>
    </div>
  ),
  notFoundComponent: () => <div className="p-6">Not found</div>,
});

const REFERENCE_PAIRS = ["GBPUSD", "GBPEUR", "EURUSD", "GBPJPY"];

function FxRiskPage() {
  const { id } = Route.useParams();
  const [pair, setPair] = useState<string | undefined>(undefined);
  const quotesFn = useServerFn(getFxLegQuotes);
  const quotes = useQuery({
    queryKey: ["fx-leg-quotes", id],
    queryFn: () => quotesFn({ data: { portfolioId: id } }),
    refetchInterval: 60_000,
  });

  const openPairs = Array.from(
    new Set((quotes.data?.legs ?? []).map((l) => `${l.pairBase}${l.quoteCcy}`)),
  );
  const pairs = Array.from(new Set([...openPairs, ...REFERENCE_PAIRS]));

  return (
    <div className="min-h-dvh bg-background">
      <AppHeader />
      <main className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
        <PortfolioTabs id={id} />
        <Link
          to="/portfolio/$id"
          params={{ id }}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
        >
          <ArrowLeft className="h-3 w-3" /> Back to portfolio
        </Link>
        <div>
          <h1 className="text-xl font-semibold">FX risk dashboard</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Everything about the currency funding legs in one place: what they are worth now, why
            the AI is keeping or closing them, how the rules performed on historical tape, and what
            a shock would cost.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Currency pair">
          <span className="mr-1 text-xs text-muted-foreground">Pair:</span>
          <Button
            size="sm"
            variant={pair === undefined ? "secondary" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => setPair(undefined)}
          >
            All
          </Button>
          {pairs.map((p) => (
            <Button
              key={p}
              size="sm"
              variant={pair === p ? "secondary" : "ghost"}
              className="h-7 px-2.5 text-xs"
              onClick={() => setPair(p)}
            >
              {p}
              {openPairs.includes(p) ? " •" : ""}
            </Button>
          ))}
        </div>

        <FxCashAtRiskCard portfolioId={id} />
        <FxLegRowsCard portfolioId={id} selectedPair={pair} onSelectPair={setPair} />
        <FxLegHistoryCard portfolioId={id} pairFilter={pair} />
        <FxStressReportCard portfolioId={id} pairFilter={pair} />
        <FxPlaybookBacktestCard portfolioId={id} pairs={pair ? [pair] : undefined} />
      </main>
    </div>
  );
}

