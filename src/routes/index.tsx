import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, lazy, Suspense } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listPortfolios, getAllPortfoliosEquity } from "@/lib/trading.functions";
import { computeSparkByPortfolio } from "@/lib/spark-by-portfolio";
import { computeModeSummary } from "@/lib/mode-summary";
import { useIncludeDeposits } from "@/lib/use-include-deposits";
import { useEquityDecimals } from "@/lib/use-equity-decimals";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AppHeader } from "@/components/app-header";
import { PageLoading } from "@/components/page-loading";
import { HomeCoachMarks } from "@/components/home-coach-marks";
import { SnapshotMismatchAlert } from "@/components/snapshot-mismatch-alert";
import { Sparkles, Banknote, PlusCircle, Newspaper, Brain, LineChart } from "lucide-react";

import { TodayHero } from "@/components/home/today-hero";
import { DashboardSettings } from "@/components/home/dashboard-settings";
import { SectionHeader } from "@/components/home/section-header";
import { useFocusMode } from "@/components/home/use-focus-mode";
import { NewHereBanner } from "@/components/home/new-here-banner";
import { PortfolioRow } from "@/components/home/portfolio-row";
import { CreatePortfolioCard } from "@/components/home/create-portfolio-card";

// Re-export so existing tests importing from "@/routes/index" keep working.
export { ModeSummaryTile } from "@/components/home/mode-summary-tile";

const AllPortfoliosChart = lazy(() =>
  import("@/components/all-portfolios-chart").then((m) => ({ default: m.AllPortfoliosChart })),
);
const NewsReel = lazy(() =>
  import("@/components/news-reel").then((m) => ({ default: m.NewsReel })),
);
const DecisionNewsBreakdown = lazy(() =>
  import("@/components/decision-news-breakdown").then((m) => ({ default: m.DecisionNewsBreakdown })),
);

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Aegis — Your AI Paper Portfolios" },
      {
        name: "description",
        content: "Manage AI-driven paper trading portfolios. Backtest, run daily, watch results.",
      },
    ],
  }),
  component: Home,
});

