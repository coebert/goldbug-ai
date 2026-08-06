import { Sparkline } from "@/components/sparkline";
import { sparklineDomain } from "@/lib/sparkline-scale";

/**
 * A holding-trend sparkline wrapped in a labelled, standardised axis frame.
 *
 * The bare `<Sparkline/>` is a shape with no reference points: you can see the
 * line rise but not what it rose *from*, *to*, or *over what period*. This
 * frame adds:
 *
 *  - a y-axis with three ticks (bottom / middle / top) formatted in the
 *    holding's own currency, taken from the SAME `sparklineDomain` the line is
 *    drawn against, so labels and geometry can never drift apart;
 *  - an x-axis with the first and last observation times plus a unit caption
 *    ("hourly" / "daily"), so two charts with different point counts are still
 *    comparable;
 *  - horizontal gridlines at each tick.
 *
 * Labels are real HTML text outside the stretched SVG. Drawing them inside the
 * SVG would inherit `preserveAspectRatio="none"` and squash the glyphs.
 */
export function AxisFramedSparkline({
  values,
  formatValue,
  xStart,
  xEnd,
  xUnit,
  valueAxisLabel = "Price",
  label,
  className,
}: {
  values: number[];
  /** Formats a y tick, normally a currency formatter for the holding. */
  formatValue: (n: number) => string;
  /** Left-most x label (first observation). */
  xStart: string;
  /** Right-most x label (latest observation). */
  xEnd: string;
  /** Caption describing the x resolution, e.g. "hourly · 136 pts". */
  xUnit?: string;
  valueAxisLabel?: string;
  label?: string;
  className?: string;
}) {
  const domain = sparklineDomain(values);
  const [lo, mid, hi] = domain.ticks;

  return (
    <figure className={`m-0 ${className ?? ""}`}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-1.5">
        {/* y-axis ticks: top / middle / bottom, aligned to the plot box. */}
        <div
          className="flex h-14 shrink-0 flex-col justify-between py-px text-right text-[9px] leading-none tabular-nums text-muted-foreground sm:h-16 sm:text-[10px]"
          aria-hidden
        >
          <span>{formatValue(hi)}</span>
          <span className="text-muted-foreground/70">{formatValue(mid)}</span>
          <span>{formatValue(lo)}</span>
        </div>

        <div className="relative h-14 w-full border-b border-l border-border/60 sm:h-16">
          {/* Gridlines at the middle and top ticks (bottom is the axis rule). */}
          <div className="pointer-events-none absolute inset-0" aria-hidden>
            <div className="absolute inset-x-0 top-0 border-t border-dashed border-border/30" />
            <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-border/30" />
          </div>
          <Sparkline
            values={values}
            domain={domain}
            stretch
            className="h-full w-full"
            label={label}
          />
        </div>

        {/* x-axis: start / unit / end, under the plot box only. */}
        <div aria-hidden />
        <div className="flex items-baseline justify-between gap-2 pt-1 text-[9px] leading-none text-muted-foreground sm:text-[10px]">
          <span className="tabular-nums">{xStart}</span>
          {xUnit && <span className="truncate text-muted-foreground/70">{xUnit}</span>}
          <span className="tabular-nums">{xEnd}</span>
        </div>
      </div>

      <figcaption className="sr-only">
        {valueAxisLabel} on the vertical axis from {formatValue(lo)} to {formatValue(hi)}; time on
        the horizontal axis from {xStart} to {xEnd}
        {xUnit ? ` (${xUnit})` : ""}.
      </figcaption>
    </figure>
  );
}
