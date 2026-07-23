import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  getSecurityAlertSettings,
  updateSecurityAlertSettings,
} from "@/lib/security-alerts.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Bell } from "lucide-react";

// Configures push-notification thresholds for SECURITY:pending_slices events.
// A push is sent when the number of events in the lookback window meets or
// exceeds the threshold and the cooldown has elapsed since the last alert.
export function SecurityAlertSettingsCard() {
  const qc = useQueryClient();
  const load = useServerFn(getSecurityAlertSettings);
  const save = useServerFn(updateSecurityAlertSettings);

  const q = useQuery({
    queryKey: ["security-alert-settings"],
    queryFn: () => load(),
    staleTime: 60_000,
  });

  const [enabled, setEnabled] = useState(true);
  const [threshold, setThreshold] = useState(5);
  const [windowMinutes, setWindowMinutes] = useState(60);
  const [cooldownMinutes, setCooldownMinutes] = useState(30);

  useEffect(() => {
    if (!q.data) return;
    setEnabled(q.data.enabled);
    setThreshold(q.data.threshold);
    setWindowMinutes(q.data.window_minutes);
    setCooldownMinutes(q.data.cooldown_minutes);
  }, [q.data]);

  const m = useMutation({
    mutationFn: (input: {
      enabled: boolean;
      threshold: number;
      window_minutes: number;
      cooldown_minutes: number;
    }) => save({ data: input }),
    onSuccess: () => {
      toast.success("Security alert settings saved");
      qc.invalidateQueries({ queryKey: ["security-alert-settings"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  const onSave = () => {
    if (!Number.isFinite(threshold) || threshold < 1) {
      toast.error("Threshold must be at least 1");
      return;
    }
    if (!Number.isFinite(windowMinutes) || windowMinutes < 1) {
      toast.error("Window must be at least 1 minute");
      return;
    }
    if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 0) {
      toast.error("Cooldown cannot be negative");
      return;
    }
    m.mutate({
      enabled,
      threshold: Math.round(threshold),
      window_minutes: Math.round(windowMinutes),
      cooldown_minutes: Math.round(cooldownMinutes),
    });
  };

  const lastAt = q.data?.last_notified_at
    ? new Date(q.data.last_notified_at).toLocaleString()
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bell className="h-4 w-4 text-primary" />
          SECURITY:pending_slices alerts
        </CardTitle>
        <CardDescription>
          Sends a push notification when the count of pending_slices security
          events over your lookback window meets the threshold. Uses your
          registered push subscriptions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border border-border bg-card/40 p-3">
          <div>
            <div className="text-sm font-medium">Enabled</div>
            <p className="text-xs text-muted-foreground">
              Turn off to silence alerts without losing the audit log.
            </p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="sa-threshold" className="text-xs">
              Threshold (events)
            </Label>
            <Input
              id="sa-threshold"
              type="number"
              min={1}
              max={10000}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sa-window" className="text-xs">
              Lookback window (minutes)
            </Label>
            <Input
              id="sa-window"
              type="number"
              min={1}
              max={10080}
              value={windowMinutes}
              onChange={(e) => setWindowMinutes(Number(e.target.value))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sa-cooldown" className="text-xs">
              Cooldown (minutes)
            </Label>
            <Input
              id="sa-cooldown"
              type="number"
              min={0}
              max={10080}
              value={cooldownMinutes}
              onChange={(e) => setCooldownMinutes(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {lastAt ? (
              <>
                Last alert: <span className="font-mono">{lastAt}</span>
                {q.data?.last_notified_count != null
                  ? ` (${q.data.last_notified_count} events)`
                  : ""}
              </>
            ) : (
              "No alerts sent yet."
            )}
          </p>
          <Button size="sm" onClick={onSave} disabled={m.isPending || q.isLoading}>
            {m.isPending ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
