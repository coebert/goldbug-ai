// Stacked composition of total portfolio equity over time.
//
// Y axis = total equity value; the area beneath the line is split into one
// shaded band per asset (plus cash), so band height at any date is that
// asset's contribution to total equity. Values are anchored to the stored
// equity snapshots, so the stack top always equals the recorded total.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Info, Layers } from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

import { getEquityComposition } from "@/lib/equity-composition.functions";
import { ROW_INTERPOLATED, validateComposition } from "@/lib/equity-composition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChartFrame } from "@/components/chart-frame";
import {
  AXIS_LINE,
  AXIS_TICK,
  GRID_PROPS,
  TICK_LINE,
  TOOLTIP_CONTENT_STYLE,
} from "@/lib/chart-palette";

// Hues are spread far apart AND alternate in lightness/saturation, so adjacent
// bands differ in both colour and brightness (readable on mobile and for
// colour-vision deficiencies).
const BAND_COLORS = [
  "hsl(150, 70%, 62%)", // mint
  "hsl(265, 75%, 68%)", // violet
  "hsl(38, 95%, 58%)", // amber
  "hsl(205, 90%, 55%)", // azure
  "hsl(345, 78%, 63%)", // rose
  "hsl(90, 55%, 65%)", // lime
  "hsl(255, 40%, 45%)", // deep indigo
  "hsl(20, 85%, 55%)", // orange
  "hsl(185, 70%, 45%)", // teal
  "hsl(310, 65%, 72%)", // orchid
  "hsl(60, 60%, 50%)", // olive
  "hsl(220, 55%, 38%)", // navy
  "hsl(0, 60%, 45%)", // brick
  "hsl(170, 45%, 80%)", // pale aqua
];
const CASH_COLOR = "hsl(215, 16%, 55%)";
const OTHER_COLOR = "hsl(250, 20%, 60%)";
const UNPRICED_COLOR = "hsl(30, 12%, 45%)";

// Colour preference is derived from the symbol itself, so a holding tends to
// keep the same shade across portfolios and windows — but if two visible
// holdings hash to the same slot we walk to the next free colour so no two
// bands in one chart ever share a shade.
const hashKey = (key: string) => {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h;
};

const FIXED_COLORS: Record<string, string> = {
  cash: CASH_COLOR,
  other: OTHER_COLOR,
  unpriced: UNPRICED_COLOR,
};

export function buildColorMap(keys: readonly string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const taken = new Set<number>();
  for (const key of keys) {
    if (FIXED_COLORS[key]) {
      map[key] = FIXED_COLORS[key];
      continue;
    }
    const start = hashKey(key) % BAND_COLORS.length;
    let idx = start;
    for (let step = 0; step < BAND_COLORS.length && taken.has(idx); step += 1) {
      idx = (start + step + 1) % BAND_COLORS.length;
    }
    taken.add(idx);
    map[key] = BAND_COLORS[idx];
  }
  return map;
}


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
  const latest = (rows[rows.length - 1] ?? {}) as Record<string, unknown>;

  // Each stacked snapshot must sum exactly to its stored total equity.
  const mismatches = useMemo(() => validateComposition(rows, keys), [rows, keys]);

  const gaps = q.data?.gaps ?? [];
  const filledGaps = gaps.filter((g) => g.interpolated);
  const openGaps = gaps.filter((g) => !g.interpolated);

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
        {mismatches.length > 0 ? (
          <div
            role="alert"
            className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Composition does not match stored equity</p>
              <p className="mt-0.5 text-destructive/90">
                {mismatches.length} of {rows.length} snapshots have bands that don't sum to the
                recorded total (worst gap {money.format(
                  mismatches.reduce((w, m) => (Math.abs(m.diff) > Math.abs(w) ? m.diff : w), 0),
                )}{" "}
                on {mismatches.reduce((w, m) => (Math.abs(m.diff) > Math.abs(w.diff) ? m : w)).date}
                ). Treat the shaded split as indicative until this is resolved.
              </p>
            </div>
          </div>
        ) : null}
        {gaps.length > 0 ? (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium text-foreground">Some snapshots are missing</p>
              {filledGaps.length > 0 ? (
                <p className="mt-0.5">
                  {filledGaps.length} short gap{filledGaps.length === 1 ? "" : "s"} (
                  {filledGaps.reduce((n, g) => n + g.missingDays, 0)} trading day
                  {filledGaps.reduce((n, g) => n + g.missingDays, 0) === 1 ? "" : "s"}) were filled
                  by interpolating between the surrounding snapshots.
                </p>
              ) : null}
              {openGaps.length > 0 ? (
                <p className="mt-0.5">
                  {openGaps.length} longer gap{openGaps.length === 1 ? "" : "s"} left blank (
                  {openGaps
                    .map((g) => `${g.from} to ${g.to}, ${g.missingDays} days`)
                    .slice(0, 3)
                    .join("; ")}
                  {openGaps.length > 3 ? "; …" : ""}) — no data was available, so the chart breaks
                  there instead of inventing values.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
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
                  labelFormatter={(d: string) => {
                    const row = rows.find((r) => r.date === d);
                    return row?.[ROW_INTERPOLATED] ? `${d} (interpolated)` : d;
                  }}
                />
                {keys.map((key) => (
                  <Area
                    key={key}
                    type="monotone"
                    dataKey={key}
                    stackId="equity"
                    stroke={colorFor(key)}
                    fill={colorFor(key)}
                    fillOpacity={0.55}
                    connectNulls={false}
                    strokeWidth={1}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </ChartFrame>
        )}
        {rows.length >= 2 && !q.isLoading ? (
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Chart legend">
            {keys.map((key) => (
              <li key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  aria-hidden
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: colorFor(key) }}
                />
                <span className="text-foreground">{labelFor(key)}</span>
                {latest[key] != null ? (
                  <span className="tabular-nums">{money.format(Number(latest[key]))}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
