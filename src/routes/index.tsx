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
import { useExperienceLevel } from "@/lib/use-experience-level";
import { deriveNextAction } from "@/lib/next-action";
import { getMarketStatusOverview } from "@/lib/market-hours";
import { ukHour, ukZoneAbbr } from "@/lib/uk-time";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SectionIndex } from "@/components/nav/section-index";
import { AppHeader } from "@/components/app-header";
import { PageLoading } from "@/components/page-loading";
import { HomeCoachMarks } from "@/components/home-coach-marks";
import { SnapshotMismatchAlert } from "@/components/snapshot-mismatch-alert";
import { PortfolioMirrorAlert } from "@/components/portfolio-mirror-alert";
import { checkPortfolioMirrors } from "@/lib/portfolio-mirror-detect.functions";
import { AdvancedSection } from "@/components/advanced-section";
import { ExperienceLevelToggle } from "@/components/experience-level-toggle";
import { Sparkles, PlusCircle, LineChart } from "lucide-react";

import { TodayHero } from "@/components/home/today-hero";
import { TodayHeroSkeleton } from "@/components/home/today-hero-skeleton";
import { PortfolioListSkeleton } from "@/components/home/portfolio-row-skeleton";
import { MirrorAlertSkeleton } from "@/components/home/mirror-alert-skeleton";
import { DashboardSettings } from "@/components/home/dashboard-settings";
import { NewHereBanner } from "@/components/home/new-here-banner";
import { NextActionCard } from "@/components/home/next-action-card";
import { PortfolioRow } from "@/components/home/portfolio-row";
import { CreatePortfolioCard } from "@/components/home/create-portfolio-card";
import { useFocusMode } from "@/components/home/use-focus-mode";
import { useIdlePrefetch } from "@/hooks/use-idle-prefetch";
import { qk } from "@/lib/query-keys";

// Re-export so existing tests importing from "@/routes/index" keep working.
export { ModeSummaryTile } from "@/components/home/mode-summary-tile";

