import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { GitCompare, Network } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { useSessionEmail } from "@/lib/use-session-email";

const MarketPulseCard = lazy(() =>
  import("@/components/home/market-pulse-card").then((m) => ({ default: m.MarketPulseCard })),
);
const SmaTrendCard = lazy(() =>
  import("@/components/home/sma-trend-card").then((m) => ({ default: m.SmaTrendCard })),
);
const MarketHoursCard = lazy(() =>
  import("@/components/market-hours-card").then((m) => ({ default: m.MarketHoursCard })),
);
const NewsReel = lazy(() =>
  import("@/components/news-reel").then((m) => ({ default: m.NewsReel })),
);

export const Route = createFileRoute("/markets")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Markets — Aegis" },
      {
        name: "description",
        content:
          "Market pulse, moving-average trends, trading hours and the news the AI is reading.",
      },
      { property: "og:title", content: "Markets — Aegis" },
      {
        property: "og:description",
        content: "Market pulse, moving-average trends, trading hours and live market news.",
      },
    ],
  }),
  component: MarketsPage,
});

const fallback = (h: string) => (
  <div className={`${h} rounded-2xl border border-border bg-card/50`} aria-hidden="true" />
);

function MarketsPage() {
  const email = useSessionEmail();
  return (
    <div className="min-h-dvh overflow-x-hidden bg-surface-1">
      <AppHeader email={email} />
      <main className="mx-auto min-w-0 max-w-6xl px-4 py-5 sm:py-8 2xl:max-w-7xl">
        <header className="mb-5 min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Markets</h1>
          <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
            The state of the wider market — read this before judging your own numbers.
          </p>
        </header>

        <div className="mb-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <Link
            to="/compare"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 text-sm hover:bg-muted"
          >
            <GitCompare className="h-4 w-4 text-primary" aria-hidden /> Compare
          </Link>
          <Link
            to="/spillover"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 text-sm hover:bg-muted"
          >
            <Network className="h-4 w-4 text-primary" aria-hidden /> Spillover
          </Link>
        </div>

        <div className="space-y-6">
          <Suspense fallback={fallback("h-72")}>
            <MarketPulseCard />
          </Suspense>
          <Suspense fallback={fallback("h-96")}>
            <SmaTrendCard />
          </Suspense>
          <Suspense fallback={fallback("h-40")}>
            <MarketHoursCard />
          </Suspense>
          <Suspense fallback={fallback("h-80")}>
            <NewsReel />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
