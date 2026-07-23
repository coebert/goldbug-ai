import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCorrelationMatrix } from "@/lib/insights.functions";
import { Grid3x3 } from "lucide-react";
import { Explain } from "@/components/explain";

function heatColor(v: number) {
  // -1 red, 0 neutral, +1 green
  const clamped = Math.max(-1, Math.min(1, v));
  if (clamped >= 0) {
    const alpha = 0.15 + clamped * 0.55;
    return `rgba(16,185,129,${alpha.toFixed(2)})`;
  }
  const alpha = 0.15 + Math.abs(clamped) * 0.55;
  return `rgba(239,68,68,${alpha.toFixed(2)})`;
}

export function CorrelationHeatmapCard({ portfolioId }: { portfolioId: string }) {
  const fetchFn = useServerFn(getCorrelationMatrix);
  const { data, isLoading } = useQuery({
    queryKey: ["correlation-matrix", portfolioId],
    queryFn: () => fetchFn({ data: { portfolioId } }),
    staleTime: 60_000,
  });

  const symbols = data?.symbols ?? [];
  const matrix = data?.matrix ?? [];
  const exposures = data?.exposures ?? [];
  const totalExp = exposures.reduce((s, e) => s + e.value, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Grid3x3 className="h-4 w-4" /> Correlation & exposure heatmap
          <Explain term="volatility" />
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!isLoading && symbols.length < 2 && (
          <p className="text-sm text-muted-foreground">
            Need at least two open positions to show correlations.
          </p>
        )}
        {symbols.length >= 2 && (
          <div className="overflow-x-auto">
            <table className="text-xs border-separate border-spacing-0.5">
              <thead>
                <tr>
                  <th></th>
                  {symbols.map((s) => (
                    <th key={s} className="px-1 py-0.5 font-medium">{s}</th>
                  ))}
                  <th className="px-2 py-0.5 font-medium text-left">Exp.</th>
                </tr>
              </thead>
              <tbody>
                {symbols.map((row, i) => (
                  <tr key={row}>
                    <th className="pr-2 py-0.5 text-right font-medium whitespace-nowrap">{row}</th>
                    {symbols.map((_col, j) => {
                      const v = matrix[i]?.[j] ?? 0;
                      return (
                        <td
                          key={j}
                          className="w-9 h-7 text-center align-middle rounded"
                          style={{ background: heatColor(v) }}
                          title={`${row} vs ${symbols[j]}: ${v.toFixed(2)}`}
                        >
                          {v.toFixed(2)}
                        </td>
                      );
                    })}
                    <td className="pl-3 py-0.5 text-muted-foreground whitespace-nowrap">
                      {totalExp > 0 ? `${((exposures[i]?.value ?? 0) / totalExp * 100).toFixed(0)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground mt-3">
              Green = correlated (moves together), red = inversely correlated. High correlation across many holdings
              means the portfolio is less diversified than it looks.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
