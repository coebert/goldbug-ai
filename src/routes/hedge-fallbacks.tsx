import { createFileRoute, Link } from "@tanstack/react-router";
import { AppHeader } from "@/components/app-header";
import { HedgeFallbackSummaryCard } from "@/components/hedge-fallback-summary-card";

export const Route = createFileRoute("/hedge-fallbacks")({
  head: () => ({
    meta: [
      { title: "Hedge Fallbacks — Tail Hedge Substitutions | Aegis" },
      {
        name: "description",
        content:
          "Which tail-hedge instruments were substituted when the primary gold hedge was blocked, grouped by currency and pair, with success outcomes.",
      },
      { property: "og:title", content: "Hedge Fallbacks — Tail Hedge Substitutions | Aegis" },
      {
        property: "og:description",
        content: "Hedge instrument fallback usage by currency, instrument pair, and outcome.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: HedgeFallbacksPage,
});

function HedgeFallbacksPage() {
  return (
    <div className="min-h-screen overflow-x-hidden bg-background">
      <AppHeader />
      <main className="mx-auto w-full min-w-0 max-w-4xl space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Hedge fallbacks</h1>
            <p className="text-sm text-muted-foreground">
              Tail-hedge substitutions by currency, instrument pair, and whether the hedge got on.
            </p>
          </div>
          <div className="flex gap-3 text-sm text-muted-foreground">
            <Link to="/admin" className="hover:text-foreground">
              ← Admin
            </Link>
            <Link to="/broker-blocks" className="hover:text-foreground">
              Blocked instruments
            </Link>
          </div>
        </div>

        <HedgeFallbackSummaryCard days={90} />
      </main>
    </div>
  );
}
