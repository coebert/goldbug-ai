import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartFrame } from "@/components/chart-frame";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CHART_SEQUENCE, LEGEND_PROPS, TOOLTIP_WRAPPER_STYLE } from "@/lib/chart-palette";
import { buildHoldingEquityChangeRows } from "@/lib/holding-equity-change";
import { getHoldingsHistory } from "@/lib/holdings-history.functions";
import { SAXO_AXIS, SAXO_GRID, SAXO_REFERENCE_LINE } from "@/lib/saxo-chart";
import { POLL } from "@/lib/query-keys";

const LINE_DASHES = [undefined, "7 4", "2 3", "10 3 2 3", "12 4", "4 3"] as const;

function shortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
}

export function HoldingEquityChangeChart({ portfolioId }: { portfolioId: string }) {
  const fetchHistory = useServerFn(getHoldingsHistory);
  const history = useQuery({
    queryKey: ["holdings-history", portfolioId],
    queryFn: () => fetchHistory({ data: { portfolioId } }),
    refetchInterval: POLL.SEMI_LIVE,
  });
  const chart = useMemo(() => buildHoldingEquityChangeRows(history.data ?? []), [history.data]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Holding performance since purchase</CardTitle>
        <p className="text-xs text-muted-foreground">
          Percentage change in each open holding, rebased to 0% at its purchase cost.
        </p>
      </CardHeader>
      <CardContent>
        {history.isLoading ? (
          <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">
            Loading holding history…
          </div>
        ) : history.isError ? (
          <div className="flex h-[300px] items-center justify-center text-sm text-destructive">
            Holding history is temporarily unavailable.
          </div>
        ) : chart.rows.length < 2 || chart.symbols.length === 0 ? (
          <div className="flex h-[300px] items-center justify-center text-center text-sm text-muted-foreground">
            No price history is available for the current holdings yet.
          </div>
        ) : (
          <ChartFrame className="h-[300px] sm:h-[360px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chart.rows} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
                <CartesianGrid {...SAXO_GRID} />
                <XAxis
                  {...SAXO_AXIS}
                  dataKey="at"
                  minTickGap={42}
                  tickFormatter={(value) => shortDate(String(value))}
                />
                <YAxis
                  {...SAXO_AXIS}
                  width={50}
                  tickFormatter={(value) => `${Number(value).toFixed(0)}%`}
                  domain={["auto", "auto"]}
                />
                <ReferenceLine y={0} {...SAXO_REFERENCE_LINE} />
                <Tooltip
                  wrapperStyle={TOOLTIP_WRAPPER_STYLE}
                  labelFormatter={(value) => shortDate(String(value))}
                  formatter={(value, name) => [
                    typeof value === "number" ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "—",
                    String(name),
                  ]}
                  contentStyle={{
                    background: "var(--popover)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    color: "var(--popover-foreground)",
                  }}
                />
                <Legend verticalAlign="top" height={34} {...LEGEND_PROPS} />
                {chart.symbols.map((symbol, index) => (
                  <Line
                    key={symbol}
                    type="monotone"
                    dataKey={symbol}
                    name={symbol}
                    stroke={CHART_SEQUENCE[index % CHART_SEQUENCE.length]}
                    strokeWidth={2.5}
                    strokeDasharray={LINE_DASHES[index % LINE_DASHES.length]}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </ChartFrame>
        )}
      </CardContent>
    </Card>
  );
}