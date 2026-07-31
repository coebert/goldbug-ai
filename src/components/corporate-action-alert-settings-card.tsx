// Settings panel for corporate-action deadline countdown reminders.
// Lets you toggle the reminders and edit the hour ladder (e.g. 72 / 24 / 4
// hours before Saxo's election deadline), and shows what has already fired.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getCorporateActionAlertSettings,
  listCorporateActionAlertHistory,
  updateCorporateActionAlertSettings,
} from "@/lib/corporate-action-deadline-alerts.functions";
import { normalizeThresholds } from "@/lib/corporate-action-deadline-alerts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { AlarmClock } from "lucide-react";
import { formatUkDateTime } from "@/lib/uk-time";
import { toast } from "sonner";

export function CorporateActionAlertSettingsCard() {
  const getSettings = useServerFn(getCorporateActionAlertSettings);
  const saveSettings = useServerFn(updateCorporateActionAlertSettings);
  const getHistory = useServerFn(listCorporateActionAlertHistory);
  const qc = useQueryClient();

  const settings = useQuery({
    queryKey: ["ca-alert-settings"],
    queryFn: () => getSettings(),
  });
  const history = useQuery({
    queryKey: ["ca-alert-history"],
    queryFn: () => getHistory(),
  });

  const [enabled, setEnabled] = useState(true);
  const [ladder, setLadder] = useState("72, 24, 4");

  useEffect(() => {
    if (!settings.data) return;
    setEnabled(settings.data.enabled);
    setLadder(settings.data.thresholdHours.join(", "));
  }, [settings.data]);

  const parsed = normalizeThresholds(
    ladder
      .split(/[,\s]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n)),
  );

  const save = useMutation({
    mutationFn: () =>
      saveSettings({ data: { enabled, thresholdHours: parsed } }),
    onSuccess: () => {
      toast.success("Deadline reminders updated");
      void qc.invalidateQueries({ queryKey: ["ca-alert-settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlarmClock className="h-4 w-4 text-primary" />
          Corporate action deadline reminders
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Sends a push notification a set number of hours before each Saxo
          election deadline. Only events that need your instruction trigger an
          alert, and each countdown step fires once.
        </p>

        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <div className="text-sm font-medium">Reminders enabled</div>
            <div className="text-xs text-muted-foreground">
              Requires push notifications to be switched on above.
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="ca-ladder" className="text-sm font-medium">
            Alert me this many hours before (up to 5 steps)
          </label>
          <Input
            id="ca-ladder"
            value={ladder}
            onChange={(e) => setLadder(e.target.value)}
            placeholder="72, 24, 4"
            inputMode="numeric"
          />
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            Will use:
            {parsed.map((h) => (
              <Badge key={h} variant="secondary" className="text-[11px]">
                {h}h before
              </Badge>
            ))}
          </div>
        </div>

        <Button
          size="sm"
          disabled={save.isPending || settings.isLoading}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save reminders"}
        </Button>

        <div className="space-y-1.5 border-t pt-3">
          <div className="text-xs font-medium">Recent reminders</div>
          {history.data && history.data.length > 0 ? (
            <ul className="space-y-1">
              {history.data.slice(0, 6).map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground"
                >
                  <span className="truncate">
                    {r.eventId} · {r.thresholdHours}h
                    {r.suppressed ? " (skipped — tighter alert sent)" : ""}
                  </span>
                  <span className="shrink-0">{formatUkDateTime(r.sentAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              No deadline reminders sent yet.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
