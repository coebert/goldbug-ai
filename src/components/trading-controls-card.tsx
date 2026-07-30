// Admin-only trading safety controls: master kill switch + daily BUY notional
// ceiling. Both limits are enforced server-side in live-executor.server before
// any order reaches the broker; this card is only the operator surface.

import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  getTradingControls,
  updateTradingControls,
  type TradingControls,
} from "@/lib/trading-controls.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function TradingControlsCard() {
  const load = useServerFn(getTradingControls);
  const save = useServerFn(updateTradingControls);
  const [controls, setControls] = useState<TradingControls | null>(null);
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void load()
      .then((c) => {
        if (cancelled) return;
        setControls(c);
        setLimit(String(c.daily_notional_limit));
      })
      .catch(() => {
        /* signed-out or offline: card stays in its loading state */
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  type ControlsPatch = {
    trading_enabled?: boolean;
    daily_notional_limit?: number;
    halt_reason?: string | null;
  };

  async function apply(patch: ControlsPatch) {
    setBusy(true);
    try {
      await save({ data: patch });
      const fresh = await load();
      setControls(fresh);
      setLimit(String(fresh.daily_notional_limit));
      toast.success("Trading controls updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  const readOnly = !controls?.is_admin || busy;

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-base">
          {controls?.trading_enabled ? (
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
          ) : (
            <ShieldAlert className="h-4 w-4 text-destructive" aria-hidden="true" />
          )}
          Trading safety controls
          {controls && !controls.is_admin ? (
            <Badge variant="outline" className="ml-auto">View only</Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          Hard limits checked immediately before any real order is sent to the
          broker. They apply even if the strategy, a scheduled job, or an API
          caller asks for something bigger.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="trading-enabled">Allow live orders</Label>
            <p className="text-xs text-muted-foreground">
              Turn off to stop all broker orders immediately. Existing positions
              are untouched.
            </p>
          </div>
          <Switch
            id="trading-enabled"
            checked={Boolean(controls?.trading_enabled)}
            disabled={readOnly}
            onCheckedChange={(v) =>
              apply({
                trading_enabled: v,
                halt_reason: v ? null : "Manually halted from Settings",
              })
            }
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="daily-cap">Daily buy limit (£)</Label>
          <div className="flex gap-2">
            <Input
              id="daily-cap"
              inputMode="decimal"
              value={limit}
              disabled={readOnly}
              onChange={(e) => setLimit(e.target.value)}
              className="max-w-40"
            />
            <Button
              variant="secondary"
              disabled={readOnly || Number.isNaN(Number(limit))}
              onClick={() => apply({ daily_notional_limit: Number(limit) })}
            >
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Maximum total value of buy orders that can be placed in one UK
            trading day, across every portfolio. Sell orders are never blocked.
          </p>
        </div>

        {controls && !controls.trading_enabled ? (
          <p className="text-xs text-destructive" role="status">
            Live trading is halted{controls.halt_reason ? `: ${controls.halt_reason}` : "."}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
