import { AlertTriangle, RefreshCw } from "lucide-react";
import { useTradingMode } from "@/hooks/use-trading-mode";

const label = (s: "swing" | "position") => (s === "swing" ? "Swing Active" : "Position Only");

/**
 * Inline warning shown when this browser's remembered trading mode disagreed
 * with the mode the engine actually runs (from `risk_config.trading_style`).
 *
 * The hook has already re-synced the cache to the engine value by the time
 * this renders — the notice exists so the user understands why the badge just
 * changed under them instead of assuming the app lost their setting.
 */
export function TradingModeDriftNotice({
  portfolioId,
  riskConfig,
  className,
}: {
  portfolioId?: string;
  riskConfig: unknown;
  className?: string;
}) {
  const { drift, dismissDrift } = useTradingMode(portfolioId, riskConfig);
  if (!drift) return null;
  return (
    <div
      role="status"
      className={`flex flex-wrap items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-snug text-amber-200 sm:text-xs ${className ?? ""}`}
    >
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        This device remembered <strong>{label(drift.from)}</strong>, but the engine is running{" "}
        <strong>{label(drift.to)}</strong>. Re-synced to the engine — trades follow{" "}
        {label(drift.to)}.
      </span>
      <button
        type="button"
        onClick={dismissDrift}
        className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium underline-offset-2 hover:underline"
      >
        <RefreshCw className="h-3 w-3" />
        Dismiss
      </button>
    </div>
  );
}
