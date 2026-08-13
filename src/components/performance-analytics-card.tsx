import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getPerformanceAnalytics } from "@/lib/performance-analytics.functions";
import type { AttributionSlice } from "@/lib/performance-analytics.server";
import {
  SAXO_AXIS,
  SAXO_GRID,
  SAXO_REFERENCE_LINE,
  SAXO_TOOLTIP_CONTENT,
  SAXO_TOOLTIP_LABEL,
  edgeTicks,
  fadeStops,
  saxoDot,
} from "@/lib/saxo-chart";
import { SaxoActiveDot, SaxoCrosshair } from "@/components/charts/saxo-crosshair";
import { TradeMarkerLegend, TradeMarkerShape } from "@/components/charts/trade-markers";
import { attachTradeMarkers, describeMarkerCell, type TradeMarkerCell } from "@/lib/chart-trade-markers";
import {
  bandsAt,
  buildPositionEpisodes,
  describeEpisodes,
  episodeBands,
  type EpisodeBand,
} from "@/lib/trade-episodes";
import { EpisodeBandLegend, renderEpisodeBands } from "@/components/charts/trade-episode-bands";
import { TradeEpisodeList } from "@/components/charts/trade-episode-list";
import {
  ResponsiveContainer,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  Cell,
  ComposedChart,
  Scatter,
} from "recharts";

const WINDOWS = [
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "180d", value: 180 },
  { label: "1y", value: 365 },
];

interface Props {
  portfolioId: string;
}

