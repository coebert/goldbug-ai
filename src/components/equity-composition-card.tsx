// Stacked composition of total portfolio equity over time.
//
// Y axis = total equity value; the area beneath the line is split into one
// shaded band per asset (plus cash), so band height at any date is that
// asset's contribution to total equity. Values are anchored to the stored
// equity snapshots, so the stack top always equals the recorded total.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Layers } from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";

import { getEquityComposition } from "@/lib/equity-composition.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChartFrame } from "@/components/chart-frame";
import {
  AXIS_LINE,
  AXIS_TICK,
  GRID_PROPS,
  LEGEND_STYLE,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
} from "@/lib/chart-palette";

const BAND_COLORS = [
  "hsl(160, 62%, 55%)",
  "hsl(217, 91%, 62%)",
  "hsl(38, 92%, 58%)",
  "hsl(280, 65%, 65%)",
  "hsl(190, 75%, 52%)",
  "hsl(0, 72%, 60%)",
  "hsl(95, 55%, 55%)",
  "hsl(330, 70%, 62%)",
];
const CASH_COLOR = "hsl(215, 16%, 55%)";
const OTHER_COLOR = "hsl(250, 20%, 60%)";
const UNPRICED_COLOR = "hsl(30, 12%, 45%)";

const colorFor = (key: string, i: number) =>
  key === "cash"
    ? CASH_COLOR
    : key === "other"
      ? OTHER_COLOR
      : key === "unpriced"
        ? UNPRICED_COLOR
        : BAND_COLORS[i % BAND_COLORS.length];

const labelFor = (key: string) =>
  key === "cash"
    ? "Cash"
    : key === "other"
      ? "Other holdings"
      : key === "unpriced"
        ? "Unpriced holdings"
        : key.replace(/:[a-z]+$/i, "");

const WINDOWS = [
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
] as const;

export function EquityCompositionCard({
  portfolioId,
  active = true,
}: {
  portfolioId: string;
  active?: boolean;
}) {
  const fetchFn = useServerFn(getEquityComposition);
  const [days, setDays] = useState<number>(180);

  const q = useQuery({
    queryKey: ["equity-composition", portfolioId, days],
    queryFn: () => fetchFn({ data: { portfolioId, sinceDays: days } }),
    enabled: active,
    staleTime: 60_000,
  });

  const currency = q.data?.currency ?? "GBP";
  const money = useMemo(
    () =>
      new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
      }),
    [currency],
  );

  // Cash first so it sits at the bottom of the stack, then assets by weight.
  const keys = useMemo(() => {
    const symbols = (q.data?.symbols ?? []).filter((s) =>
      (q.data?.rows ?? []).some((r) => Number(r[s]) > 0),
    );
    return ["cash", ...symbols];
  }, [q.data]);

  const rows = q.data?.rows ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers className="h-4 w-4 text-primary" />
          Equity composition
        </CardTitle>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <Button
              key={w.label}
              size="sm"
              variant={days === w.days ? "secondary" : "ghost"}
              className="h-7 px-2 text-xs"
              onClick={() => setDays(w.days)}
            >
              {w.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-xs text-muted-foreground">
          Total equity over time, shaded by how much each holding (and cash) contributes.
        </p>
        {q.isLoading ? (
          <div className="h-64 animate-pulse rounded-md bg-muted/40" />
        ) : rows.length < 2 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Not enough snapshot history yet to chart composition.
          </p>
        ) : (
          <ChartFrame className="h-64 sm:h-80">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis
                  dataKey="date"
                  tick={AXIS_TICK}
                  tickLine={TICK_LINE}
                  axisLine={AXIS_LINE}
                  minTickGap={28}
                  tickFormatter={(d: string) => d.slice(5)}
                />
                <YAxis
                  tick={AXIS_TICK}
                  tickLine={TICK_LINE}
                  axisLine={AXIS_LINE}
                  width={56}
                  tickFormatter={(v: number) => money.format(v)}
                />
                <Tooltip
                  contentStyle={TOOLTIP_CONTENT_STYLE}
                  formatter={(value: number, name: string) => [
                    money.format(Number(value)),
                    labelFor(name),
                  ]}
                  labelFormatter={(d: string) => d}
                />
                <Legend wrapperStyle={LEGEND_STYLE} formatter={(v: string) => labelFor(v)} />
                {keys.map((key, i) => (
                  <Area
                    key={key}
                    type="monotone"
                    dataKey={key}
                    stackId="equity"
                    stroke={colorFor(key, i - 1)}
                    fill={colorFor(key, i - 1)}
                    fillOpacity={0.55}
                    strokeWidth={1}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </ChartFrame>
        )}
      </CardContent>
    </Card>
  );
}
