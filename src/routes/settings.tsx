import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Settings as SettingsIcon } from "lucide-react";
import { PushNotificationsCard } from "@/components/push-notifications-card";
import { TradingControlsCard } from "@/components/trading-controls-card";
import { MfaCard } from "@/components/mfa-card";
import { CorporateActionAlertSettingsCard } from "@/components/corporate-action-alert-settings-card";
import { ValuationHistoryBackfillCard } from "@/components/valuation-history-backfill-card";


export const Route = createFileRoute("/settings")({
  component: SettingsPage,
  head: () => ({
    meta: [
      { title: "Settings · Aegis" },
      {
        name: "description",
        content:
          "Manage notifications and preferences for your Aegis trading dashboard, including browser push alerts for trade fills and daily summaries.",
      },
      { property: "og:title", content: "Settings · Aegis" },
      {
        property: "og:description",
        content: "Manage notifications and preferences for your Aegis trading dashboard.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

function SettingsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <SettingsIcon className="h-6 w-6 text-primary" />
          Settings
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage your notifications and per-device preferences. Push alerts must
          be enabled on each device you want them on.
        </p>
      </header>

      <section aria-labelledby="security-heading" className="space-y-3">
        <h2 id="security-heading" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Account security
        </h2>
        <MfaCard />
      </section>

      <section aria-labelledby="notifications-heading" className="space-y-3">

        <h2 id="notifications-heading" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Notifications
        </h2>
        <PushNotificationsCard />
        <CorporateActionAlertSettingsCard />
      </section>

      <section aria-labelledby="safety-heading" className="space-y-3">
        <h2 id="safety-heading" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Trading safety
        </h2>
        <TradingControlsCard />
      </section>

      <section aria-labelledby="maintenance-heading" className="space-y-3">
        <h2 id="maintenance-heading" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Data maintenance
        </h2>
        <ValuationHistoryBackfillCard />
      </section>
    </div>
  );
}