export function PerformanceAnalyticsCard({ portfolioId }: Props) {
  const [windowDays, setWindowDays] = useState(90);
  // Trade row spotlighted on both charts. Bands are keyed by episode, so one
  // selection lights up the same position on equity and drawdown.
  const [selectedEpisode, setSelectedEpisode] = useState<string | null>(null);
  const fetchFn = useServerFn(getPerformanceAnalytics);
  const q = useQuery({
    queryKey: ["performance-analytics", portfolioId, windowDays],
    queryFn: () => fetchFn({ data: { portfolioId, windowDays } }),
  });

  const data = q.data;
  const currency = data?.currency ?? "GBP";
  const fmtCcy = useMemo(
    () => new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }),
    [currency],
  );
  const fmtCcyPrecise = useMemo(
    () => new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 2 }),
    [currency],
  );

  // Executed buys/sells snapped onto each curve so the charts show exactly
  // when decisions happened alongside the equity and drawdown they caused.
  const marks = data?.trades ?? [];
  const equityCurve = useMemo(
    () => attachTradeMarkers(data?.equityCurve ?? [], "date", "equity", marks),
    [data?.equityCurve, marks],
  );
  const drawdownCurve = useMemo(
    () => attachTradeMarkers(data?.drawdownCurve ?? [], "date", "drawdownPct", marks),
    [data?.drawdownCurve, marks],
  );
  // Holding periods: one span per position, from opening fill to closing fill.
  const episodes = useMemo(() => buildPositionEpisodes(marks), [marks]);
  const equityBands = useMemo(
    () => episodeBands(episodes, equityCurve.map((r) => String((r as { date: string }).date))),
    [episodes, equityCurve],
  );
  const drawdownBands = useMemo(
    () => episodeBands(episodes, drawdownCurve.map((r) => String((r as { date: string }).date))),
    [episodes, drawdownCurve],
  );
  const holdTooltip = (
    bands: readonly EpisodeBand[],
    item: { payload?: { date?: string } } | undefined,
  ) =>
    describeEpisodes(bandsAt(bands, String(item?.payload?.date ?? "")), (v) =>
      fmtCcyPrecise.format(v),
    );
  const markerTooltip = (item: { payload?: { marker?: TradeMarkerCell | null } } | undefined) =>
    describeMarkerCell(item?.payload?.marker ?? null, (v) => fmtCcyPrecise.format(v), 4, {
      commission: true,
    });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
        <div>
          <CardTitle className="text-base">Performance analytics</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Equity, drawdown, and realised P&amp;L attribution across regime, sizing, exit and
            execution phases.
          </p>
        </div>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <Button
              key={w.value}
              size="sm"
              variant={windowDays === w.value ? "default" : "outline"}
              onClick={() => setWindowDays(w.value)}
              className="h-7 px-2 text-xs"
            >
              {w.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {q.error && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
        {data && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat
                label="Total return"
                value={data.totalReturnPct == null ? "—" : `${data.totalReturnPct.toFixed(2)}%`}
                tone={pctTone(data.totalReturnPct)}
              />
              <Stat label="Max drawdown" value={`${data.maxDrawdownPct.toFixed(2)}%`} tone="neg" />
              <Stat
                label="Realised P&L"
                value={fmtCcyPrecise.format(data.totalRealizedPnl)}
                tone={pctTone(data.totalRealizedPnl)}
              />
              <Stat label="Round-trips" value={String(data.roundTrips)} />
            </div>

            <ChartBlock title="Equity curve">
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart
                  data={equityCurve}
                  margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
                      {fadeStops("var(--primary)").map((st) => (
                        <stop key={String(st.offset)} {...st} />
                      ))}
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...SAXO_GRID} />
                  {renderEpisodeBands(equityBands, { selectedKey: selectedEpisode })}
                  <XAxis
                    {...SAXO_AXIS}
                    dataKey="date"
                    ticks={edgeTicks(equityCurve as Array<Record<string, unknown>>, "date") as string[]}
                    interval={0}
                  />
                  <YAxis
                    {...SAXO_AXIS}
                    tickCount={4}
                    tickFormatter={(v: number) => fmtCcy.format(v)}
                    width={64}
                  />
                  <Tooltip
                    cursor={<SaxoCrosshair />}
                    formatter={(v: number, name, item) => {
                      if (name === "buys" || name === "sells") return [] as unknown as [string, string];
                      const lines = [
                        ...markerTooltip(item as never),
                        ...holdTooltip(equityBands, item as never),
                      ];
                      return [
                        `${fmtCcyPrecise.format(v)}${lines.length ? `\n${lines.join("\n")}` : ""}`,
                        "Equity",
                      ] as [string, string];
                    }}
                    labelClassName="text-xs"
                    contentStyle={{ ...SAXO_TOOLTIP_CONTENT, whiteSpace: "pre-line" }}
                    labelStyle={SAXO_TOOLTIP_LABEL}
                  />
                  <Area
                    type="linear"
                    dataKey="equity"
                    stroke="var(--primary)"
                    fill="url(#eqFill)"
                    dot={saxoDot("var(--primary)", equityCurve.length)}
                    activeDot={<SaxoActiveDot color="var(--primary)" />}
                    strokeWidth={2}
                    isAnimationActive={false}
                  />
                  <Scatter
                    dataKey="buyMark"
                    name="buys"
                    isAnimationActive={false}
                    shape={(props: unknown) => (
                      <TradeMarkerShape {...(props as { cx?: number; cy?: number })} side="buy" />
                    )}
                  />
                  <Scatter
                    dataKey="sellMark"
                    name="sells"
                    isAnimationActive={false}
                    shape={(props: unknown) => (
                      <TradeMarkerShape {...(props as { cx?: number; cy?: number })} side="sell" />
                    )}
                  />
                </ComposedChart>
              </ResponsiveContainer>
              {marks.length > 0 && (
                <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground">
                  <TradeMarkerLegend />
                  {equityBands.length > 0 && <EpisodeBandLegend count={equityBands.length} />}
                </div>
              )}
            </ChartBlock>

            <ChartBlock title="Drawdown (peak-to-trough %)">
              <ResponsiveContainer width="100%" height={180}>
                <ComposedChart
                  data={drawdownCurve}
                  margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="ddFill" x1="0" y1="1" x2="0" y2="0">
                      {fadeStops("var(--destructive)").map((st) => (
                        <stop key={String(st.offset)} {...st} />
                      ))}
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...SAXO_GRID} />
                  {renderEpisodeBands(drawdownBands, { selectedKey: selectedEpisode, labels: false })}
                  <XAxis
                    {...SAXO_AXIS}
                    dataKey="date"
                    ticks={edgeTicks(drawdownCurve as Array<Record<string, unknown>>, "date") as string[]}
                    interval={0}
                  />
                  <YAxis
                    {...SAXO_AXIS}
                    tickCount={4}
                    tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                    width={52}
                  />
                  <Tooltip
                    cursor={<SaxoCrosshair />}
                    formatter={(v: number, name, item) => {
                      if (name === "buys" || name === "sells") return [] as unknown as [string, string];
                      const lines = [
                        ...markerTooltip(item as never),
                        ...holdTooltip(drawdownBands, item as never),
                      ];
                      return [
                        `${v.toFixed(2)}%${lines.length ? `\n${lines.join("\n")}` : ""}`,
                        "Drawdown",
                      ] as [string, string];
                    }}
                    labelClassName="text-xs"
                    contentStyle={{ ...SAXO_TOOLTIP_CONTENT, whiteSpace: "pre-line" }}
                    labelStyle={SAXO_TOOLTIP_LABEL}
                  />
                  <ReferenceLine {...SAXO_REFERENCE_LINE} y={0} />
                  <Area
                    type="linear"
                    dataKey="drawdownPct"
                    stroke="var(--destructive)"
                    fill="url(#ddFill)"
                    dot={saxoDot("var(--destructive)", drawdownCurve.length)}
                    activeDot={<SaxoActiveDot color="var(--destructive)" />}
                    isAnimationActive={false}
                  />
                  <Scatter
                    dataKey="buyMark"
                    name="buys"
                    isAnimationActive={false}
                    shape={(props: unknown) => (
                      <TradeMarkerShape {...(props as { cx?: number; cy?: number })} side="buy" />
                    )}
                  />
                  <Scatter
                    dataKey="sellMark"
                    name="sells"
                    isAnimationActive={false}
                    shape={(props: unknown) => (
                      <TradeMarkerShape {...(props as { cx?: number; cy?: number })} side="sell" />
                    )}
                  />
                </ComposedChart>
              </ResponsiveContainer>
              {marks.length > 0 && (
                <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground">
                  <TradeMarkerLegend />
                  {drawdownBands.length > 0 && <EpisodeBandLegend count={drawdownBands.length} />}
                </div>
              )}
            </ChartBlock>

            <div className="grid gap-6 lg:grid-cols-2">
              <AttributionBlock
                title="Regime attribution"
                subtitle="Realised P&L grouped by market regime at entry."
                slices={data.regimeAttribution}
                fmt={fmtCcyPrecise}
              />
              <AttributionBlock
                title="Sizing attribution"
                subtitle="Baseline vs conviction bonus vs risk-parity sizing."
                slices={data.sizingAttribution}
                fmt={fmtCcyPrecise}
              />
              <AttributionBlock
                title="Exit attribution"
                subtitle="Which exit trigger closed each round-trip."
                slices={data.exitAttribution}
                fmt={fmtCcyPrecise}
              />
              <AttributionBlock
                title="Execution attribution"
                subtitle="Impact of TOD gates, haircuts, and order slicing."
                slices={data.executionAttribution}
                fmt={fmtCcyPrecise}
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function pctTone(v: number | null | undefined): "pos" | "neg" | undefined {
  if (v == null) return undefined;
  if (v > 0) return "pos";
  if (v < 0) return "neg";
  return undefined;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "pos" | "neg" }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={`mt-1 text-lg font-semibold ${
          tone === "pos" ? "text-emerald-500" : tone === "neg" ? "text-destructive" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function ChartBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-2">{title}</div>
      {children}
    </div>
  );
}

function AttributionBlock({
  title,
  subtitle,
  slices,
  fmt,
}: {
  title: string;
  subtitle: string;
  slices: AttributionSlice[];
  fmt: Intl.NumberFormat;
}) {
  const chartData = slices.map((s) => ({ ...s }));
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">{title}</div>
        <Badge variant="outline" className="text-[10px]">
          {slices.reduce((n, s) => n + s.trips, 0)} trips
        </Badge>
      </div>
      <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>
      {slices.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">No round-trip trades in this window.</p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={Math.max(140, slices.length * 28 + 20)}>
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 4, right: 12, left: 4, bottom: 4 }}
            >
              <defs>
                <linearGradient id="attrPos" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.85} />
                </linearGradient>
                <linearGradient id="attrNeg" x1="1" y1="0" x2="0" y2="0">
                  <stop offset="0%" stopColor="var(--destructive)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--destructive)" stopOpacity={0.85} />
                </linearGradient>
              </defs>
              <CartesianGrid {...SAXO_GRID} vertical horizontal={false} />
              <XAxis {...SAXO_AXIS} type="number" tickCount={4} tickFormatter={(v: number) => fmt.format(v)} />
              <YAxis {...SAXO_AXIS} type="category" dataKey="label" width={110} />
              <Tooltip
                cursor={{ fill: "color-mix(in oklab, var(--muted) 30%, transparent)" }}
                formatter={(v: number) => fmt.format(v)}
                labelClassName="text-xs"
                contentStyle={SAXO_TOOLTIP_CONTENT}
                labelStyle={SAXO_TOOLTIP_LABEL}
              />
              <ReferenceLine {...SAXO_REFERENCE_LINE} x={0} />
              <Bar dataKey="realizedPnl" radius={[0, 4, 4, 0]}>
                {chartData.map((s) => (
                  <Cell
                    key={s.key}
                    fill={s.realizedPnl >= 0 ? "url(#attrPos)" : "url(#attrNeg)"}
                    stroke={s.realizedPnl >= 0 ? "var(--primary)" : "var(--destructive)"}
                    strokeWidth={1}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="mt-2 grid grid-cols-4 gap-1 text-[10px] uppercase text-muted-foreground">
            <div className="col-span-2">Bucket</div>
            <div className="text-right">Trips</div>
            <div className="text-right">Win %</div>
          </div>
          <div className="divide-y">
            {slices.map((s) => (
              <div key={s.key} className="grid grid-cols-4 gap-1 py-1 text-xs">
                <div className="col-span-2 truncate">{s.label}</div>
                <div className="text-right">{s.trips}</div>
                <div className="text-right">
                  {s.winRatePct == null ? "—" : `${s.winRatePct.toFixed(0)}%`}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
