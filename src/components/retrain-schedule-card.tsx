import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CalendarClock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { getRetrainSettings, upsertRetrainSettings } from "@/lib/retrain-settings.functions";

const CADENCE_OPTIONS = [
  { value: 1, label: "Daily" },
  { value: 3, label: "Every 3 days" },
  { value: 7, label: "Weekly" },
  { value: 14, label: "Fortnightly" },
  { value: 30, label: "Monthly" },
  { value: 90, label: "Quarterly" },
];

function formatDue(lastRunAt: string | null, cadenceDays: number): string {
  if (!lastRunAt) return "Due on next scheduled run";
  const next = new Date(new Date(lastRunAt).getTime() + cadenceDays * 86400000);
  const now = Date.now();
  if (next.getTime() <= now) return "Due on next scheduled run";
  const days = Math.round((next.getTime() - now) / 86400000);
  return `Next run in ~${days} day${days === 1 ? "" : "s"} (${next.toISOString().slice(0, 10)})`;
}

export function RetrainScheduleCard() {
  const get = useServerFn(getRetrainSettings);
  const save = useServerFn(upsertRetrainSettings);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["retrain-settings"], queryFn: () => get() });

  const [enabled, setEnabled] = useState(true);
  const [cadence, setCadence] = useState(7);

  useEffect(() => {
    if (q.data) {
      setEnabled(q.data.enabled);
      setCadence(q.data.cadence_days);
    }
  }, [q.data]);

  const m = useMutation({
    mutationFn: () => save({ data: { enabled, cadence_days: cadence } }),
    onSuccess: () => {
      toast.success("Retraining schedule saved");
      qc.invalidateQueries({ queryKey: ["retrain-settings"] });
    },
    onError: (e: Error) => toast.error("Failed to save", { description: e.message }),
  });

  const dirty = q.data
    ? q.data.enabled !== enabled || q.data.cadence_days !== cadence
    : false;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="h-4 w-4 text-primary" /> Automatic retraining schedule
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          When enabled, the batch backtest → lesson refresh runs automatically on your
          chosen cadence. Every scheduled run pools trades across all your portfolios,
          re-derives lessons per market regime, and stores them so future AI decisions
          apply them immediately.
        </p>

        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="retrain-enabled" className="text-sm font-medium">
              Auto-retrain enabled
            </Label>
            <p className="text-xs text-muted-foreground">
              Turn off to pause automatic refreshes (manual run stays available).
            </p>
          </div>
          <Switch id="retrain-enabled" checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="space-y-2">
          <Label className="text-sm font-medium">Cadence</Label>
          <Select
            value={String(cadence)}
            onValueChange={(v) => setCadence(Number(v))}
            disabled={!enabled}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CADENCE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={String(o.value)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary">
            Last run: {q.data?.last_run_at ? new Date(q.data.last_run_at).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never"}
          </Badge>
          {q.data?.last_run_status && (
            <Badge variant={q.data.last_run_status === "ok" ? "outline" : "destructive"}>
              {q.data.last_run_status}
            </Badge>
          )}
          <Badge variant="outline">{formatDue(q.data?.last_run_at ?? null, cadence)}</Badge>
        </div>

        {q.data?.last_run_error && (
          <p className="text-xs text-destructive">Last error: {q.data.last_run_error}</p>
        )}

        <Button
          onClick={() => m.mutate()}
          disabled={!dirty || m.isPending}
          className="w-full sm:w-auto"
        >
          {m.isPending ? "Saving…" : "Save schedule"}
        </Button>
      </CardContent>
    </Card>
  );
}
