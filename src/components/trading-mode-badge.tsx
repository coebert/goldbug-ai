import { Activity, Timer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useTradingMode } from "@/hooks/use-trading-mode";

/**
 * Single source of truth for how the active trading horizon is labelled.
 *
 * The engine only ever runs one of two styles, so the badge is binary:
 * "Swing Active" (days-to-weeks holds, tight stops) vs "Position Only"
 * (months-long holds). Reading `trading_style` off the raw risk_config
 * keeps every surface consistent with what the hourly run actually uses.
 *
 * Pass `portfolioId` to have the last known mode restored from local storage
 * while the portfolio query is still loading, so the badge does not flash
 * "Position Only" on every refresh.
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
  portfolioId,
  className,
}: {
  riskConfig: unknown;
  portfolioId?: string;
  className?: string;
}) {
  const { isSwing: swing } = useTradingMode(portfolioId, riskConfig);
  const Icon = swing ? Activity : Timer;
  return (
    <Badge
      variant={swing ? "default" : "secondary"}
      className={`inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap px-1.5 py-0.5 text-[10px] leading-none sm:px-2 sm:text-[11px] ${className ?? ""}`}
      title={
        swing
          ? "Swing trading: holding days to weeks with tighter stops and targets"
          : "Position trading: months-long holds with wider stops and slower turnover"
      }
    >
      <Icon className="h-3 w-3 shrink-0" />
      {/* Short label on phones, full wording once there is room. */}
      <span className="sm:hidden">{swing ? "Swing" : "Position"}</span>
      <span className="hidden sm:inline">{swing ? "Swing Active" : "Position Only"}</span>
    </Badge>
  );
}


