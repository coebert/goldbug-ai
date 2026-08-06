import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Activity, Loader2, Timer } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { updateRiskConfig } from "@/lib/trading.functions";
import { SWING_DIAL_OVERRIDES } from "@/lib/risk-presets";
import { qk } from "@/lib/query-keys";

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
}: {
  portfolioId: string;
  riskConfig: unknown;
}) {
  const cfg = (riskConfig ?? {}) as Record<string, unknown>;
  const serverActive = cfg["trading_style"] === "swing";
  const [active, setActive] = useState(serverActive);

  // Keep the switch in sync when the portfolio refetches (or another surface
  // changes the style), but never fight an in-flight optimistic flip.
  useEffect(() => {
    setActive(serverActive);
  }, [serverActive]);

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
