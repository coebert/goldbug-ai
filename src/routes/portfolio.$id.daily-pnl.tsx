import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { PortfolioTabs } from "@/components/portfolio-detail/portfolio-tabs";
import { DailyPnlCard } from "@/components/daily-pnl-card";

const TITLE = "Daily profit and loss — Aegis";
const DESC =
  "Each day's net gain on the live account, split into positions, currency hedge legs and broker charges, with a week-by-week rollup.";

export const Route = createFileRoute("/portfolio/$id/daily-pnl")({
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
  component: DailyPnlPage,
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

function DailyPnlPage() {
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
          <h1 className="text-xl font-semibold">Daily profit and loss</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            What the account made or lost each day, with money you paid in or took out removed
            first. Each row splits into your share positions, the currency hedge legs, and the
            charges the broker booked that day — so a losing day with winning shares makes sense.
          </p>
        </div>
        <DailyPnlCard portfolioId={id} />
      </main>
    </div>
  );
}
