// Dedicated news page: the headlines the AI is reading, and how each recent
// decision actually reacted to them. Previously the reel was buried inside an
// "Intel" section on /markets, so the link between a story and a trade was
// hard to find.

import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { ChartNoAxesCombined, Radar } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { PageShell, PageSection } from "@/components/layout/page-shell";
import { SectionIndex } from "@/components/nav/section-index";
import { useSessionEmail } from "@/lib/use-session-email";

const NewsReel = lazy(() =>
  import("@/components/news-reel").then((m) => ({ default: m.NewsReel })),
);
const DecisionNewsBreakdown = lazy(() =>
  import("@/components/decision-news-breakdown").then((m) => ({
    default: m.DecisionNewsBreakdown,
  })),
);
const ExecPostsCard = lazy(() =>
  import("@/components/exec-posts-card").then((m) => ({ default: m.ExecPostsCard })),
);
const PolicyMakersCard = lazy(() =>
  import("@/components/policy-makers-card").then((m) => ({ default: m.PolicyMakersCard })),
);

export const Route = createFileRoute("/news")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "News & AI reaction — Aegis" },
      {
        name: "description",
        content:
          "The latest market headlines the AI is reading, with the trades and decisions each story fed into.",
      },
      { property: "og:title", content: "News & AI reaction — Aegis" },
      {
        property: "og:description",
        content:
          "Live headlines, executive and policy-maker remarks, and how each AI decision reacted to them.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: NewsPage,
});

const NEWS_SECTIONS = [
  { id: "headlines", label: "Headlines" },
  { id: "reaction", label: "AI reaction" },
  { id: "voices", label: "Voices" },
] as const;

const fallback = (h: string) => (
  <div className={`${h} skeleton-shimmer w-full`} aria-hidden="true" />
);

function NewsPage() {
  const email = useSessionEmail();
  return (
    <div className="min-h-dvh overflow-x-hidden bg-surface-1">
      <AppHeader email={email} />
      <PageShell
        title="News"
        purpose="What's happening in the world, and what the AI did about it."
        actions={
          <>
            <Link
              to="/markets"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-surface-2 px-3 text-sm tween hover:bg-surface-3"
            >
              <ChartNoAxesCombined className="h-4 w-4 text-primary" aria-hidden /> Markets
            </Link>
            <Link
              to="/signals-by-market"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-surface-2 px-3 text-sm tween hover:bg-surface-3"
            >
              <Radar className="h-4 w-4 text-primary" aria-hidden /> Signals by market
            </Link>
          </>
        }
      >
        <SectionIndex items={NEWS_SECTIONS} />

        <PageSection
          id="headlines"
          title="Latest headlines"
          description="Every story in front of the AI right now, ranked by how much it matters to your holdings."
        >
          <Suspense fallback={fallback("h-96")}>
            <NewsReel />
          </Suspense>
        </PageSection>

        <PageSection
          id="reaction"
          title="How the AI reacted"
          description="Each recent decision with the headlines it read and the buys, sells or holds that followed."
        >
          <Suspense fallback={fallback("h-80")}>
            <DecisionNewsBreakdown />
          </Suspense>
        </PageSection>

        <PageSection
          id="voices"
          title="Who said what"
          description="Company bosses and policy makers whose words move prices faster than ordinary coverage."
        >
          <div className="space-y-4">
            <Suspense fallback={fallback("h-64")}>
              <ExecPostsCard />
            </Suspense>
            <Suspense fallback={fallback("h-64")}>
              <PolicyMakersCard />
            </Suspense>
          </div>
        </PageSection>
      </PageShell>
    </div>
  );
}
