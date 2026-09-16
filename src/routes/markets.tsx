import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { ChartNoAxesCombined, GitCompare, Network, Newspaper, Radar, Target } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { PageShell, PageSection } from "@/components/layout/page-shell";
import { SectionIndex } from "@/components/nav/section-index";
import { useSessionEmail } from "@/lib/use-session-email";

const MarketPulseCard = lazy(() =>
  import("@/components/home/market-pulse-card").then((m) => ({ default: m.MarketPulseCard })),
);
const SmaTrendCard = lazy(() =>
  import("@/components/home/sma-trend-card").then((m) => ({ default: m.SmaTrendCard })),
);
const InflationCard = lazy(() =>
  import("@/components/inflation-card").then((m) => ({ default: m.InflationCard })),
);
const MarketHoursCard = lazy(() =>
  import("@/components/market-hours-card").then((m) => ({ default: m.MarketHoursCard })),
);
const TickerWatchCard = lazy(() =>
  import("@/components/ticker-watch-card").then((m) => ({ default: m.TickerWatchCard })),
);
const PriceFeedStatusCard = lazy(() =>
  import("@/components/price-feed-status-card").then((m) => ({ default: m.PriceFeedStatusCard })),
);

export const Route = createFileRoute("/markets")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Markets — Aegis" },
      {
        name: "description",
        content:
          "Market pulse, moving-average trends, trading hours, watched symbols and the news the AI is reading.",
      },
      { property: "og:title", content: "Markets — Aegis" },
      {
        property: "og:description",
        content: "Market pulse, moving-average trends, trading hours and live market news.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: MarketsPage,
});

const MARKET_SECTIONS = [
  { id: "conditions", label: "Conditions" },
  { id: "watchlist", label: "Watchlist" },
  { id: "intel", label: "Intel" },
] as const;

const fallback = (h: string) => (
  <div className={`${h} skeleton-shimmer w-full`} aria-hidden="true" />
);

function MarketsPage() {
  const email = useSessionEmail();
  return (
    <div className="min-h-dvh overflow-x-hidden bg-surface-1">
      <AppHeader email={email} />
      <PageShell
        title="Markets"
        purpose="The state of the wider market — read this before judging your own numbers."
        actions={
          <>
            <Link
              to="/news"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-surface-2 px-3 text-sm tween hover:bg-surface-3"
            >
              <Newspaper className="h-4 w-4 text-primary" aria-hidden /> News
            </Link>
            <Link
              to="/compare"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-surface-2 px-3 text-sm tween hover:bg-surface-3"
            >
              <GitCompare className="h-4 w-4 text-primary" aria-hidden /> Compare
            </Link>
            <Link
              to="/spillover"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-surface-2 px-3 text-sm tween hover:bg-surface-3"
            >
              <Network className="h-4 w-4 text-primary" aria-hidden /> Spillover
            </Link>
            <Link
              to="/signals-by-market"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-surface-2 px-3 text-sm tween hover:bg-surface-3"
            >
              <Radar className="h-4 w-4 text-primary" aria-hidden /> Signals by market
            </Link>
            <Link
              to="/global-coverage"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-surface-2 px-3 text-sm tween hover:bg-surface-3"
            >
              <Target className="h-4 w-4 text-primary" aria-hidden /> Global coverage
            </Link>
            <Link
              to="/core-performance"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-surface-2 px-3 text-sm tween hover:bg-surface-3"
            >
              <ChartNoAxesCombined className="h-4 w-4 text-primary" aria-hidden /> Core performance
            </Link>
          </>
        }
      >
        <SectionIndex items={MARKET_SECTIONS} />

        <PageSection
          id="conditions"
          title="Conditions"
          description="Is the market helping or fighting you right now?"
        >
          <div className="space-y-4">
            <Suspense fallback={fallback("h-72")}>
              <MarketPulseCard />
            </Suspense>
            <Suspense fallback={fallback("h-96")}>
              <SmaTrendCard />
            </Suspense>
            <Suspense fallback={fallback("h-40")}>
              <MarketHoursCard />
            </Suspense>
            <Suspense fallback={fallback("h-72")}>
              <InflationCard />
            </Suspense>
          </div>
        </PageSection>

        <PageSection
          id="watchlist"
          title="Watchlist"
          description="Symbols under close watch and the price levels that trigger an alert."
        >
          <Suspense fallback={fallback("h-64")}>
            <TickerWatchCard />
          </Suspense>
        </PageSection>

        <PageSection
          id="intel"
          title="What the AI is reading"
          description="Headlines, executive posts and policy remarks now live on their own page, alongside the decisions they fed."
        >
          <Link
            to="/news"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-surface-2 px-4 text-sm tween hover:bg-surface-3"
          >
            <Newspaper className="h-4 w-4 text-primary" aria-hidden /> Open the news page
          </Link>
        </PageSection>
      </PageShell>
    </div>
  );
}
