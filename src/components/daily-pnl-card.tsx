import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoneySigned } from "@/lib/format-money";
import { getDailyPnl } from "@/lib/daily-pnl.functions";

function Amount({ value, currency }: { value: number; currency: string }) {
  const tone =
    value > 0.005 ? "text-emerald-600" : value < -0.005 ? "text-destructive" : "text-muted-foreground";
  return <span className={`tabular-nums ${tone}`}>{formatMoneySigned(value, currency)}</span>;
}

function ukDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export function DailyPnlCard({ portfolioId }: { portfolioId: string }) {
  const fetchDailyPnl = useServerFn(getDailyPnl);
  const { data, isLoading, error } = useQuery({
    queryKey: ["daily-pnl", portfolioId],
    queryFn: () => fetchDailyPnl({ data: { portfolioId } }),
    staleTime: 60_000,
  });

  if (isLoading) {
    return <div className="h-64 animate-pulse rounded-lg border bg-muted/30" />;
  }
  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-destructive">
          {(error as Error).message}
        </CardContent>
      </Card>
    );
  }
  if (!data || data.days.length === 0) {
    return (
      <Card data-testid="daily-pnl-card">
        <CardHeader>
          <CardTitle>Daily profit and loss</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No day-by-day history yet — this fills in once the account has been valued on two
          separate days.
        </CardContent>
      </Card>
    );
  }

  const ccy = data.currency;

  return (
    <div className="space-y-4" data-testid="daily-pnl-card">
      <Card>
        <CardHeader>
          <CardTitle>Week by week</CardTitle>
          <CardDescription>
            Each week's net gain, split the same way as the days below.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="weekly-pnl-table">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-4 py-2 text-left font-medium">Week of</th>
                  <th className="px-4 py-2 text-right font-medium">Positions</th>
                  <th className="px-4 py-2 text-right font-medium">FX legs</th>
                  <th className="px-4 py-2 text-right font-medium">Charges</th>
                  <th className="px-4 py-2 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody>
                {data.weeks.map((w) => (
                  <tr key={w.weekStart} className="border-b last:border-0" data-testid={`week-${w.weekStart}`}>
                    <td className="px-4 py-2">
                      {ukDay(w.weekStart)}
                      <span className="ml-2 text-xs text-muted-foreground">{w.dayCount} days</span>
                    </td>
                    <td className="px-4 py-2 text-right"><Amount value={w.positions} currency={ccy} /></td>
                    <td className="px-4 py-2 text-right"><Amount value={w.fxLegs} currency={ccy} /></td>
                    <td className="px-4 py-2 text-right"><Amount value={-w.fees} currency={ccy} /></td>
                    <td className="px-4 py-2 text-right font-medium"><Amount value={w.netPnl} currency={ccy} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Day by day</CardTitle>
          <CardDescription>
            Net gain after deposits and withdrawals are taken out. "Positions" is everything that
            was not a currency hedge or a broker charge.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="daily-pnl-table">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-4 py-2 text-left font-medium">Day</th>
                  <th className="px-4 py-2 text-right font-medium">Positions</th>
                  <th className="px-4 py-2 text-right font-medium">FX legs</th>
                  <th className="px-4 py-2 text-right font-medium">Charges</th>
                  <th className="px-4 py-2 text-right font-medium">Net</th>
                  <th className="px-4 py-2 text-right font-medium">%</th>
                </tr>
              </thead>
              <tbody>
                {data.days.map((d) => (
                  <tr key={d.date} className="border-b last:border-0" data-testid={`day-${d.date}`}>
                    <td className="px-4 py-2">
                      {ukDay(d.date)}
                      {d.netFlow !== 0 && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {formatMoneySigned(d.netFlow, ccy)} in/out
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right"><Amount value={d.positions} currency={ccy} /></td>
                    <td className="px-4 py-2 text-right"><Amount value={d.fxLegs} currency={ccy} /></td>
                    <td className="px-4 py-2 text-right"><Amount value={-d.fees} currency={ccy} /></td>
                    <td className="px-4 py-2 text-right font-medium"><Amount value={d.netPnl} currency={ccy} /></td>
                    <td className="px-4 py-2 text-right text-xs text-muted-foreground tabular-nums">
                      {d.pct == null ? "—" : `${d.pct >= 0 ? "+" : "−"}${Math.abs(d.pct).toFixed(2)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {(data.fxLegSymbols.length > 0 || data.warnings.length > 0) && (
        <p className="text-xs text-muted-foreground">
          {data.fxLegSymbols.length > 0
            ? `Currency hedge legs tracked: ${data.fxLegSymbols.join(", ")}. `
            : ""}
          {data.warnings.join(" ")}
        </p>
      )}
    </div>
  );
}
