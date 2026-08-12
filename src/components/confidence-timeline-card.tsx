import { useMemo, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceDot,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  AXIS_LINE,
  AXIS_TICK,
  CHART_ROLE,
  GRID_PROPS,
  LEGEND_PROPS,
  OKABE_ITO,
  TICK_LINE,
} from "@/lib/chart-palette";
import { buildConfidenceTimeline, type ConfidencePoint } from "@/lib/confidence-timeline";

import { CollapsibleLegend } from "@/components/ui/collapsible-legend";
type Decision = { id: string; run_date: string; raw: unknown };

type Props = {
  decisions: Decision[];
};

function fmtDate(iso: string): string {
  // Compact axis label — YYYY-MM-DD -> "MMM d"
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { month: "short", day: "numeric" });
}

type ChartRow = ConfidencePoint & { dateLabel: string };

function TimelineTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartRow }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium text-foreground">
        {p.dateLabel} · {p.side.toUpperCase()} · score {p.score}
      </div>
      <div className="space-y-0.5 text-muted-foreground">
        <div>Base conviction: {(p.base * 100).toFixed(0)}%</div>
        <div>
          Regime{p.regimeLabel ? ` · ${p.regimeLabel}` : ""}: ×{p.regimeFactor.toFixed(2)}
          {p.regimeTransitioned ? " (shift)" : ""}
        </div>
        <div>
          News: ×{p.newsFactor.toFixed(2)}
          {p.newsAligned > 0 ? ` · ${p.newsAligned} aligned` : ""}
          {p.newsOpposing > 0 ? ` · ${p.newsOpposing} opposing` : ""}
        </div>
        <div className="pt-1 text-foreground">
          Outcome: {p.status}
          {p.rejectedReason ? ` — ${p.rejectedReason}` : ""}
        </div>
      </div>
    </div>
  );
}

export function ConfidenceTimelineCard({ decisions }: Props) {
  const series = useMemo(() => buildConfidenceTimeline(decisions), [decisions]);
  const [selected, setSelected] = useState<string | null>(null);

  const activeSymbol = selected ?? series[0]?.symbol ?? null;
  const active = series.find((s) => s.symbol === activeSymbol) ?? null;

  const rows: ChartRow[] = useMemo(() => {
    if (!active) return [];
    return active.points.map((p) => ({ ...p, dateLabel: fmtDate(p.runDate) }));
  }, [active]);

  const executedRows = useMemo(() => rows.filter((r) => r.status === "executed"), [rows]);
  const rejectedRows = useMemo(() => rows.filter((r) => r.status === "rejected"), [rows]);
  const transitions = useMemo(() => rows.filter((r) => r.regimeTransitioned), [rows]);

  if (series.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Confidence over time</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No AI decisions yet — run one day or a backtest to see confidence scores plotted per
          asset.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle>Confidence over time</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            How each order's confidence score has evolved across decisions. Regime shifts (▲) and
            news alignment are shown in the tooltip.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Asset</span>
          <Select value={activeSymbol ?? undefined} onValueChange={setSelected}>
            <SelectTrigger className="h-9 w-36">
              <SelectValue placeholder="Symbol" />
            </SelectTrigger>
            <SelectContent>
              {series.map((s) => (
                <SelectItem key={s.symbol} value={s.symbol}>
                  {s.symbol} · {s.points.length}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {active && rows.length > 0 ? (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">Latest: {rows[rows.length - 1].score}</Badge>
              <Badge variant="outline">
                Avg: {Math.round(rows.reduce((a, r) => a + r.score, 0) / rows.length)}
              </Badge>
              <Badge variant="outline">
                Range: {Math.min(...rows.map((r) => r.score))}–
                {Math.max(...rows.map((r) => r.score))}
              </Badge>
              {transitions.length > 0 && (
                <Badge variant="secondary">
                  {transitions.length} regime shift{transitions.length === 1 ? "" : "s"}
                </Badge>
              )}
            </div>

            <div className="h-56 w-full sm:h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={rows} margin={{ top: 10, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  <XAxis
                    dataKey="dateLabel"
                    tick={AXIS_TICK}
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                  />
                  <YAxis
                    width={64}
                    domain={[0, 100]}
                    tick={AXIS_TICK}
                    axisLine={AXIS_LINE}
                    tickLine={TICK_LINE}
                  />
                  <Tooltip content={<TimelineTooltip />} />
                  <Legend {...LEGEND_PROPS} content={<CollapsibleLegend />} />
                  <Line
                    type="monotone"
                    dataKey="score"
                    name="Confidence"
                    stroke={OKABE_ITO.skyBlue}
                    strokeWidth={2}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                    isAnimationActive={false}
                  />
                  <Scatter
                    name="Executed"
                    data={executedRows}
                    dataKey="score"
                    fill={CHART_ROLE.positive}
                    shape="circle"
                  />
                  <Scatter
                    name="Rejected"
                    data={rejectedRows}
                    dataKey="score"
                    fill={CHART_ROLE.negative}
                    shape="triangle"
                  />
                  {transitions.map((t) => (
                    <ReferenceDot
                      key={`shift-${t.decisionId}`}
                      x={t.dateLabel}
                      y={t.score}
                      r={7}
                      stroke={CHART_ROLE.benchmark}
                      strokeWidth={2}
                      fill="none"
                      isFront
                      ifOverflow="extendDomain"
                    />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <p className="text-xs text-muted-foreground">
              Orange rings mark decisions taken on a regime transition day — hover any point for the
              full score breakdown.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No confidence points for this asset yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
