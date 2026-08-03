import { createFileRoute } from "@tanstack/react-router";
import { PortfolioRow } from "@/components/home/portfolio-row";

export const Route = createFileRoute("/mobile-probe")({
  ssr: false,
  component: Probe,
});

const holdings = [
  { symbol: "MKS:xlon", quantity: 900, avg_cost: 400, asset_class: "stock" },
  { symbol: "HSBA:xlon", quantity: 240, avg_cost: 1120, asset_class: "stock" },
  { symbol: "ULVR:xlon", quantity: 24, avg_cost: 4700, asset_class: "stock" },
  { symbol: "TSCO:xlon", quantity: 160, avg_cost: 490, asset_class: "stock" },
  { symbol: "VMID:xlon", quantity: 12, avg_cost: 36, asset_class: "etf" },
  { symbol: "VUKE:xlon", quantity: 8, avg_cost: 47, asset_class: "etf" },
];

function Probe() {
  return (
    <div className="min-h-dvh bg-surface-1">
      <main className="mx-auto max-w-6xl px-4 py-5 sm:py-8">
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="space-y-3">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="font-display text-lg font-semibold tracking-tight">Real money</h2>
              <span className="text-xs text-muted-foreground">3 portfolios in total</span>
            </div>
            <PortfolioRow
              portfolio={{
                id: "p1",
                name: "My Portfolio",
                starting_cash: 10300,
                current_cash: 1750.3,
                currency: "GBP",
                risk_level: "balanced",
                mode: "live_prod",
                live_paused: false,
                last_run_date: "2026-08-03",
              }}
              sparkSeries={[
                { date: "2026-07-20", value: 10300 },
                { date: "2026-07-27", value: 10200 },
                { date: "2026-08-03", value: 10248.4 },
              ]}
              holdings={holdings}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
