// Picks which moving average the trend-strength score is measured on.

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SMA_PERIODS, isSmaPeriod, type SmaPeriod } from "@/lib/market-symbol-history";
import { resolveTrendBasis, type TrendBasis } from "@/lib/sma-display";

export function TrendBasisSelect({
  basis,
  periods,
  onChange,
  className = "h-8 w-[150px] text-xs",
}: {
  basis: TrendBasis;
  periods: readonly SmaPeriod[];
  onChange: (basis: TrendBasis) => void;
  className?: string;
}) {
  const auto = resolveTrendBasis("auto", periods);
  return (
    <Select
      value={String(basis)}
      onValueChange={(v) => onChange(isSmaPeriod(Number(v)) ? (Number(v) as SmaPeriod) : "auto")}
    >
      <SelectTrigger className={className} aria-label="Trend-strength basis">
        <SelectValue placeholder="Trend basis" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto" className="text-xs">
          Trend: auto{auto ? ` (${auto}d)` : ""}
        </SelectItem>
        {SMA_PERIODS.map((p) => (
          <SelectItem key={p} value={String(p)} className="text-xs">
            Trend: {p}-day
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
