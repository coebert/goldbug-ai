import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import type { AbConfidenceResult, BootstrapStat } from "@/lib/backtest/ab-confidence";
import {
  SAXO_AXIS,
  SAXO_COLOR,
  SAXO_TOOLTIP_CONTENT,
  SAXO_TOOLTIP_CURSOR,
  SAXO_TOOLTIP_LABEL,
} from "@/lib/saxo-chart";

const VERDICT: Record<
  AbConfidenceResult["verdict"],
  { label: string; className: string }
> = {
  persistent: {
    label: "Saving persists",
    className: "border-emerald-500/40 text-emerald-400",
  },
  cheaper_but_riskier: {
    label: "Cheaper, riskier",
    className: "border-amber-500/40 text-amber-400",
  },
  inconclusive: {
    label: "Inconclusive",
    className: "border-border text-muted-foreground",
  },
  not_supported: {
    label: "Not supported",
    className: "border-rose-500/40 text-rose-400",
  },
};

function signed(v: number, dp = 1, unit = ""): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(dp)}${unit}`;
}

/**
 * One bootstrap statistic: observed value, 95% interval, and whether the
 * interval clears zero (the only thing that decides "real or noise").
 */
function StatRow({
  label,
  stat,
  unit,
  dp,
  goodIsPositive,
  hint,
}: {
  label: string;
  stat: BootstrapStat;
  unit: string;
  dp: number;
  goodIsPositive: boolean;
  hint: string;
}) {
  const clearsZero = stat.lower > 0 || stat.upper < 0;
  const positive = stat.observed >= 0;
  const good = goodIsPositive ? positive : !positive;
  return (
    <div className="rounded-md border border-border/60 p-2" title={hint}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className={`text-sm font-medium tabular-nums ${
          good ? "text-emerald-400" : "text-rose-400"
        }`}
      >
        {signed(stat.observed, dp, unit)}
      </div>
      <div className="text-[11px] tabular-nums text-muted-foreground">
        95% CI {signed(stat.lower, dp)} to {signed(stat.upper, dp)}
        {unit}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {clearsZero ? "clears zero" : "straddles zero"} ·{" "}
        {(stat.probPositive * 100).toFixed(0)}% of paths positive
      </div>
    </div>
  );
}

/**
 * Statistical confidence panel for the batching A/B: moving-block bootstrap
 * distributions for cost saving, return delta and drawdown delta, so the
 * operator can see whether the saving survives resampling without buying it
 * with extra drawdown.
 */
export function AbConfidencePanel({ confidence }: { confidence: AbConfidenceResult }) {
  const v = VERDICT[confidence.verdict];
  const bars = confidence.costSavingBps.histogram;

  return (
    <div className="space-y-2 rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-medium">Statistical confidence</div>
        <Badge variant="outline" className={v.className}>
          {v.label}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">{confidence.summary}</p>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <StatRow
          label="Cost saving (bps of equity)"
          stat={confidence.costSavingBps}
          unit=""
          dp={1}
          goodIsPositive
          hint="Unbatched costs minus batched costs, in bps of starting equity. Positive = batching is cheaper."
        />
        <StatRow
          label="Return delta (pp)"
          stat={confidence.returnDeltaPct}
          unit=""
          dp={2}
          goodIsPositive
          hint="Batched total return minus unbatched, percentage points."
        />
        <StatRow
          label="Drawdown delta (pp)"
          stat={confidence.drawdownDeltaPct}
          unit=""
          dp={2}
          goodIsPositive={false}
          hint="Batched max drawdown minus unbatched. Positive = batching drew down more, which is worse."
        />
      </div>

      {bars.length > 1 ? (
        <div className="h-28 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={bars} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
              <XAxis
                dataKey="center"
                tick={{ ...SAXO_AXIS, fontSize: 10 }}
                tickFormatter={(x: number) => x.toFixed(0)}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                contentStyle={SAXO_TOOLTIP_CONTENT}
                labelStyle={SAXO_TOOLTIP_LABEL}
                cursor={SAXO_TOOLTIP_CURSOR}
                formatter={(value: number) => [`${value} resamples`, "Count"]}
                labelFormatter={(x: number) => `${signed(Number(x))} bps`}
              />
              <ReferenceLine x={0} stroke={SAXO_COLOR.crosshair} strokeDasharray="3 3" />
              <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                {bars.map((b, i) => (
                  <Cell
                    key={i}
                    fill={b.center >= 0 ? SAXO_COLOR.up : SAXO_COLOR.down}
                    fillOpacity={0.75}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : null}

      <p className="text-[11px] text-muted-foreground">
        {confidence.iterations.toLocaleString()} moving-block resamples ·{" "}
        {confidence.blockDays}-day blocks · {confidence.days} paired bars ·{" "}
        {(confidence.probCheaperAndNoWorse * 100).toFixed(0)}% of paths cheaper AND no worse on
        drawdown
      </p>
    </div>
  );
}
