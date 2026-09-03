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
import { PageShell } from "@/components/layout/page-shell";
import { CardShell } from "@/components/layout/card-shell";

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
import { WhatMovedToday } from "@/components/home/what-moved-today";
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

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Aegis — Your AI trading portfolios" },
      {
        name: "description",
        content:
          "Today's equity, what the AI did this hour and what it plans next, across every portfolio.",
      },
      { property: "og:title", content: "Aegis — Your AI trading portfolios" },
      {
        property: "og:description",
        content: "Today's equity, what the AI did and what it plans next.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Home,
});

const HOME_SECTIONS = [
  { id: "today", label: "Today" },
  { id: "combined-equity", label: "Combined" },
  { id: "portfolios", label: "Portfolios" },
  { id: "create-portfolio", label: "New portfolio" },
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
      <PageShell
        title="Your money"
        purpose={
          portfolioCount === 0
            ? "Nothing set up yet — start with pretend money and watch how the AI invests."
            : "Everything here updates by itself. The AI reviews the market every hour."
        }
        actions={
          <>
            <ExperienceLevelToggle />
            <DashboardSettings
              includeDeposits={includeDeposits}
              onIncludeDepositsChange={setIncludeDeposits}
              equityDecimals={equityDecimals}
              onEquityDecimalsChange={setEquityDecimals}
              focusMode={focusMode}
              onFocusModeChange={setFocusMode}
            />
            <a href="#create-portfolio">
              <Button size="sm" className="min-h-11">
                <PlusCircle className="mr-1 h-4 w-4" /> New portfolio
              </Button>
            </a>
          </>
        }
      >
        <SnapshotMismatchAlert mismatches={equityQ.data?.mismatches ?? []} />

        {mirrorQ.isLoading && portfolioCount > 1 ? (
          <MirrorAlertSkeleton />
        ) : (
          <PortfolioMirrorAlert findings={mirrorQ.data?.findings ?? []} />
        )}

        <SectionIndex items={HOME_SECTIONS} />

        {/* Bento: the answer to "how am I doing?" beside "what should I do?" */}
        <div id="today" className="scroll-below-sticky mb-6 grid gap-4 lg:grid-cols-3">
          <div className="min-w-0 lg:col-span-2">
            {equityQ.isLoading && !equityQ.data ? (
              <TodayHeroSkeleton />
            ) : (
              <TodayHero
                summary={todaySummary}
                mixedCurrency={equityQ.data?.mixedCurrency ?? false}
                currencies={equityQ.data?.currencies ?? []}
                movers={<WhatMovedToday />}
              />
            )}
          </div>
          <NextActionCard action={nextAction} className="min-w-0" />
        </div>

        <NewHereBanner />

        {/* Everything added together — the only chart Home keeps. */}
        {!focusMode && (
          <CardShell
            anchor="combined-equity"
            title="All portfolios on one chart"
            subtitle="Your combined value over time, every portfolio added together."
            level={2}
            className="mb-6"
          >
            <Suspense fallback={<div className="skeleton-shimmer h-64 w-full" aria-hidden="true" />}>
              <AllPortfoliosChart />
            </Suspense>
          </CardShell>
        )}

        {/* Markets live on their own page now — Home keeps one compact
            link so the wider picture is always one tap away. */}
        <Link
          to="/markets"
          className="mb-6 grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl bg-surface-2 px-4 py-3 tween hover:bg-surface-3"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">Markets today</span>
            <span className="block truncate text-xs text-muted-foreground">
              Market pulse, moving-average trends, watchlist and the news the AI is reading
            </span>
          </span>
          <LineChart className="h-5 w-5 shrink-0 text-primary" aria-hidden />
        </Link>

        {/* Portfolios — real money first, practice money folded away */}
        <div
          id="portfolios"
          className="scroll-below-sticky grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]"
        >
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
                  defaultOpen={advanced}
                >
                  <div className="space-y-3">{simPortfolios.map(renderPortfolioRow)}</div>
                </AdvancedSection>
              </div>
            )}
          </div>
          <div id="create-portfolio" className="min-w-0 scroll-below-sticky">
            <CreatePortfolioCard />
          </div>
        </div>

        {/* Home is deliberately one screen now. Everything that used to
            stack below lives on the page it belongs to. */}
        <nav aria-label="Where the deeper panels went" className="mt-8">
          <h2 className="font-display text-lg font-semibold tracking-tight">Go deeper</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The analysis panels moved to the page they belong to. Nothing was removed.
          </p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-3">
            {[
              {
                to: "/markets" as const,
                title: "Markets",
                hint: "Pulse, trends, watchlist, news, CEO posts and policy makers.",
              },
              {
                to: "/trades" as const,
                title: "Trades",
                hint: "Every order, why it was placed, and what it cost.",
              },
              {
                to: "/research" as const,
                title: "Research",
                hint: "Scanners, backtests and walk-forward studies.",
              },
            ].map((l) => (
              <li key={l.to}>
                <Link
                  to={l.to}
                  className="flex min-h-16 flex-col justify-center rounded-xl bg-surface-2 px-4 py-3 tween hover:bg-surface-3"
                >
                  <span className="text-sm font-medium">{l.title}</span>
                  <span className="mt-0.5 text-xs text-muted-foreground">{l.hint}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </PageShell>
    </div>
  );
}