function Home() {
  const navigate = useNavigate();
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
      if (!data.session) navigate({ to: "/auth" });
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (!s) navigate({ to: "/auth" });
    });
    return () => data.subscription.unsubscribe();
  }, [navigate]);

  const list = useServerFn(listPortfolios);
  const fetchEquity = useServerFn(getAllPortfoliosEquity);
  const q = useQuery({
    queryKey: ["portfolios"],
    queryFn: () => list(),
    enabled: !!session,
  });
  const equityQ = useQuery({
    queryKey: ["all-portfolios-equity"],
    queryFn: () => fetchEquity(),
    enabled: !!session,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  const isRefreshingEquity = equityQ.isFetching && !equityQ.isLoading;
  const equityErrored = equityQ.isError && !equityQ.data;
  const equityErrorMessage = equityQ.error instanceof Error ? equityQ.error.message : "Failed to load equity";
  const sparkByPortfolio = useMemo(() => computeSparkByPortfolio(equityQ.data), [equityQ.data]);

  const [includeDeposits, setIncludeDeposits] = useIncludeDeposits();
  const [equityDecimals, setEquityDecimals] = useEquityDecimals();
  const [focusMode, setFocusMode] = useFocusMode();

  const todaySummary = useMemo(() => {
    const series = (equityQ.data?.series ?? []) as Array<Record<string, unknown> & { date: string }>;
    const portfolios = (equityQ.data?.portfolios ?? []) as Array<{ id: string; mode?: string }>;
    const deposits =
      (equityQ.data as { deposits?: Array<{ portfolio_id: string; date: string; amount: number }> } | undefined)
        ?.deposits ?? [];
    return computeModeSummary(series, portfolios, deposits, { includeDeposits });
  }, [equityQ.data, includeDeposits]);

  if (!ready || !session) return <PageLoading />;

  return (
    <div className="min-h-dvh bg-surface-1">
      <AppHeader email={session.user.email} />
      <HomeCoachMarks />
      <main className="mx-auto max-w-6xl px-4 py-5 sm:py-8">
        {/* Page heading + primary actions */}
        <div className="mb-6 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 sm:mb-8 sm:flex sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Your portfolios</h1>
            <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
              Create a portfolio, pick a risk level, run a backtest, then let the AI make hourly decisions.
            </p>
          </div>
          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            <DashboardSettings
              includeDeposits={includeDeposits}
              onIncludeDepositsChange={setIncludeDeposits}
              equityDecimals={equityDecimals}
              onEquityDecimalsChange={setEquityDecimals}
              focusMode={focusMode}
              onFocusModeChange={setFocusMode}
            />
            <Link to="/get-started">
              <Button variant="secondary" size="sm">
                <Sparkles className="mr-1 h-4 w-4" /> £1000 demo
              </Button>
            </Link>
            <Link to="/saxo-status">
              <Button variant="outline" size="sm" title="Connect your Saxo account to trade real money">
                <Banknote className="mr-1 h-4 w-4" /> Real money setup
              </Button>
            </Link>
          </div>
          {/* Mobile primary CTA + settings */}
          <div className="flex shrink-0 items-center gap-2 sm:hidden">
            <DashboardSettings
              includeDeposits={includeDeposits}
              onIncludeDepositsChange={setIncludeDeposits}
              equityDecimals={equityDecimals}
              onEquityDecimalsChange={setEquityDecimals}
              focusMode={focusMode}
              onFocusModeChange={setFocusMode}
            />
            <a href="#create-portfolio">
              <Button size="sm" className="h-8">
                <PlusCircle className="mr-1 h-4 w-4" /> New
              </Button>
            </a>
          </div>
        </div>

        <SnapshotMismatchAlert mismatches={equityQ.data?.mismatches ?? []} />

        {/* Hero "Today" band — combined equity, delta, next-run countdown, mode tiles */}
        <TodayHero summary={todaySummary} />

        <NewHereBanner />

        {!focusMode && (
          <>
            <section className="mb-6" aria-labelledby="section-overview">
              <SectionHeader
                as="h2"
                icon={LineChart}
                title={<span id="section-overview">All portfolios overview</span>}
                description="Combined equity across every portfolio you own."
              />
              <Suspense fallback={<div className="h-64 rounded-md border bg-card/50" aria-hidden="true" />}>
                <AllPortfoliosChart />
              </Suspense>
            </section>

            <section className="mb-6" data-coach="news-reel" aria-labelledby="section-news">
              <SectionHeader
                as="h2"
                icon={Newspaper}
                title={<span id="section-news">Market news the AI is reading</span>}
                description="Fresh headlines feeding this hour's decisions — grouped by asset."
              />
              <Suspense fallback={<div className="h-80 rounded-md border bg-card/50" aria-hidden="true" />}>
                <NewsReel />
              </Suspense>
            </section>

            <section className="mb-6" aria-labelledby="section-decisions">
              <SectionHeader
                as="h2"
                icon={Brain}
                title={<span id="section-decisions">Why the AI is trading what it's trading</span>}
                description="Latest decisions traced back to the news and signals behind them."
              />
              <Suspense fallback={<div className="h-80 rounded-md border bg-card/50" aria-hidden="true" />}>
                <DecisionNewsBreakdown />
              </Suspense>
            </section>
          </>
        )}

        {/* Portfolios grid + create card */}
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="space-y-3">
            <SectionHeader
              as="h2"
              icon={Sparkles}
              title="Your portfolios"
              description="One card per portfolio — headline equity, sparkline, and quick actions."
            />
            {q.isLoading && <p className="text-sm text-muted-foreground">Loading portfolios…</p>}
            {q.data && q.data.length === 0 && (
              <Card className="border-primary/40 bg-primary/5">
                <CardContent className="flex flex-col items-start gap-3 py-8 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2 font-medium">
                      <Sparkles className="h-4 w-4 text-primary" /> Start with a guided £1000 demo
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      A 3-step walkthrough that creates your first paper portfolio and runs the AI's first trades — no real money.
                    </p>
                  </div>
                  <Link to="/get-started">
                    <Button className="w-full sm:w-auto">Start demo</Button>
                  </Link>
                </CardContent>
              </Card>
            )}
            {q.data?.map((p) => (
              <PortfolioRow
                key={p.id}
                portfolio={p}
                sparkSeries={sparkByPortfolio[p.id] ?? []}
                deposits={((equityQ.data as { deposits?: Array<{ portfolio_id: string; date: string; amount: number }> } | undefined)?.deposits ?? []).filter((d) => d.portfolio_id === p.id).map((d) => ({ date: d.date, amount: d.amount }))}
                includeDeposits={includeDeposits}
                isLoadingEquity={equityQ.isLoading}
                isRefreshingEquity={isRefreshingEquity}
                equityError={equityErrored ? equityErrorMessage : null}
                onRetryEquity={() => equityQ.refetch()}
                equityDecimals={equityDecimals}
                brokerCurrency={
                  (equityQ.data as { brokerCurrencyByPortfolio?: Record<string, string> } | undefined)
                    ?.brokerCurrencyByPortfolio?.[p.id] ?? null
                }
              />
            ))}
          </div>
          <div id="create-portfolio" className="scroll-mt-24">
            <CreatePortfolioCard />
          </div>
        </div>
      </main>
    </div>
  );
}
