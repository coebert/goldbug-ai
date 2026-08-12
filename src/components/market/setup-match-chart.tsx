import { useMemo } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SetupMatch } from "@/lib/setup-scan";

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Europe/London",
  });
}

function compactVolume(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "—";
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}bn`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}m`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return v.toFixed(0);
}

/**
 * Compact price/volume chart plus the event timeline for a single scan match:
 * where the 50d reclaim happened, the surge window, how thin the tape was and
 * where the pullback entry zone sits.
 */
export function SetupMatchChart({ match }: { match: SetupMatch }) {
  const t = match.timeline;

  const data = useMemo(
    () =>
      t.series.map((p) => ({
        ...p,
        label: shortDate(p.date),
      })),
    [t.series],
  );

  const domain = useMemo(() => {
    const lows = [
      ...t.series.map((p) => p.close),
      ...t.series.map((p) => p.sma200 ?? Number.NaN),
      match.zoneLow,
      match.invalidationBelow,
    ].filter((n) => Number.isFinite(n)) as number[];
    const min = Math.min(...lows);
    const max = Math.max(...lows, match.zoneHigh);
    const pad = (max - min) * 0.06 || max * 0.02;
    return [min - pad, max + pad] as [number, number];
  }, [t.series, match.zoneLow, match.zoneHigh, match.invalidationBelow]);

  const surgeStartLabel = shortDate(t.surgeStartDate);
  const reclaimLabel = shortDate(t.reclaimDate);
  const endLabel = shortDate(t.surgeEndDate);

  const events = [
    {
      key: "reclaim",
      date: reclaimLabel,
      title: "50d reclaim",
      detail: `Close crossed back above the 50d (${match.sma50.toFixed(2)}) ${
        match.reclaimAgeDays === 0
          ? "today"
          : `${match.reclaimAgeDays} session${match.reclaimAgeDays === 1 ? "" : "s"} ago`
      }`,
    },
    {
      key: "surge",
      date: `${surgeStartLabel} → ${endLabel}`,
      title: "Surge window",
      detail: `+${match.changePct5d.toFixed(1)}% over 5 sessions, peak relative volume ${t.peakRelVolume.toFixed(2)}x`,
    },
    {
      key: "volume",
      date: endLabel,
      title: "Tape check",
      detail: `${compactVolume(t.todayVolume)} vs ${compactVolume(t.avgVolume20d)} 20d average — ${match.relVolume.toFixed(2)}x (unconfirmed)`,
    },
    {
      key: "zone",
      date: "Pending",
      title: "Pullback entry zone",
      detail: `Wait for ${match.zoneLow.toFixed(2)}–${match.zoneHigh.toFixed(2)} to hold; void below ${match.invalidationBelow.toFixed(2)}`,
    },
  ];

  return (
    <div className="space-y-2">
      <div className="h-40 w-full sm:h-44">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10 }}
              interval="preserveStartEnd"
              minTickGap={28}
              stroke="currentColor"
              className="text-muted-foreground"
            />
            <YAxis
              yAxisId="price"
              domain={domain}
              width={44}
              tick={{ fontSize: 10 }}
              stroke="currentColor"
              className="text-muted-foreground"
              tickFormatter={(v: number) => v.toFixed(0)}
            />
            <YAxis yAxisId="vol" hide domain={[0, (max: number) => max * 4]} />
            <Tooltip
              contentStyle={{
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 11,
              }}
              formatter={(value: unknown, name: string) => {
                const n = typeof value === "number" ? value : Number(value);
                if (!Number.isFinite(n)) return ["—", name];
                if (name === "volume") return [compactVolume(n), "Volume"];
                if (name === "relVolume") return [`${n.toFixed(2)}x`, "Rel. volume"];
                return [n.toFixed(2), name === "close" ? "Close" : name];
              }}
            />

            {/* Pullback entry zone */}
            <ReferenceArea
              yAxisId="price"
              y1={match.zoneLow}
              y2={match.zoneHigh}
              fill="var(--primary)"
              fillOpacity={0.12}
              stroke="var(--primary)"
              strokeOpacity={0.3}
            />
            <ReferenceLine
              yAxisId="price"
              y={match.invalidationBelow}
              stroke="var(--destructive)"
              strokeDasharray="4 3"
              strokeOpacity={0.8}
            />
            {/* Surge window + reclaim date */}
            <ReferenceArea
              yAxisId="price"
              x1={surgeStartLabel}
              x2={endLabel}
              fill="currentColor"
              className="text-muted-foreground"
              fillOpacity={0.08}
            />
            <ReferenceLine
              yAxisId="price"
              x={reclaimLabel}
              stroke="var(--primary)"
              strokeDasharray="2 3"
            />

            <Bar
              yAxisId="vol"
              dataKey="volume"
              fill="currentColor"
              className="text-muted-foreground"
              fillOpacity={0.25}
              isAnimationActive={false}
            />
            <Area
              yAxisId="price"
              dataKey="close"
              type="monotone"
              stroke="var(--primary)"
              strokeWidth={1.8}
              fill="var(--primary)"
              fillOpacity={0.08}
              isAnimationActive={false}
            />
            <Line
              yAxisId="price"
              dataKey="sma50"
              type="monotone"
              dot={false}
              stroke="currentColor"
              className="text-muted-foreground"
              strokeWidth={1}
              isAnimationActive={false}
              connectNulls
            />
            <Line
              yAxisId="price"
              dataKey="sma200"
              type="monotone"
              dot={false}
              stroke="currentColor"
              className="text-muted-foreground"
              strokeWidth={1}
              strokeDasharray="5 4"
              isAnimationActive={false}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <ol className="space-y-1.5 text-[11px]">
        {events.map((e) => (
          <li key={e.key} className="flex gap-2">
            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
            <span>
              <span className="font-medium">{e.title}</span>
              <span className="text-muted-foreground"> · {e.date}</span>
              <span className="block text-muted-foreground">{e.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
