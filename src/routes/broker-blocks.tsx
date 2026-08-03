import { createFileRoute, Link } from "@tanstack/react-router";
import { AppHeader } from "@/components/app-header";
import { BrokerSuitabilityBlocksCard } from "@/components/broker-suitability-blocks-card";
import { BrokerBlockAuditLogCard } from "@/components/broker-block-audit-log-card";
import { TradeReconciliationReportCard } from "@/components/trade-reconciliation-report-card";
import { HoldingsFillsReconCard } from "@/components/holdings-fills-recon-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/broker-blocks")({
  head: () => ({
    meta: [
      { title: "Blocked Instruments — Broker Suitability | Aegis" },
      {
        name: "description",
        content:
          "Instruments Saxo has refused for this account, why they are blocked, and how to clear a block after completing the suitability test.",
      },
      { property: "og:title", content: "Blocked Instruments — Broker Suitability | Aegis" },
      {
        property: "og:description",
        content: "Review and clear Saxo suitability, tradability, and permission blocks.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: BrokerBlocksPage,
});

function BrokerBlocksPage() {
  return (
    <div className="min-h-screen overflow-x-hidden bg-background">
      <AppHeader />
      <main className="mx-auto w-full min-w-0 max-w-4xl space-y-4 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-foreground">Blocked instruments</h1>
            <p className="text-sm text-muted-foreground">
              Symbols the AI will skip because Saxo refused them at account level.
            </p>
          </div>
          <div className="flex gap-3 text-sm text-muted-foreground">
            <Link to="/admin" className="hover:text-foreground">
              ← Admin
            </Link>
            <Link to="/saxo-status" className="hover:text-foreground">
              Saxo status
            </Link>
          </div>
        </div>

        <BrokerSuitabilityBlocksCard />

        <TradeReconciliationReportCard days={14} />

        <HoldingsFillsReconCard />


        <BrokerBlockAuditLogCard />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">How blocks work</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              When Saxo rejects an order for suitability, tradability, or permission reasons, the
              symbol is recorded here and dropped from the live trading universe — retrying would
              fail identically and waste an order slot.
            </p>
            <p>
              Existing positions can still be sold or unwound; only new buys are suppressed.
            </p>
            <p>
              After you complete the appropriateness/suitability test at Saxo, clear the block here.
              If the broker still refuses the instrument, it will be re-blocked on the next attempt.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
