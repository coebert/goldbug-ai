import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { planManualRunRetry, type ManualRunRetryDecision } from "@/lib/manual-run-retry";
import { toast } from "sonner";
import { getAdminHealth, type AdminHealthSnapshot, type BrokerEnvHealth } from "@/lib/admin.functions";
import { triggerHourlyRunNow } from "@/lib/trading.functions";
import { backfillHoldingsHistory } from "@/lib/backfill-holdings-history.functions";
import { listPortfolios } from "@/lib/portfolios.functions";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, Clock, PlayCircle, RefreshCw, ShieldAlert, XCircle, Radio } from "lucide-react";
import { SaxoOAuthPanel } from "@/components/live-trading-card";
import { PushNotificationsCard } from "@/components/push-notifications-card";
import { GlobalSignalDecayCard } from "@/components/global-signal-decay-card";
import { SecurityAuditCard } from "@/components/security-audit-card";
import { SecurityAlertSettingsCard } from "@/components/security-alert-settings-card";
import { NotificationsPanel } from "@/components/notifications-panel";
import { TranslationQualityCard } from "@/components/translation-quality-card";
import { BatchLessonsCard } from "@/components/batch-lessons-card";
import { RetrainScheduleCard } from "@/components/retrain-schedule-card";
import { RunMetricsCard } from "@/components/run-metrics-card";
import { SchedulerStatusCard } from "@/components/scheduler-status-card";
import { RunPortfolioStatusTable } from "@/components/admin/run-portfolio-status-table";
import { PreflightAnomalyCard } from "@/components/preflight-anomaly-card";
import { MicrostructureCalibrationCard } from "@/components/microstructure-calibration-card";
import { OrderReconciliationCard } from "@/components/order-reconciliation-card";
import { StartingCashIntegrityCard } from "@/components/starting-cash-integrity-card";
import { CashSyncReconciliationCard } from "@/components/cash-sync-reconciliation-card";
import { PriceScalingAuditCard } from "@/components/price-scaling-audit-card";
import { FillUnitBackfillCard } from "@/components/fill-unit-backfill-card";
import { SaxoAccountKeyWizard } from "@/components/admin/saxo-account-key-wizard";
import { CreditBudgetCard } from "@/components/credit-budget-card";
import { POLL } from "@/lib/query-keys";



export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Admin — Broker Health & Alerts | Aegis" },
      { name: "description", content: "Broker health, token expiry countdown, and order routing status." },
      { property: "og:title", content: "Admin — Broker Health & Alerts | Aegis" },
      { property: "og:description", content: "Broker health, token expiry countdown, and order routing status." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminPage,
});

