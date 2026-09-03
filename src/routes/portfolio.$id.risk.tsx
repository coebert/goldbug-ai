import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { PortfolioTabs } from "@/components/portfolio-detail/portfolio-tabs";
import { PositionRiskCard } from "@/components/position-risk-card";

const TITLE = "Live risk dashboard — Aegis";
const DESC =
  "Live position weights, concentration, cash at risk and open FX legs, priced off the broker's own quotes.";

export const Route = createFileRoute("/portfolio/$id/risk")({
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
  component: RiskPage,
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

function RiskPage() {
  const { id } = Route.useParams();
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
          <h1 className="text-xl font-semibold">Live risk dashboard</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Where the money actually sits right now: how much each position is worth as a share of
            the account, how concentrated that is, which cash balances sit in a foreign currency,
            and what the open currency legs are worth. Prices come from the broker where it can
            quote them.
          </p>
        </div>
        <PositionRiskCard portfolioId={id} />
        <p className="text-xs text-muted-foreground">
          Currency legs also have their own page with rate history, stress scenarios and a close
          button:{" "}
          <Link
            to="/portfolio/$id/fx-risk"
            params={{ id }}
            className="underline hover:text-foreground"
          >
            FX risk dashboard
          </Link>
          .
        </p>
      </main>
    </div>
  );
}
