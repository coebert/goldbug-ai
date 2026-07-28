import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import {
  getCreditBudgetStatus,
  updateCreditBudgetSettings,
} from "@/lib/credit-budget.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Wallet } from "lucide-react";

/**
 * In-app credit-budget early warning.
 *
 * Note to reader: the deployed Worker cannot query Lovable's authoritative
 * workspace credit balance at runtime. This card estimates spend from the
 * app's own ai_decision_audit trail (one row ≈ one AI gateway call) and is
 * directional. The daily cron pushes a browser notification when
 * month-to-date or projected month-end spend crosses the configured
 * thresholds — so you get warned days before trading is blocked.
 * Lovable → Settings → Plans & credits remains the source of truth.
 */
export function CreditBudgetCard() {
  const fetchStatus = useServerFn(getCreditBudgetStatus);
  const saveSettings = useServerFn(updateCreditBudgetSettings);
  const qc = useQueryClient();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["credit-budget-status"],
    queryFn: () => fetchStatus(),
    staleTime: 60_000,
  });

  const [form, setForm] = useState<{
    monthly_budget_credits: string;
    credits_per_ai_call: string;
    warn_pct_mtd: string;
    warn_pct_projection: string;
    enabled: boolean;
  } | null>(null);

  useEffect(() => {
    if (data?.settings && !form) {
      setForm({
        monthly_budget_credits: String(data.settings.monthly_budget_credits),
        credits_per_ai_call: String(data.settings.credits_per_ai_call),
        warn_pct_mtd: String(data.settings.warn_pct_mtd),
        warn_pct_projection: String(data.settings.warn_pct_projection),
        enabled: data.settings.enabled,
      });
    }
  }, [data, form]);

  const save = useMutation({
    mutationFn: async () => {
      if (!form) return;
      await saveSettings({
        data: {
          monthly_budget_credits: Number(form.monthly_budget_credits),
          credits_per_ai_call: Number(form.credits_per_ai_call),
          warn_pct_mtd: Number(form.warn_pct_mtd),
          warn_pct_projection: Number(form.warn_pct_projection),
          enabled: form.enabled,
        },
      });
    },
    onSuccess: () => {
      toast.success("Credit budget updated");
      qc.invalidateQueries({ queryKey: ["credit-budget-status"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  const v = data?.verdict;
  const pctMtd = v ? Math.max(0, Math.min(200, v.pctMtd)) : 0;
  const pctProj = v ? Math.max(0, Math.min(200, v.pctProjection)) : 0;

  const barTone = (pct: number, threshold: number) =>
    pct >= threshold ? "bg-destructive" : pct >= threshold * 0.75 ? "bg-amber-500" : "bg-primary";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="h-5 w-5" />
          Credit budget — early warning
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          The app can't read your Lovable workspace credit balance directly. This
          panel estimates spend from AI-decision audit rows (≈ 1 gateway call each)
          and pushes a browser alert once a day if month-to-date or projected
          month-end usage crosses your thresholds. Authoritative balance lives in
          Lovable → Settings → Plans &amp; credits.
        </p>

        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

        {v && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <Stat label="MTD calls" value={v.mtdCalls.toLocaleString()} />
              <Stat label="MTD credits (est)" value={v.mtdCredits.toFixed(1)} />
              <Stat label="7-day burn/day" value={`${v.dailyBurnCredits.toFixed(1)} cr`} />
              <Stat label="Projected month" value={`${v.projectedMonthCredits.toFixed(0)} cr`} />
            </div>

            <div className="space-y-2">
              <BudgetBar
                label={`MTD vs budget (${v.budgetCredits} cr)`}
                pct={pctMtd}
                threshold={data!.settings.warn_pct_mtd}
                barClass={barTone(pctMtd, data!.settings.warn_pct_mtd)}
              />
              <BudgetBar
                label="Projected month vs budget"
                pct={pctProj}
                threshold={data!.settings.warn_pct_projection}
                barClass={barTone(pctProj, data!.settings.warn_pct_projection)}
              />
            </div>

            {v.alerts.length > 0 && (
              <div className="space-y-2">
                {v.alerts.map((a) => (
                  <Alert key={a.kind} variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertTitle className="capitalize">
                      {a.kind.replace(/_/g, " ")}
                    </AlertTitle>
                    <AlertDescription>{a.remedy}</AlertDescription>
                  </Alert>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">Daily 08:00 UK</Badge>
              <span>Last evaluated {new Date(v.probedAt).toLocaleString()}</span>
              <Button size="sm" variant="ghost" onClick={() => refetch()}>Refresh</Button>
            </div>
          </div>
        )}

        {form && (
          <div className="border-t pt-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field id="cb-budget" label="Monthly budget (credits)">
                <Input id="cb-budget" inputMode="decimal" value={form.monthly_budget_credits}
                  onChange={(e) => setForm({ ...form, monthly_budget_credits: e.target.value })} />
              </Field>
              <Field id="cb-cost" label="Est. credits per AI call">
                <Input id="cb-cost" inputMode="decimal" value={form.credits_per_ai_call}
                  onChange={(e) => setForm({ ...form, credits_per_ai_call: e.target.value })} />
              </Field>
              <Field id="cb-mtd" label="Warn when MTD ≥ (%)">
                <Input id="cb-mtd" inputMode="decimal" value={form.warn_pct_mtd}
                  onChange={(e) => setForm({ ...form, warn_pct_mtd: e.target.value })} />
              </Field>
              <Field id="cb-proj" label="Warn when projected ≥ (%)">
                <Input id="cb-proj" inputMode="decimal" value={form.warn_pct_projection}
                  onChange={(e) => setForm({ ...form, warn_pct_projection: e.target.value })} />
              </Field>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Switch id="cb-enabled" checked={form.enabled}
                  onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
                <Label htmlFor="cb-enabled">Early-warning enabled</Label>
              </div>
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-2">
      <div className="text-[11px] uppercase text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function BudgetBar({ label, pct, threshold, barClass }: { label: string; pct: number; threshold: number; barClass: string }) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span>{label}</span>
        <span className="tabular-nums">{pct.toFixed(0)}% (warn ≥ {threshold}%)</span>
      </div>
      <div className="h-2 w-full bg-muted rounded overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={200} aria-label={label}>
        <div className={`h-full ${barClass}`} style={{ width: `${Math.min(100, pct / 2)}%` }} />
      </div>
    </div>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      {children}
    </div>
  );
}