function fmtDuration(secs: number | null): string {
  if (secs == null) return "—";
  if (secs <= 0) return "expired";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "never";
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

interface AlertItem {
  severity: "critical" | "warning" | "info";
  title: string;
  body: string;
}

function computeAlerts(s: AdminHealthSnapshot): AlertItem[] {
  const a: AlertItem[] = [];
  for (const env of s.environments) {
    if (!env.oauth.connected) {
      a.push({
        severity: env.env === "sim" ? "warning" : "info",
        title: `Saxo ${env.env.toUpperCase()} not connected`,
        body: "OAuth handshake never completed — connect from the Live Trading card.",
      });
    } else if (env.oauth.usingLegacyToken) {
      a.push({
        severity: "warning",
        title: `Saxo ${env.env.toUpperCase()} using legacy 24h token`,
        body: "Complete the OAuth flow to enable auto-refresh.",
      });
    } else if ((env.oauth.secondsUntilExpiry ?? 0) < 15 * 60) {
      a.push({
        severity: "critical",
        title: `Saxo ${env.env.toUpperCase()} token expires imminently`,
        body: `${fmtDuration(env.oauth.secondsUntilExpiry)} remaining — auto-refresh should fire on next call.`,
      });
    }

    if (env.oauth.refreshExpiresAt) {
      const secs = Math.floor((new Date(env.oauth.refreshExpiresAt).getTime() - Date.now()) / 1000);
      if (secs < 3 * 86400) {
        a.push({
          severity: "warning",
          title: `Saxo ${env.env.toUpperCase()} refresh token expires in ${fmtDuration(secs)}`,
          body: "Reconnect the OAuth flow before it lapses or auto-refresh will stop.",
        });
      }
    }

    if (env.oauth.connected && !env.ping.ok) {
      a.push({
        severity: "critical",
        title: `Saxo ${env.env.toUpperCase()} ping failed`,
        body: env.ping.reason ?? "Broker unreachable.",
      });
    }
  }

  if (s.routing.failureCount24h > 0) {
    a.push({
      severity: "warning",
      title: `${s.routing.failureCount24h} routing failure(s) in the last 24h`,
      body: s.routing.lastFailureError ?? "See broker log for details.",
    });
  }

  if (!s.cron.ranWithinHour && s.cron.lastRunAt) {
    a.push({
      severity: "warning",
      title: "Hourly cron looks stale",
      body: `Last broker-log entry ${fmtRelative(s.cron.lastRunAt)}. Cron should fire hourly.`,
    });
  }

  if (s.paperOnlyKillSwitch) {
    a.push({
      severity: "info",
      title: "LIVE_SIM_PAPER_ONLY is armed",
      body: "SIM portfolios are held in paper mode; live_prod is unaffected.",
    });
  }

  return a;
}

function AlertRow({ item }: { item: AlertItem }) {
  const Icon = item.severity === "critical" ? XCircle : item.severity === "warning" ? AlertTriangle : ShieldAlert;
  const color =
    item.severity === "critical" ? "border-destructive/50 text-destructive"
    : item.severity === "warning" ? "border-amber-500/50 text-amber-500"
    : "border-primary/50 text-primary";
  return (
    <Alert className={color}>
      <Icon className="h-4 w-4" />
      <AlertTitle>{item.title}</AlertTitle>
      <AlertDescription className="text-muted-foreground">{item.body}</AlertDescription>
    </Alert>
  );
}

function BrokerCard({ env }: { env: BrokerEnvHealth }) {
  const pingBadge = env.ping.ok
    ? <Badge variant="default" className="bg-emerald-600"><CheckCircle2 className="mr-1 h-3 w-3" />Healthy</Badge>
    : <Badge variant="destructive"><XCircle className="mr-1 h-3 w-3" />{env.oauth.connected ? "Unhealthy" : "Not connected"}</Badge>;

  const secs = env.oauth.secondsUntilExpiry;
  const tokenBadgeColor =
    !env.oauth.connected ? "bg-muted text-muted-foreground"
    : (secs ?? 0) < 15 * 60 ? "bg-destructive text-destructive-foreground"
    : (secs ?? 0) < 60 * 60 ? "bg-amber-500 text-amber-950"
    : "bg-emerald-600 text-emerald-50";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Saxo {env.env.toUpperCase()}</CardTitle>
          {pingBadge}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Ping latency</span>
          <span className="tabular-nums">{env.ping.latencyMs != null ? `${env.ping.latencyMs} ms` : "—"}</span>
        </div>
        {env.ping.accountId && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Account ID</span>
            <span className="font-mono text-xs">{env.ping.accountId}</span>
          </div>
        )}
        {!env.ping.ok && env.ping.reason && (
          <div className="rounded bg-destructive/10 p-2 text-xs text-destructive">{env.ping.reason}</div>
        )}
        <div className="flex justify-between">
          <span className="text-muted-foreground">Access token</span>
          <Badge className={tokenBadgeColor}>
            <Clock className="mr-1 h-3 w-3" />
            {env.oauth.connected ? fmtDuration(secs) : "not connected"}
          </Badge>
        </div>
        {env.oauth.usingLegacyToken && (
          <div className="rounded bg-amber-500/10 p-2 text-xs text-amber-500">
            Using legacy SAXO_ACCESS_TOKEN — connect OAuth for auto-refresh.
          </div>
        )}
        {env.oauth.refreshExpiresAt && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Refresh token expires</span>
            <span className="tabular-nums">
              {fmtDuration(Math.floor((new Date(env.oauth.refreshExpiresAt).getTime() - Date.now()) / 1000))}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AdminPage() {
  const fetchHealth = useServerFn(getAdminHealth);
  const triggerRun = useServerFn(triggerHourlyRunNow);
  const runBackfill = useServerFn(backfillHoldingsHistory);
  const fetchPortfolios = useServerFn(listPortfolios);
  const [tick, setTick] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Force clear: override the engine's 10-minute "already ticked" skip window.
  const [forceTick, setForceTick] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const q = useQuery({
    queryKey: ["admin-health"],
    queryFn: () => fetchHealth(),
    refetchInterval: POLL.SEMI_LIVE,
  });

  const portfoliosQ = useQuery({
    queryKey: ["admin-portfolios"],
    queryFn: () => fetchPortfolios(),
    staleTime: 60_000,
  });
  const portfolioOptions = (portfoliosQ.data ?? []).filter((p) =>
    ["paper", "live_sim", "live_prod"].includes(p.mode as string),
  );

  // --- Manual run with bounded automatic retry -----------------------------
  // The server keeps its hard 55s deadline; we simply make additional bounded
  // attempts for portfolios the deadline left un-ticked.
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const startedAtRef = useRef(0);
  const requestedRef = useRef<string[]>([]);
  const [retryState, setRetryState] = useState<{
    attempt: number;
    pending: number;
    reason: string;
  } | null>(null);

  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );

  const manual = useMutation({
    mutationFn: (vars: { force?: boolean; forceTick?: boolean; portfolioIds?: string[] } = {}) =>
      triggerRun({
        data: {
          force: vars.force === true,
          forceTick: vars.forceTick === true,
          portfolioIds: vars.portfolioIds ?? [],
        },
      }),

    onSuccess: (result) => {
      const ran = result.results.filter((r) => r.ok && !r.skipped).length;
      const skipped = result.results.filter((r) => r.skipped).length;
      const plan = planManualRunRetry({
        attempt: attemptRef.current,
        elapsedMs: Date.now() - startedAtRef.current,
        requestedIds: requestedRef.current,
        outcome: { kind: "success", portfolioStatus: result.portfolio_status ?? [] },
      });
      if (plan.shouldRetry) {
        scheduleRetry(plan);
        toast.warning("Run incomplete — retrying", { description: plan.reason });
      } else {
        setRetryState(null);
        if (plan.outcome === "complete") {
          toast.success("Hourly run completed", {
            description: `${ran} portfolio tick(s) ran, ${skipped} skipped. Live portfolios are prioritised to keep manual runs reliable.`,
          });
        } else {
          toast.warning("Run finished with portfolios left un-ticked", {
            description: plan.reason,
          });
        }
      }
      // Poll health a few times so the UI catches up without needing a manual refresh.
      q.refetch();
      setTimeout(() => q.refetch(), 15_000);
      setTimeout(() => q.refetch(), 45_000);
      setTimeout(() => q.refetch(), 90_000);
    },
    onError: (e: Error & { code?: string; ageMs?: number | null }) => {
      const plan = planManualRunRetry({
        attempt: attemptRef.current,
        elapsedMs: Date.now() - startedAtRef.current,
        requestedIds: requestedRef.current,
        outcome: { kind: "error", code: e.code, message: e.message },
      });
      if (plan.shouldRetry) {
        scheduleRetry(plan);
        toast.warning(
          plan.outcome === "lock_held" ? "Run already in progress — retrying" : "Run timed out — retrying",
          { description: plan.reason },
        );
        return;
      }
      setRetryState(null);
      if (e.code === "run_in_progress") {
        toast.warning("Run already in progress", {
          description: `${e.message} Use "Force clear lock & run" if the previous run crashed.`,
        });
      } else {
        toast.error("Manual run failed", { description: e.message });
      }
    },
  });

  function scheduleRetry(plan: ManualRunRetryDecision) {
    attemptRef.current += 1;
    setRetryState({
      attempt: attemptRef.current,
      pending: plan.portfolioIds.length,
      reason: plan.reason,
    });
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => {
      // Never force on a retry: the engine's "already ticked" guard must stay
      // active so completed portfolios are not double-ticked.
      manual.mutate({ portfolioIds: plan.portfolioIds });
    }, plan.delayMs);
  }

  function startManualRun(vars: { force?: boolean; forceTick?: boolean; portfolioIds?: string[] } = {}) {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    attemptRef.current = 1;
    startedAtRef.current = Date.now();
    requestedRef.current = vars.portfolioIds ?? [];
    setRetryState(null);
    // The Force clear toggle applies to the operator-initiated attempt only;
    // automatic retries never override the guard.
    manual.mutate({ ...vars, forceTick: vars.forceTick ?? forceTick });
  }


  const backfill = useMutation({
    mutationFn: () => runBackfill({ data: { dryRun: false } }),
    onSuccess: (r) => {
      const msg = `${r.symbolsRefreshed}/${r.symbolsRefreshed + r.symbolsFailed} symbols refreshed · ${r.seriesBuilt} series rebuilt · ${r.issues.length} audit issues`;
      if (r.issues.length === 0) toast.success("Holdings history recomputed", { description: msg });
      else toast.warning("Holdings history recomputed with warnings", { description: msg });
    },
    onError: (e: Error) => toast.error("Backfill failed", { description: e.message }),
  });



  const s = q.data;
  const alerts = s ? computeAlerts(s) : [];
  void tick;


  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl 2xl:max-w-7xl space-y-6 overflow-x-hidden p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold sm:text-2xl">Admin — Broker & Routing Health</h1>
          <p className="text-sm text-muted-foreground">
            Live SIM/PROD broker status, OAuth token countdown, last routed order, and alerts.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">← Home</Link>
          <Link to="/broker-blocks" className="text-sm text-muted-foreground hover:text-foreground">Blocked instruments</Link>
          <Link to="/hedge-fallbacks" className="text-sm text-muted-foreground hover:text-foreground">Hedge fallbacks</Link>
          <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={`mr-2 h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>


      {q.isLoading && <p className="text-sm text-muted-foreground">Pinging brokers…</p>}
      {q.error && <Alert variant="destructive"><AlertTitle>Failed to load</AlertTitle><AlertDescription>{(q.error as Error).message}</AlertDescription></Alert>}

      <Card className="border-primary/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PlayCircle className="h-4 w-4 text-primary" /> Manual run
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Trigger the full hourly cycle right now — refreshes news, macro regime, and prices,
            then runs a decision tick for every eligible portfolio. Runs already made in the
            current UTC hour are skipped automatically, so this is safe to click any time
            between scheduled runs.
          </p>

          <div className="rounded-md border p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-sm font-medium">Portfolios to run</span>
              <span className="text-xs text-muted-foreground">
                {selectedIds.length === 0
                  ? "All eligible portfolios"
                  : `${selectedIds.length} selected`}
              </span>
            </div>
            {portfoliosQ.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading portfolios…</p>
            ) : portfolioOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">No eligible portfolios found.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {portfolioOptions.map((p) => (
                  <label key={p.id} className="flex min-w-0 items-center gap-2 text-sm">
                    <Checkbox
                      className="shrink-0"
                      checked={selectedIds.includes(p.id)}
                      onCheckedChange={(v) =>
                        setSelectedIds((prev) =>
                          v === true ? [...prev, p.id] : prev.filter((id) => id !== p.id),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
                      {String(p.mode).replace("_", " ")}
                    </Badge>
                  </label>
                ))}
              </div>
            )}
            {selectedIds.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2 h-7 px-2 text-xs"
                onClick={() => setSelectedIds([])}
              >
                Clear selection
              </Button>
            )}
          </div>

          <label className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
            <Checkbox
              checked={forceTick}
              onCheckedChange={(v) => setForceTick(v === true)}
              disabled={manual.isPending}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium text-foreground">Force clear the “already ticked” window</span>
              <span className="block text-muted-foreground">
                Re-tick portfolios that already ran in the last 10 minutes, without clearing the
                run lock. Automatic retries ignore this.
              </span>
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={() => startManualRun({ portfolioIds: selectedIds })}
              disabled={manual.isPending}
              className="gap-2"
            >
              <PlayCircle className={`h-4 w-4 ${manual.isPending ? "animate-pulse" : ""}`} />
              {manual.isPending
                ? "Running cycle…"
                : selectedIds.length > 0
                  ? `Run ${selectedIds.length} selected portfolio${selectedIds.length > 1 ? "s" : ""}`
                  : "Trigger hourly run now"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const scope =
                  selectedIds.length > 0
                    ? `${selectedIds.length} selected portfolio(s)`
                    : "all eligible portfolios";
                if (window.confirm(`Force clear the current run lock and start a fresh run for ${scope}? Only use this if the previous run crashed or is genuinely stuck.`)) {
                  startManualRun({ force: true, portfolioIds: selectedIds });
                }
              }}
              disabled={manual.isPending}
            >
              {selectedIds.length > 0
                ? "Force clear lock & run selected"
                : "Force clear lock & run"}
            </Button>

            <Button
              variant="secondary"
              size="sm"
              onClick={() => backfill.mutate()}
              disabled={backfill.isPending}
              className="gap-2"
              title="Refresh price_cache back to each holding's opened_at and re-audit every sparkline. Idempotent."
            >
              <RefreshCw className={`h-4 w-4 ${backfill.isPending ? "animate-spin" : ""}`} />
              {backfill.isPending ? "Recomputing…" : "Recompute holdings history"}
            </Button>
            {manual.isSuccess && manual.data && (
              <span className="text-xs text-muted-foreground">
                Run completed — {manual.data.results.filter((r) => r.ok && !r.skipped).length} ran, {manual.data.results.filter((r) => r.skipped).length} skipped.
              </span>
            )}
          </div>
          {manual.isError && (
            <Alert variant="destructive">
              <AlertTitle>Trigger failed</AlertTitle>
              <AlertDescription>{(manual.error as Error).message}</AlertDescription>
            </Alert>
          )}
          {manual.isSuccess && manual.data?.telemetry && (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-xs space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Run diagnostics</span>
                <code className="text-muted-foreground">{manual.data.telemetry.run_id}</code>
                {manual.data.telemetry.deadline_exceeded ? (
                  <Badge variant="destructive">
                    Deadline exceeded by {(manual.data.telemetry.overrun_ms / 1000).toFixed(1)}s
                  </Badge>
                ) : (
                  <Badge variant="secondary">Within deadline</Badge>
                )}
              </div>
              <div className="text-muted-foreground">
                Duration {(manual.data.telemetry.duration_ms / 1000).toFixed(1)}s of{" "}
                {(manual.data.telemetry.budget_ms / 1000).toFixed(0)}s budget · pre-flight{" "}
                {(manual.data.telemetry.preflight_ms / 1000).toFixed(1)}s (
                {manual.data.telemetry.preflight_budget_pct}% of budget
                {manual.data.telemetry.preflight_refresh ? "" : ", refreshes disabled"})
              </div>
              <div className="text-muted-foreground">
                Phases:{" "}
                {manual.data.telemetry.phases
                  .map((p) => `${p.phase} ${p.skipped ? "skipped" : `${(p.ms / 1000).toFixed(1)}s`}`)
                  .join(" · ")}
              </div>
              {manual.data.telemetry.selection && (
                <div className="text-muted-foreground">
                  Selection:{" "}
                  {manual.data.telemetry.selection.scoped
                    ? `${manual.data.telemetry.selection.matched.length} of ${manual.data.telemetry.selection.requested_count} requested matched`
                    : "all eligible portfolios"}
                  {manual.data.telemetry.selection.unknown_ids.length > 0 &&
                    ` · unknown ids: ${manual.data.telemetry.selection.unknown_ids.join(", ")}`}
                  {manual.data.telemetry.selection.paused_excluded.length > 0 &&
                    ` · paused excluded: ${manual.data.telemetry.selection.paused_excluded.length}`}
                </div>
              )}
              <div className="text-muted-foreground">
                Ticked {manual.data.telemetry.ticked.length} · skipped for budget{" "}
                {manual.data.telemetry.skipped_budget.length}
              </div>
            </div>
          )}

          {manual.isSuccess && manual.data?.portfolio_status && (
            <RunPortfolioStatusTable rows={manual.data.portfolio_status} />
          )}

          {retryState && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-500">
              Auto-retry {retryState.attempt} of 3 queued
              {retryState.pending > 0 ? ` for ${retryState.pending} portfolio(s)` : ""} — {retryState.reason}
              {" "}The per-run deadline is unchanged; retries are extra bounded attempts.
            </div>

          )}




        </CardContent>
      </Card>

      <PreflightAnomalyCard />

      <SchedulerStatusCard />

      <RunMetricsCard />

      <OrderReconciliationCard />




      <BatchLessonsCard />

      <RetrainScheduleCard />





      <Card className="border-primary/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Radio className="h-4 w-4 text-primary" /> Broker connection — Connect your Saxo account
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SaxoOAuthPanel />
        </CardContent>
      </Card>

      <SaxoAccountKeyWizard />

      <CreditBudgetCard />

      <PushNotificationsCard />

      <GlobalSignalDecayCard />

      <MicrostructureCalibrationCard />


      <SecurityAlertSettingsCard />

      <NotificationsPanel />

      <SecurityAuditCard />

      <StartingCashIntegrityCard />
      <CashSyncReconciliationCard />
      <PriceScalingAuditCard />
      <FillUnitBackfillCard />



      <TranslationQualityCard />





      {s && (
        <>
          {alerts.length > 0 ? (
            <div className="space-y-2">
              {alerts.map((a, i) => <AlertRow key={i} item={a} />)}
            </div>
          ) : (
            <Alert className="border-emerald-500/50 text-emerald-500">
              <CheckCircle2 className="h-4 w-4" />
              <AlertTitle>All systems nominal</AlertTitle>
              <AlertDescription className="text-muted-foreground">
                No broker, token, or routing alerts.
              </AlertDescription>
            </Alert>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            {s.environments.map((env) => <BrokerCard key={env.env} env={env} />)}
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">Order routing (last 24h)</CardTitle></CardHeader>
            <CardContent className="grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <div className="text-xs text-muted-foreground">Successful routes</div>
                <div className="text-2xl font-semibold text-emerald-500 tabular-nums">{s.routing.successCount24h}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Failures</div>
                <div className={`text-2xl font-semibold tabular-nums ${s.routing.failureCount24h > 0 ? "text-destructive" : ""}`}>
                  {s.routing.failureCount24h}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Paper-only skips</div>
                <div className="text-2xl font-semibold tabular-nums">{s.routing.paperSkipCount24h}</div>
              </div>
              <div className="sm:col-span-3 space-y-2 border-t pt-3">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="text-muted-foreground">Last successful route</span>
                  <span>
                    {s.routing.lastSuccessAt
                      ? <>{fmtRelative(s.routing.lastSuccessAt)} · <span className="font-mono text-xs">{s.routing.lastSuccessEnv}</span> · <span className="font-mono text-xs">{s.routing.lastSuccessPath}</span></>
                      : <span className="text-muted-foreground">no orders routed yet</span>}
                  </span>
                </div>
                {s.routing.lastFailureAt && (
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="text-muted-foreground">Last failure</span>
                    <span className="text-destructive">{fmtRelative(s.routing.lastFailureAt)} · {s.routing.lastFailureError}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Hourly cron last activity</span>
                  <span>
                    {fmtRelative(s.cron.lastRunAt)}
                    {" "}
                    {s.cron.ranWithinHour
                      ? <Badge className="bg-emerald-600 ml-2">on schedule</Badge>
                      : <Badge variant="destructive" className="ml-2">stale</Badge>}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Snapshot generated {fmtRelative(s.generatedAt)} · auto-refreshes every 60s
          </p>
        </>
      )}
    </div>
  );
}
