import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EQUITY_DECIMALS_MAX, EQUITY_DECIMALS_MIN } from "@/lib/use-equity-decimals";

/**
 * Dashboard-level display settings. Consolidates the previously-inline
 * "include deposits" toggle, decimals selector and the new focus-mode
 * switch into a single popover, freeing the top of the page from a
 * dense one-line control strip.
 */
export function DashboardSettings({
  includeDeposits,
  onIncludeDepositsChange,
  equityDecimals,
  onEquityDecimalsChange,
  focusMode,
  onFocusModeChange,
}: {
  includeDeposits: boolean;
  onIncludeDepositsChange: (v: boolean) => void;
  equityDecimals: number;
  onEquityDecimalsChange: (v: number) => void;
  focusMode: boolean;
  onFocusModeChange: (v: boolean) => void;
}) {
  const decimalOptions = Array.from(
    { length: EQUITY_DECIMALS_MAX - EQUITY_DECIMALS_MIN + 1 },
    (_, i) => EQUITY_DECIMALS_MIN + i,
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5" aria-label="Dashboard display settings">
          <Settings2 className="h-3.5 w-3.5" /> Display
          {(includeDeposits || focusMode) && (
            <span className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-4">
        <div className="space-y-1">
          <div className="font-display text-sm font-semibold">Dashboard display</div>
          <p className="text-xs text-muted-foreground">
            Controls apply to every portfolio card on this page. Choices are remembered.
          </p>
        </div>

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Label htmlFor="settings-include-deposits" className="text-sm">
              Include deposits in %
            </Label>
            <p className="text-[11px] text-muted-foreground">
              {includeDeposits
                ? "Raw equity change — deposits count as gains."
                : "Trading only — deposits & withdrawals netted out."}
            </p>
          </div>
          <Switch
            id="settings-include-deposits"
            checked={includeDeposits}
            onCheckedChange={onIncludeDepositsChange}
            aria-label="Include deposits in equity percent change"
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="settings-decimals" className="text-sm">
            Equity decimals
          </Label>
          <Select
            value={String(equityDecimals)}
            onValueChange={(v) => onEquityDecimalsChange(Number.parseInt(v, 10))}
          >
            <SelectTrigger id="settings-decimals" className="h-8 w-20 text-xs tabular-nums" aria-label="Decimal places shown for total equity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {decimalOptions.map((n) => (
                <SelectItem key={n} value={String(n)} className="tabular-nums">
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-start justify-between gap-3 border-t border-border/60 pt-3">
          <div className="min-w-0">
            <Label htmlFor="settings-focus-mode" className="text-sm">
              Focus mode
            </Label>
            <p className="text-[11px] text-muted-foreground">
              Hide news, decisions and the overview chart — numbers only.
            </p>
          </div>
          <Switch
            id="settings-focus-mode"
            checked={focusMode}
            onCheckedChange={onFocusModeChange}
            aria-label="Toggle focus mode"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
