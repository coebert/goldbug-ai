import { Activity, Timer } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/**
 * Single source of truth for how the active trading horizon is labelled.
 *
 * The engine only ever runs one of two styles, so the badge is binary:
 * "Swing Active" (days-to-weeks holds, tight stops) vs "Position Only"
 * (months-long holds). Reading `trading_style` off the raw risk_config
 * keeps every surface consistent with what the hourly run actually uses.
 */
export function isSwingActive(riskConfig: unknown): boolean {
  const cfg = (riskConfig ?? {}) as Record<string, unknown>;
  return cfg["trading_style"] === "swing";
}

export function tradingModeLabel(riskConfig: unknown): string {
  return isSwingActive(riskConfig) ? "Swing Active" : "Position Only";
}

export function TradingModeBadge({
  riskConfig,
  className,
}: {
  riskConfig: unknown;
  className?: string;
}) {
  const swing = isSwingActive(riskConfig);
  const Icon = swing ? Activity : Timer;
  return (
    <Badge
      variant={swing ? "default" : "secondary"}
      className={`shrink-0 gap-1 text-[11px] ${className ?? ""}`}
      title={
        swing
          ? "Swing trading: holding days to weeks with tighter stops and targets"
          : "Position trading: months-long holds with wider stops and slower turnover"
      }
    >
      <Icon className="h-3 w-3" />
      {swing ? "Swing Active" : "Position Only"}
    </Badge>
  );
}