const AllPortfoliosChart = lazy(() =>
  import("@/components/all-portfolios-chart").then((m) => ({ default: m.AllPortfoliosChart })),
);
const NewsReel = lazy(() =>
  import("@/components/news-reel").then((m) => ({ default: m.NewsReel })),
);
const ExecPostsCard = lazy(() =>
  import("@/components/exec-posts-card").then((m) => ({ default: m.ExecPostsCard })),
);
const TickerWatchCard = lazy(() =>
  import("@/components/ticker-watch-card").then((m) => ({ default: m.TickerWatchCard })),
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

const HOME_SECTIONS = [
  { id: "today", label: "Today" },
  { id: "portfolios", label: "Portfolios" },
  { id: "create-portfolio", label: "New portfolio" },
  { id: "look-deeper", label: "Look deeper" },
] as const;

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
    queryKey: qk.portfolios.all(),
    queryFn: () => list(),
    enabled: !!session,
    // Mobile browsers fire focus/visibility events constantly (tab switches,
    // pull-to-refresh gestures). Serve from cache instead of refetching.
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const equityQ = useQuery({
    queryKey: qk.portfolios.equity(),
    queryFn: () => fetchEquity(),
    enabled: !!session,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
  const checkMirrors = useServerFn(checkPortfolioMirrors);
  const mirrorQ = useQuery({
    queryKey: ["portfolio-mirror-check"],
    queryFn: () => checkMirrors(),
    enabled: !!session,
    // Diagnostic-only: never worth a refetch on focus or remount.
    staleTime: 10 * 60_000,
    gcTime: 15 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });
  const isRefreshingEquity = equityQ.isFetching && !equityQ.isLoading;
  const equityErrored = equityQ.isError && !equityQ.data;
  const equityErrorMessage = equityQ.error instanceof Error ? equityQ.error.message : "Failed to load equity";
  const sparkByPortfolio = useMemo(() => computeSparkByPortfolio(equityQ.data), [equityQ.data]);

  const [includeDeposits, setIncludeDeposits] = useIncludeDeposits();
  const [equityDecimals, setEquityDecimals] = useEquityDecimals();
  const [focusMode, setFocusMode] = useFocusMode();
  const [level] = useExperienceLevel();
  const advanced = level === "advanced";

  const todaySummary = useMemo(() => {
    const series = (equityQ.data?.series ?? []) as Array<Record<string, unknown> & { date: string }>;
    const portfolios = (equityQ.data?.portfolios ?? []) as Array<{ id: string; mode?: string }>;
    const deposits =
      (equityQ.data as { deposits?: Array<{ portfolio_id: string; date: string; amount: number }> } | undefined)
        ?.deposits ?? [];
    return computeModeSummary(series, portfolios, deposits, { includeDeposits });
  }, [equityQ.data, includeDeposits]);

  // "What to do next" — one action, derived from real state.
  const nextAction = useMemo(() => {
    const now = new Date();
    const nextRunLabel = `${String((ukHour(now) + 1) % 24).padStart(2, "0")}:00 ${ukZoneAbbr(now)}`;
    let marketOpen = false;
    try {
      marketOpen = getMarketStatusOverview(now).some((s) => s.phase === "open");
    } catch {
      marketOpen = false;
    }
    return deriveNextAction({
      portfolios: (q.data ?? []) as Array<{ id: string; mode?: string | null }>,
      snapshotCount: (equityQ.data?.series ?? []).length,
      marketOpen,
      nextRunLabel,
    });
  }, [q.data, equityQ.data]);

  // Warm the sections a phone user most often opens next: the real-money
  // portfolio detail page, then Trades, Learn and Compare. Idle-time only,
  // mobile-only, and skipped on Data Saver / 2g.
  const prefetchTargets = useMemo(() => {
    const list = q.data ?? [];
    const first = list.find((p) => p.mode === "live_prod") ?? list[0];
    return [
      ...(first ? [{ to: "/portfolio/$id", params: { id: first.id } }] : []),
      { to: "/trades" },
      { to: "/learn" },
      { to: "/compare" },
    ];
  }, [q.data]);
  useIdlePrefetch(prefetchTargets, { enabled: ready && !!session });

  if (!ready || !session) return <PageLoading />;


  const portfolioCount = q.data?.length ?? 0;
  const allPortfolios = q.data ?? [];
  const realPortfolios = allPortfolios.filter((p) => p.mode === "live_prod");
  const simPortfolios = allPortfolios.filter((p) => p.mode !== "live_prod");

  const renderPortfolioRow = (p: (typeof allPortfolios)[number]) => (
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
      holdings={
        (equityQ.data as {
          holdingsByPortfolio?: Record<
            string,
            Array<{ symbol: string; quantity: number; avg_cost: number; asset_class: string | null }>
          >;
        } | undefined)?.holdingsByPortfolio?.[p.id] ?? []
      }
    />
  );


  return (
    <div className="min-h-dvh overflow-x-hidden bg-surface-1">
      <AppHeader email={session?.user.email} />
      <HomeCoachMarks />
      <main className="mx-auto max-w-6xl px-4 py-5 sm:py-8 2xl:max-w-7xl">
        {/* Page heading + density control */}
        <div className="mb-5 space-y-3 sm:mb-7 sm:flex sm:flex-wrap sm:items-start sm:justify-between sm:gap-3 sm:space-y-0">
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Your money</h1>
            <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
              {portfolioCount === 0
                ? "Nothing set up yet — start with pretend money and watch how the AI invests."
                : "Everything below updates by itself. The AI reviews the market every hour."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2.5 sm:shrink-0 sm:flex-nowrap sm:gap-2">
            <ExperienceLevelToggle />
            <DashboardSettings
              includeDeposits={includeDeposits}
              onIncludeDepositsChange={setIncludeDeposits}
              equityDecimals={equityDecimals}
              onEquityDecimalsChange={setEquityDecimals}
              focusMode={focusMode}
              onFocusModeChange={setFocusMode}
            />
            <a href="#create-portfolio" className="hidden sm:inline-flex">
              <Button size="sm">
                <PlusCircle className="mr-1 h-4 w-4" /> New portfolio
              </Button>
            </a>
            <a href="#create-portfolio" className="ml-auto sm:hidden">
              <Button size="sm" className="min-h-11 px-4">
                <PlusCircle className="mr-1 h-4 w-4" /> New
              </Button>
            </a>
          </div>
        </div>


        <SnapshotMismatchAlert mismatches={equityQ.data?.mismatches ?? []} />

        {mirrorQ.isLoading && portfolioCount > 1 ? (
          <MirrorAlertSkeleton />
        ) : (
          <PortfolioMirrorAlert findings={mirrorQ.data?.findings ?? []} />
        )}

        <SectionIndex items={HOME_SECTIONS} />

        {/* Bento: the answer to "how am I doing?" beside "what should I do?" */}
        <div id="today" className="mb-6 grid scroll-mt-28 gap-4 lg:grid-cols-3">
          <div className="min-w-0 lg:col-span-2">
            {equityQ.isLoading && !equityQ.data ? (
              <TodayHeroSkeleton />
            ) : (
              <TodayHero
                summary={todaySummary}
                mixedCurrency={equityQ.data?.mixedCurrency ?? false}
                currencies={equityQ.data?.currencies ?? []}
              />
            )}
          </div>
          <NextActionCard action={nextAction} className="min-w-0" />
        </div>

        <NewHereBanner />

        {/* Markets live on their own page now — Home keeps one compact
            link so the wider picture is always one tap away. */}
        <Link
          to="/markets"
          className="mb-6 grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:bg-muted"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">Markets today</span>
            <span className="block truncate text-xs text-muted-foreground">
              Market pulse, moving-average trends and trading hours
            </span>
          </span>
          <LineChart className="h-5 w-5 shrink-0 text-primary" aria-hidden />
        </Link>


        {/* Portfolios — real money first, practice money folded away */}
        <div id="portfolios" className="grid scroll-mt-28 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-3">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="font-display text-lg font-semibold tracking-tight">Real money</h2>
              <span className="text-xs text-muted-foreground">
                {portfolioCount === 0 ? "" : `${portfolioCount} portfolio${portfolioCount === 1 ? "" : "s"} in total`}
              </span>
            </div>
            {q.isLoading && <PortfolioListSkeleton count={1} />}
            {q.data && q.data.length === 0 && (
              <Card className="border-primary/40 bg-primary/5">
                <CardContent className="flex flex-col items-start gap-3 py-8 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2 font-medium">
                      <Sparkles className="h-4 w-4 text-primary" /> Start with a guided £1000 demo
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      A 3-step walkthrough that creates your first practice portfolio and runs the AI's first
                      trades — no real money involved.
                    </p>
                  </div>
                  <Link to="/get-started">
                    <Button className="w-full sm:w-auto">Start demo</Button>
                  </Link>
                </CardContent>
              </Card>
            )}
            {q.data && q.data.length > 0 && realPortfolios.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No real-money portfolio connected yet. Your practice portfolios are below.
              </p>
            )}
            {realPortfolios.map(renderPortfolioRow)}

            {simPortfolios.length > 0 && (
              <div className="pt-3">
                <AdvancedSection
                  title={`Practice portfolios (${simPortfolios.length})`}
                  summary="Simulated money at real prices. Useful for comparison — no real cash involved."
                  defaultOpen={false}
                >
                  <div className="space-y-3">{simPortfolios.map(renderPortfolioRow)}</div>
                </AdvancedSection>
              </div>
            )}
          </div>
          <div id="create-portfolio" className="min-w-0 scroll-mt-24">
            <CreatePortfolioCard />
          </div>
        </div>


        {/* Everything expert-level lives here: present, labelled in plain
            English, but folded away unless asked for. */}
        {level === "simple" && (
          <p className="mt-8 text-xs text-muted-foreground">
            Showing the essentials. Switch to <strong className="font-medium">Standard</strong> or{" "}
            <strong className="font-medium">Everything</strong> at the top of the page for the
            deeper panels.
          </p>
        )}

        {!focusMode && level !== "simple" && (
          <div id="look-deeper" className="mt-8 scroll-mt-28 space-y-3">
            <h2 className="font-display text-lg font-semibold tracking-tight">Look deeper</h2>
            <p className="-mt-2 text-xs text-muted-foreground">
              Optional detail. Nothing here needs your attention day to day.
            </p>

            <AdvancedSection
              title="All portfolios on one chart"
              summary="Your combined value over time, every portfolio added together."
              defaultOpen={advanced}
            >
              <Suspense fallback={<div className="h-64 rounded-md border bg-card/50" aria-hidden="true" />}>
                <AllPortfoliosChart />
              </Suspense>
            </AdvancedSection>

            <AdvancedSection
              title="Symbols the AI is watching"
              summary="Individual shares under close watch, with the price levels that trigger an alert."
              defaultOpen
            >
              <Suspense fallback={<div className="h-64 rounded-md border bg-card/50" aria-hidden="true" />}>
                <TickerWatchCard />
              </Suspense>
              <p className="mt-2 text-xs text-muted-foreground">
                Scanners and backtests moved to{" "}
                <Link to="/research" className="text-primary underline-offset-2 hover:underline">
                  Research
                </Link>
                .
              </p>
            </AdvancedSection>

            <AdvancedSection
              title="CEO posts the AI is tracking"
              summary="Market-moving social posts by figures such as Elon Musk, and the symbols they affect."
              defaultOpen={advanced}
            >
              <Suspense fallback={<div className="h-64 rounded-md border bg-card/50" aria-hidden="true" />}>
                <ExecPostsCard />
              </Suspense>
            </AdvancedSection>


            <AdvancedSection
              title="News the AI is reading"
              summary="Headlines feeding this hour's decisions, grouped by company or asset."
              defaultOpen={advanced}
            >
              <div data-coach="news-reel">
                <Suspense fallback={<div className="h-80 rounded-md border bg-card/50" aria-hidden="true" />}>
                  <NewsReel />
                </Suspense>
              </div>
            </AdvancedSection>

            <AdvancedSection
              title="Why the AI bought and sold"
              summary="Each recent decision traced back to the news and signals behind it."
              defaultOpen={advanced}
            >
              <Suspense fallback={<div className="h-80 rounded-md border bg-card/50" aria-hidden="true" />}>
                <DecisionNewsBreakdown />
              </Suspense>
            </AdvancedSection>
          </div>
        )}
      </main>
    </div>
  );
}
