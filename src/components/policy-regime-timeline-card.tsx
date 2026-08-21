// Regime timeline: how the engine read the tape on each decision run
// (risk-on/off posture + volatility band) and the multiplier that read applied
// to the policy-maker nudge.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AXIS_PROPS,
  CHART_NEUTRAL_SERIES,
  CHART_ROLE,
  GRID_PROPS,
  REFERENCE_LINE,
  TOOLTIP_CONTENT_STYLE,
  TOOLTIP_LABEL_STYLE,
} from "@/lib/chart-palette";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getPolicyRegimeTimeline,
  type PolicyRegimePoint,
  type PolicyRegimeTimeline,
} from "@/lib/policy-regime-timeline.functions";
import type { RegimePosture, VolRegime } from "@/lib/policy-regime-scaling";

const VOL_COLOR: Record<VolRegime, string> = {
  calm: CHART_ROLE.neutral,
  normal: CHART_NEUTRAL_SERIES,
  elevated: CHART_ROLE.warning,
  stressed: CHART_ROLE.negative,
};

const POSTURE_COLOR: Record<RegimePosture, string> = {
  risk_on: CHART_ROLE.positive,
  neutral: CHART_NEUTRAL_SERIES,
  risk_off: CHART_ROLE.negative,
};

const label = (s: string) => s.replace("_", "-");

type Band<K extends string> = { key: K; from: string; to: string; days: number };

/** Collapse consecutive runs sharing the same value into one shaded band. */
function bands<K extends string>(points: PolicyRegimePoint[], pick: (p: PolicyRegimePoint) => K) {
  const out: Band<K>[] = [];
  for (const p of points) {
    const key = pick(p);
    const last = out[out.length - 1];
    if (last && last.key === key) {
      last.to = p.date;
      last.days += 1;
    } else {
      out.push({ key, from: p.date, to: p.date, days: 1 });
    }
  }
  return out;
}

function SwatchLegend({ items }: { items: Array<{ color: string; text: string }> }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {items.map((i) => (
        <span key={i.text} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block size-2.5 rounded-[3px]"
            style={{ background: i.color }}
          />
          {i.text}
        </span>
      ))}
    </div>
  );
}

export function PolicyRegimeTimelineCard({
  portfolioId,
  className,
}: {
  portfolioId: string;
  className?: string;
}) {
  const fetchTimeline = useServerFn(getPolicyRegimeTimeline);
  const { data, isLoading } = useQuery<PolicyRegimeTimeline>({
    queryKey: ["policy-regime-timeline", portfolioId],
    queryFn: () => fetchTimeline({ data: { portfolioId, limit: 120 } }),
    staleTime: 5 * 60_000,
  });

  const points = data?.points ?? [];
  const volBands = useMemo(() => bands(points, (p) => p.vol), [points]);
  const postureBands = useMemo(() => bands(points, (p) => p.posture), [points]);
  const latest = points[points.length - 1] ?? null;

  return (
    <Card className={className} id="policy-regime-timeline">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          Regime timeline
        </CardTitle>
        <CardDescription>
          What the tape looked like on each run — risk-on/off posture and volatility band — next to
          the multiplier applied to policy-maker guidance.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-56 w-full" />
        ) : points.length < 2 ? (
          <p className="text-sm text-muted-foreground">
            No regime history yet — it appears once a couple of decision runs have recorded a
            market-regime read.
          </p>
        ) : (
          <>
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={points} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid {...GRID_PROPS} />
                  {volBands.map((b) => (
                    <ReferenceArea
                      key={`vol-${b.from}-${b.key}`}
                      x1={b.from}
                      x2={b.to}
                      fill={VOL_COLOR[b.key]}
                      fillOpacity={0.14}
                      strokeOpacity={0}
                      ifOverflow="extendDomain"
                    />
                  ))}
                  <XAxis dataKey="date" {...AXIS_PROPS} minTickGap={40} />
                  <YAxis
                    {...AXIS_PROPS}
                    width={46}
                    domain={[data?.scaleMin ?? 0.5, data?.scaleMax ?? 1.6]}
                    tickFormatter={(v: number) => `×${Number(v).toFixed(1)}`}
                  />
                  <ReferenceLine y={1} {...REFERENCE_LINE} />
                  <Tooltip
                    contentStyle={TOOLTIP_CONTENT_STYLE}
                    labelStyle={TOOLTIP_LABEL_STYLE}
                    formatter={(v: number | string, _n, item) => {
                      const p = item?.payload as PolicyRegimePoint | undefined;
                      return [
                        `×${Number(v).toFixed(2)} — ${label(p?.posture ?? "")} tape, ${p?.vol ?? ""} vol`,
                        "Nudge scale",
                      ];
                    }}
                  />
                  <Line
                    type="stepAfter"
                    dataKey="scale"
                    name="Nudge scale"
                    stroke={CHART_ROLE.benchmark}
                    dot={false}
                    strokeWidth={1.8}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Posture strip — one segment per run streak, widths proportional. */}
            <div>
              <div
                className="flex h-3 w-full overflow-hidden rounded-full"
                role="img"
                aria-label="Risk posture over time"
              >
                {postureBands.map((b) => (
                  <span
                    key={`posture-${b.from}-${b.key}`}
                    title={`${label(b.key)} · ${b.from} → ${b.to}`}
                    style={{
                      width: `${(b.days / points.length) * 100}%`,
                      background: POSTURE_COLOR[b.key],
                    }}
                  />
                ))}
              </div>
              <div className="mt-2 grid gap-1.5">
                <SwatchLegend
                  items={[
                    { color: POSTURE_COLOR.risk_on, text: "Risk-on" },
                    { color: POSTURE_COLOR.neutral, text: "Neutral" },
                    { color: POSTURE_COLOR.risk_off, text: "Risk-off" },
                  ]}
                />
                <SwatchLegend
                  items={(Object.keys(VOL_COLOR) as VolRegime[]).map((v) => ({
                    color: VOL_COLOR[v],
                    text: `${v[0]!.toUpperCase()}${v.slice(1)} vol`,
                  }))}
                />
              </div>
            </div>

            {latest ? (
              <p className="text-xs text-muted-foreground">
                Latest run ({latest.date}): {label(latest.posture)} tape, {latest.vol} volatility —
                policy guidance weighted ×{latest.scale.toFixed(2)}.
                {data?.missing ? ` ${data.missing} older run(s) predate regime tracking.` : ""}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
