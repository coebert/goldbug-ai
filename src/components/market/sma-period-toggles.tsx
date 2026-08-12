// Moving-average period toggles, shared by the home card and the full chart
// page so both offer the same 20/50/100/200 overlay controls.

import { Button } from "@/components/ui/button";
import { SMA_PERIODS, type SmaPeriod } from "@/lib/market-symbol-history";
import { PERIOD_STYLE } from "@/lib/sma-display";

export function SmaPeriodToggles({
  periods,
  onToggle,
  className,
}: {
  periods: readonly SmaPeriod[];
  onToggle: (period: SmaPeriod) => void;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-wrap gap-1 ${className ?? ""}`}
      role="group"
      aria-label="Moving-average periods"
    >
      {SMA_PERIODS.map((p) => {
        const on = periods.includes(p);
        return (
          <Button
            key={p}
            size="sm"
            variant={on ? "secondary" : "ghost"}
            className="h-11 px-3 text-xs sm:h-7 sm:px-2"
            aria-pressed={on}
            aria-label={`${p}-day moving average`}
            onClick={() => onToggle(p)}
          >
            <span
              className="mr-1.5 inline-block h-0.5 w-3 rounded"
              style={{ background: PERIOD_STYLE[p].stroke, opacity: on ? 1 : 0.4 }}
              aria-hidden="true"
            />
            {p}d
          </Button>
        );
      })}
    </div>
  );
}
