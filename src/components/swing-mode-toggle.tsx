import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Activity, AlertTriangle, Loader2, Timer } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { updateRiskConfig } from "@/lib/trading.functions";
import { SWING_DIAL_OVERRIDES } from "@/lib/risk-presets";
import { qk } from "@/lib/query-keys";
import { assessSwingViability } from "@/lib/swing-viability";

/**
 * Always-visible on/off switch for swing trading.
 *
 * Flipping it writes `trading_style` immediately (no Save step, no expanding
 * a settings panel), so the holding horizon can be turned on or off at any
 * time. Turning it ON also applies the swing dial overrides — tight stop,
 * 12% target, 10-day time stop, fast re-entry. Turning it OFF returns the
 * portfolio to position trading (months-long holds, wider stops).
 */
export function SwingModeToggle({
  portfolioId,
  riskConfig,
  equity,
  currency,
}: {
  portfolioId: string;
  riskConfig: unknown;
  /** Total portfolio equity — used to check swing is economically worth it. */
  equity?: number;
  currency?: string | null;
}) {
  const cfg = (riskConfig ?? {}) as Record<string, unknown>;
  // The persisted mode fills in while the portfolio query is still loading, so
  // the switch does not start "Off" and jump to "On" on every refresh.
  const { isSwing: resolved, setStyle } = useTradingMode(portfolioId, riskConfig);
  const serverActive = cfg["trading_style"] === "swing";
  const [active, setActive] = useState(resolved);

  // Keep the switch in sync when the portfolio refetches (or another surface
  // changes the style), but never fight an in-flight optimistic flip.
  useEffect(() => {
    setActive(resolved);
  }, [resolved]);


  // Viability: the engine downgrades swing to position whenever a typical
  // ticket cannot pay its own round-trip costs, so surface that here too.
  const perSymbolPct = (() => {
    const raw = Number(cfg["max_position_pct"] ?? cfg["per_symbol_pct"] ?? 0.2);
    return Number.isFinite(raw) && raw > 0 ? Math.min(1, raw) : 0.2;
  })();
  const viability =
    equity != null && Number.isFinite(equity) && equity > 0
      ? assessSwingViability({ equity, perSymbolPct, currency: currency ?? "GBP" })
      : null;
  const blocked = viability != null && !viability.viable;

  const qc = useQueryClient();
  const save = useServerFn(updateRiskConfig);
  const mut = useMutation({
    mutationFn: (next: boolean) =>
      save({
        data: {
          portfolio_id: portfolioId,
          risk_config: next
            ? { ...cfg, ...SWING_DIAL_OVERRIDES, trading_style: "swing" }
            : { ...cfg, trading_style: "position" },
        },
      }),
    onSuccess: (_r, next) => {
      qc.invalidateQueries({ queryKey: qk.portfolio.detail(portfolioId) });
      toast.success(
        next
          ? "Swing trading active — days-to-weeks holds, tighter stops and targets"
          : "Swing trading off — back to position trading (months-long holds)",
      );
    },
    onError: (e, next) => {
      setActive(!next); // roll the switch back
      toast.error(e instanceof Error ? e.message : "Could not change trading style");
    },
  });

  const onToggle = (next: boolean) => {
    setActive(next);
    mut.mutate(next);
  };

  return (
    <Card className={active ? "border-primary/50" : undefined}>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-2 text-sm font-semibold">
              {active ? (
                <Activity className="h-4 w-4 text-primary" />
              ) : (
                <Timer className="h-4 w-4 text-muted-foreground" />
              )}
              Swing trading
            </span>
            <Badge variant={active ? "default" : "secondary"} className="text-[11px]">
              {active ? "Active" : "Inactive"}
            </Badge>
            {mut.isPending && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> saving
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {active
              ? "Holding days to weeks: 6% stop, 12% target, 10-day time stop, 2-session minimum hold, fast re-entry."
              : "Position trading: months-long holds with wider stops and slower turnover. Turn on to trade the short horizon."}
          </p>
          {blocked && viability && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-500">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {active
                  ? "Swing is switched on but the engine is running position trades: "
                  : "Swing is not financially viable right now: "}
                a {Math.round(viability.ticket).toLocaleString("en-GB")} {viability.currency} ticket
                costs {viability.roundTripBps.toFixed(0)}bps per round trip against a{" "}
                {viability.budgetBps.toFixed(0)}bps cost budget. Viable from about{" "}
                {Math.round(viability.minViableTicket).toLocaleString("en-GB")} {viability.currency}{" "}
                per position.
              </span>
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-xs text-muted-foreground sm:hidden">
            {active ? "On" : "Off"}
          </span>
          <Switch
            checked={active}
            disabled={mut.isPending}
            onCheckedChange={onToggle}
            aria-label="Swing trading active"
          />
        </div>
      </CardContent>
    </Card>
  );
}
