import { Link } from "@tanstack/react-router";
import { BarChart3, CalendarClock, FileText, Settings2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

const REPORTS = [
  {
    to: "/portfolio/$id/analytics",
    label: "Performance analytics",
    desc: "Equity, drawdown and PnL attribution across regime, sizing, exit and execution phases.",
    Icon: BarChart3,
  },
  {
    to: "/portfolio/$id/attribution",
    label: "Attribution",
    desc: "Per-asset P&L contribution and factor breakdown.",
    Icon: BarChart3,
  },
  {
    to: "/portfolio/$id/sma-report",
    label: "SMA crossover report",
    desc: "Per-symbol SMA20/50 crosses, golden/death regime and the trades taken against that trend.",
    Icon: BarChart3,
  },
  {
    to: "/portfolio/$id/report",
    label: "Report",
    desc: "Downloadable performance report for this portfolio.",
    Icon: FileText,
  },
  {
    to: "/portfolio/$id/optimizer",
    label: "Optimizer",
    desc: "Re-run the AI with alternate risk profiles for comparison.",
    Icon: Settings2,
  },
  {
    to: "/long-horizon/$id",
    label: "Long-horizon backtest",
    desc: "Multi-decade rule-based simulation vs benchmarks.",
    Icon: CalendarClock,
  },
] as const;

export function ReportsSection({ portfolioId }: { portfolioId: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {REPORTS.map((r) => (
        <Link key={r.to} to={r.to} params={{ id: portfolioId }} className="block">
          <Card className="h-full transition-colors hover:border-primary/40">
            <CardContent className="flex items-start gap-3 py-4">
              <div className="mt-0.5 rounded-md bg-muted p-2">
                <r.Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="font-medium">{r.label}</div>
                <p className="text-xs text-muted-foreground">{r.desc}</p>
              </div>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}
