// Live trading control card. Renders on the portfolio detail page.
// - Shows current mode (paper / live_sim / live_prod), broker status, kill-switch
// - Ping broker, sync balance/positions, activate/deactivate, pause/resume
// - Displays recent broker orders, fills, and reconciliation drift

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  activateLive, deactivateLive, pauseLive, killAllLive, resumeAllLive, getAuditLog,
  pingBroker, syncBrokerBalance, getLiveStatus, reconcilePortfolio, reconcileOrders,
  startSaxoOAuth, getSaxoOAuthStatus, getLiveTradeAlert,
} from "@/lib/live.functions";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Radio, RefreshCw, ShieldOff, Power, PauseCircle, PlayCircle, History, CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight, Send, Clock, Ban, Zap, SkipForward } from "lucide-react";
import { toast } from "sonner";
import { Explain } from "@/components/explain";
import { qk, POLL } from "@/lib/query-keys";

export function LiveTradingCard({ portfolioId }: { portfolioId: string }) {
  const qc = useQueryClient();
  const status = useServerFn(getLiveStatus);
  const activate = useServerFn(activateLive);
  const deactivate = useServerFn(deactivateLive);
  const pause = useServerFn(pauseLive);
  const killAll = useServerFn(killAllLive);
  const resumeAll = useServerFn(resumeAllLive);
  const audit = useServerFn(getAuditLog);
  const ping = useServerFn(pingBroker);
  const syncBal = useServerFn(syncBrokerBalance);
  const reconcile = useServerFn(reconcilePortfolio);
  const reconcileOrdersFn = useServerFn(reconcileOrders);

  const [ackRisk, setAckRisk] = useState(false);
  const [targetEnv, setTargetEnv] = useState<"sim" | "prod">("sim");
  const [showAudit, setShowAudit] = useState(false);

  const q = useQuery({
    queryKey: qk.live.status(portfolioId),
    queryFn: () => status({ data: { portfolioId } }),
  });

  const auditQ = useQuery({
    queryKey: qk.live.audit(portfolioId),
    queryFn: () => audit({ data: { portfolioId, limit: 20 } }),
    enabled: showAudit,
  });

  const tradeAlertFn = useServerFn(getLiveTradeAlert);
  const alertQ = useQuery({
    queryKey: qk.live.tradeAlert(portfolioId),
    queryFn: () => tradeAlertFn({ data: { portfolioId, windowRuns: 5 } }),
    refetchInterval: POLL.SLOW,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.live.status(portfolioId) });
    qc.invalidateQueries({ queryKey: qk.live.audit(portfolioId) });
  };

  const promptReason = (label: string) => {
    if (typeof window === "undefined") return undefined;
    const r = window.prompt(`${label} — reason (optional, saved in audit log):`, "");
    return r?.trim() || undefined;
  };

  const mAct = useMutation({
    mutationFn: () => activate({ data: { portfolioId, targetEnv, useBrokerBalance: true, acknowledgeRisk: true } }),
    onSuccess: (r) => { toast.success(`Live ${targetEnv === "prod" ? "PRODUCTION" : "SIM"} activated. Starting cash: ${r.startingCash ?? "unchanged"}`); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const mDeact = useMutation({
    mutationFn: (reason?: string) => deactivate({ data: { portfolioId, reason } }),
    onSuccess: (r) => { toast.success(r.changed ? "Reverted to paper mode" : `Already in ${r.status.is_live ? r.status.mode : "paper"} mode`); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const mPause = useMutation({
    mutationFn: (args: { paused: boolean; reason?: string }) => pause({ data: { portfolioId, paused: args.paused, reason: args.reason } }),
    onSuccess: (r) => { toast.success(r.paused ? "Paused live trading" : "Resumed live trading"); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const mKill = useMutation({
    mutationFn: (reason?: string) => killAll({ data: { reason } }),
    onSuccess: (r) => {
      toast.warning(
        r.updated > 0
          ? `Kill-switch engaged — paused ${r.updated} portfolio${r.updated === 1 ? "" : "s"}`
          : `Kill-switch confirmed — all ${r.total} already paused`,
      );
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const mResumeAll = useMutation({
    mutationFn: (reason?: string) => resumeAll({ data: { reason } }),
    onSuccess: (r) => { toast.success(`Resumed ${r.resumed} of ${r.total} live portfolios`); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const mPing = useMutation({
    mutationFn: () => ping({ data: { portfolioId } }),
    onSuccess: (r) => toast[r.ok ? "success" : "error"](r.ok ? `Broker OK (${r.latencyMs}ms)` : `Ping failed: ${r.reason}`),
    onError: (e: Error) => toast.error(e.message),
  });
  const mSync = useMutation({
    mutationFn: () => syncBal({ data: { portfolioId } }),
    onSuccess: (r) => {
      const applied = r.sync && !r.sync.skipped
        ? ` — applied ${r.sync.delta >= 0 ? "+" : ""}${r.sync.delta.toFixed(2)} ${r.sync.currency}`
        : "";
      toast.success(`Balance ${r.balance.cash.toFixed(2)} ${r.balance.currency}, ${r.positions.length} positions${applied}`);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const mRecon = useMutation({
    mutationFn: () => reconcile({ data: { portfolioId } }),
    onSuccess: (r) => { toast[r.drift ? "warning" : "success"](r.drift ? "Drift detected — see log" : "In sync with broker"); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const mReconOrders = useMutation({
    mutationFn: () => reconcileOrdersFn({ data: { portfolioId } }),
    onSuccess: (r) => {
      if ("skipped" in r && r.skipped) {
        toast.info("Order reconciliation skipped (not a live portfolio)");
      } else {
        const s = r as { scanned: number; filled: number; partial: number; rejected: number; stillWorking: number; unknown: number };
        toast.success(
          `Reconciled ${s.scanned} order${s.scanned === 1 ? "" : "s"} — ${s.filled} filled, ${s.partial} partial, ${s.rejected} rejected, ${s.stillWorking} working${s.unknown ? `, ${s.unknown} unknown` : ""}`,
        );
      }
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const s = q.data;
  const mode = s?.portfolio.mode ?? "paper";
  const isLive = mode === "live_sim" || mode === "live_prod";
  const paused = !!s?.portfolio.live_paused;

  // One-click hook: the precheck cash alert banner dispatches this event so
  // the user can jump straight from "broker keeps rejecting buys" to a live
  // sync + reconcile without hunting for the button.
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ portfolioId?: string }>).detail;
      if (detail?.portfolioId && detail.portfolioId !== portfolioId) return;
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      if (s?.hasToken && !mSync.isPending) mSync.mutate();
      if (isLive && !mRecon.isPending) mRecon.mutate();
    };
    window.addEventListener("lovable:reconcile-cash", handler as EventListener);
    return () => window.removeEventListener("lovable:reconcile-cash", handler as EventListener);
  }, [portfolioId, s?.hasToken, isLive, mSync, mRecon]);

  return (
    <Card ref={cardRef}>
      <CardHeader>

        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Radio className="h-4 w-4" /> Live trading (Saxo)
              <Badge variant={isLive ? (mode === "live_prod" ? "destructive" : "default") : "outline"}>
                {mode}
              </Badge>
              {paused && <Badge variant="secondary">paused</Badge>}
            </CardTitle>
            <CardDescription>
              Cash-only, no leverage. AI trades are mirrored to your Saxo account after guardrail checks.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            {isLive && paused && (
              <Button variant="outline" size="sm" onClick={() => mResumeAll.mutate(promptReason("Resume all"))} disabled={mResumeAll.isPending}>
                <PlayCircle className="h-4 w-4 mr-1" /> Resume all
              </Button>
            )}
            <Button variant="destructive" size="sm" onClick={() => mKill.mutate(promptReason("Kill-switch"))} disabled={mKill.isPending}>
              <ShieldOff className="h-4 w-4 mr-1" /> <Explain term="kill_switch">Kill-switch</Explain>
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <SaxoOAuthPanel />

        <CashSyncIndicator lastSync={s?.lastCashSync ?? null} pending={mSync.isPending} />

        <NoTradesAlert data={alertQ.data} />





        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => mPing.mutate()} disabled={mPing.isPending || !s?.hasToken}>
            <Radio className="h-4 w-4 mr-1" /> Ping broker
          </Button>
          <Button size="sm" variant="outline" onClick={() => mSync.mutate()} disabled={mSync.isPending || !s?.hasToken}>
            <RefreshCw className="h-4 w-4 mr-1" /> Sync balance
          </Button>
          <Button size="sm" variant="outline" onClick={() => mRecon.mutate()} disabled={mRecon.isPending || !isLive}>
            Reconcile now
          </Button>
          <Button size="sm" variant="outline" onClick={() => mReconOrders.mutate()} disabled={mReconOrders.isPending || !isLive}>
            {mReconOrders.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
            Reconcile orders
          </Button>
          {isLive && (
            <Button size="sm" variant="outline" onClick={() => mPause.mutate({ paused: !paused, reason: promptReason(paused ? "Resume" : "Pause") })} disabled={mPause.isPending}>
              {paused ? <><PlayCircle className="h-4 w-4 mr-1" /> Resume</> : <><PauseCircle className="h-4 w-4 mr-1" /> Pause</>}
            </Button>
          )}
        </div>

        {!isLive ? (
          <div className="space-y-3 rounded-md border border-border p-3">
            <div className="text-sm font-medium">Activate live trading</div>
            <div className="flex gap-2">
              <Button
                size="sm" variant={targetEnv === "sim" ? "default" : "outline"}
                onClick={() => setTargetEnv("sim")}
              >
                Live SIM (paper on broker)
              </Button>
              <Button
                size="sm" variant={targetEnv === "prod" ? "destructive" : "outline"}
                onClick={() => setTargetEnv("prod")}
              >
                Live PRODUCTION (real money)
              </Button>
            </div>
            {targetEnv === "prod" && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Real money mode</AlertTitle>
                <AlertDescription>
                  The AI will place real orders on your Saxo account. Starting cash will be read from
                  broker balance. Cash-only, no leverage, guardrails enforced. Run Live SIM first.
                </AlertDescription>
              </Alert>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={ackRisk} onChange={(e) => setAckRisk(e.target.checked)} />
              I understand the risks and want to activate {targetEnv === "prod" ? "PRODUCTION" : "SIM"}.
            </label>
            <Button
              size="sm"
              variant={targetEnv === "prod" ? "destructive" : "default"}
              disabled={!ackRisk || mAct.isPending || !s?.hasToken}
              onClick={() => mAct.mutate()}
            >
              <Power className="h-4 w-4 mr-1" /> Activate {targetEnv.toUpperCase()}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
            <span className="text-sm">
              Account: <span className="font-mono">{s?.portfolio.broker_account_id ?? "(unknown)"}</span>
              {s?.portfolio.live_activated_at && (
                <> · since {new Date(s.portfolio.live_activated_at).toLocaleString("en-GB", { timeZone: "Europe/London" })}</>
              )}
            </span>
            <Button size="sm" variant="destructive" onClick={() => mDeact.mutate(promptReason("Revert to paper"))} disabled={mDeact.isPending}>
              Revert to paper
            </Button>
          </div>
        )}

        {s && (s.orders.length > 0 || s.fills.length > 0 || s.reconciliation.length > 0) && (
          <>
            <OrderOutcomeSummary orders={s.orders} />
            <div className="grid gap-3 md:grid-cols-3 text-xs">
              <OrderTimelineList orders={s.orders} fills={s.fills} />
              <MiniList title={`Fills (${s.fills.length})`} rows={s.fills.map((f) => ({
                key: f.id,
                text: `${new Date(f.filled_at).toLocaleString("en-GB", { timeZone: "Europe/London" })} · ${f.side} ${f.quantity} @ ${Number(f.fill_price).toFixed(2)}`,
              }))} />
              <MiniList title="Reconciliation" rows={s.reconciliation.map((r) => ({
                key: r.id,
                text: `${new Date(r.as_of).toLocaleString("en-GB", { timeZone: "Europe/London" })} · ${r.drift_flag ? "DRIFT" : "OK"}${r.drift_notes ? ` · ${r.drift_notes}` : ""}`,
              }))} />
            </div>
          </>
        )}

        <div className="pt-2 border-t border-border">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowAudit((v) => !v)}
            className="text-xs"
          >
            <History className="h-3 w-3 mr-1" />
            {showAudit ? "Hide" : "Show"} audit log
          </Button>
          {showAudit && (
            <div className="mt-2 text-xs">
              {auditQ.isLoading ? (
                <div className="text-muted-foreground italic">Loading…</div>
              ) : (auditQ.data?.entries.length ?? 0) === 0 ? (
                <div className="text-muted-foreground italic">No control actions yet.</div>
              ) : (
                <ul className="space-y-1 max-h-56 overflow-auto font-mono">
                  {auditQ.data!.entries.map((e) => {
                    const req = (e.request ?? {}) as { reason?: string | null };
                    const resp = (e.response ?? {}) as { updated?: number; already_paused?: number; noop?: boolean; changed?: boolean };
                    const summary =
                      e.method === "KILL_SWITCH"
                        ? `paused ${resp.updated ?? 0} · ${resp.already_paused ?? 0} already`
                        : e.method === "RESUME_ALL"
                          ? `resumed ${(resp as { resumed?: number }).resumed ?? 0}`
                          : resp.noop
                            ? "noop"
                            : "ok";
                    return (
                      <li key={e.id} className="flex flex-wrap gap-x-2">
                        <span className="text-muted-foreground">{new Date(e.created_at).toLocaleString("en-GB", { timeZone: "Europe/London" })}</span>
                        <Badge variant={e.method === "KILL_SWITCH" ? "destructive" : "outline"} className="text-[10px] px-1">
                          {e.method}
                        </Badge>
                        <span>{summary}</span>
                        {req.reason && <span className="text-muted-foreground italic">— {req.reason}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

type CashSyncLog = {
  created_at: string;
  status: number | null;
  request: unknown;
  response: unknown;
  error: string | null;
} | null;

function CashSyncIndicator({ lastSync, pending }: { lastSync: CashSyncLog; pending: boolean }) {
  if (pending) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Syncing cash from broker…</span>
      </div>
    );
  }
  if (!lastSync) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <Radio className="h-3.5 w-3.5" />
        <span>No cash sync yet — activate live or hit “Sync balance”.</span>
      </div>
    );
  }
  const ok = (lastSync.status ?? 500) < 300 && !lastSync.error;
  const resp = (lastSync.response ?? {}) as { delta?: number; brokerCash?: number; currency?: string; newCash?: number };
  const when = new Date(lastSync.created_at);
  const secs = Math.max(0, Math.floor((Date.now() - when.getTime()) / 1000));
  const rel = secs < 60 ? `${secs}s ago` : secs < 3600 ? `${Math.floor(secs / 60)}m ago` : `${Math.floor(secs / 3600)}h ago`;
  const delta = typeof resp.delta === "number" ? resp.delta : null;
  const cur = resp.currency ?? "";
  const cls = ok
    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    : "border-destructive/40 bg-destructive/10 text-destructive";
  const Icon = ok ? CheckCircle2 : XCircle;
  return (
    <div className={`flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs ${cls}`}>
      <Icon className="h-3.5 w-3.5" />
      <span className="font-medium">
        {ok ? "Cash synced" : "Cash sync failed"}
      </span>
      <span className="opacity-80">· {rel} ({when.toLocaleTimeString("en-GB", { timeZone: "Europe/London" })})</span>
      {ok && delta !== null && (
        <span className="font-mono">
          · Δ {delta >= 0 ? "+" : ""}{delta.toFixed(2)} {cur}
        </span>
      )}
      {ok && typeof resp.newCash === "number" && (
        <span className="font-mono opacity-80">· cash {resp.newCash.toFixed(2)} {cur}</span>
      )}
      {!ok && lastSync.error && (
        <span className="opacity-80 truncate max-w-[240px]">· {lastSync.error}</span>
      )}
    </div>
  );
}

type TradeAlertData = {
  active: boolean;
  category?: string;
  title?: string;
  detail?: string;
  hint?: string[];
  runsSeen?: number;
  ordersInWindow?: number;
  intendedOrdersLastRun?: number;
  windowStart?: string;
} | undefined;

function NoTradesAlert({ data }: { data: TradeAlertData }) {
  if (!data || !data.active) return null;
  const started = data.windowStart ? new Date(data.windowStart) : null;
  return (
    <Alert variant={data.category === "orders_rejected" || data.category === "orders_never_reached_broker" ? "destructive" : "default"}>
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>{data.title ?? "No successful trades in the last run window"}</AlertTitle>
      <AlertDescription className="space-y-1">
        <div>{data.detail}</div>
        <div className="text-xs text-muted-foreground">
          Window: last {data.runsSeen ?? 0} run{(data.runsSeen ?? 0) === 1 ? "" : "s"}
          {started && <> · since {started.toLocaleString("en-GB", { timeZone: "Europe/London" })}</>}
          {typeof data.intendedOrdersLastRun === "number" && (
            <> · AI proposed {data.intendedOrdersLastRun} order{data.intendedOrdersLastRun === 1 ? "" : "s"} last run</>
          )}
          {typeof data.ordersInWindow === "number" && (
            <> · {data.ordersInWindow} broker order{data.ordersInWindow === 1 ? "" : "s"} in window</>
          )}
        </div>
        {(data.hint ?? []).map((h, i) => (
          <div key={i} className="text-xs text-muted-foreground">{h}</div>
        ))}
      </AlertDescription>
    </Alert>
  );
}

function OrderOutcomeSummary({ orders }: { orders: OrderRow[] }) {
  const buckets = { filled: 0, partial: 0, working: 0, rejected: 0, errored: 0, cancelled: 0, skipped: 0, pending: 0 };
  for (const o of orders) {
    const key = classifyOutcome(o).key;
    if (key === "accepted") buckets.working++;
    else if (key === "filled") buckets.filled++;
    else if (key === "partial") buckets.partial++;
    else if (key === "rejected") buckets.rejected++;
    else if (key === "errored") buckets.errored++;
    else if (key === "cancelled") buckets.cancelled++;
    else if (key === "skipped") buckets.skipped++;
    else buckets.pending++;
  }
  const tile = (label: string, count: number, cls: string) => (
    <div className={`rounded-md border px-2 py-1.5 text-center ${cls}`}>
      <div className="text-base font-semibold leading-tight">{count}</div>
      <div className="text-[10px] uppercase tracking-wide opacity-80">{label}</div>
    </div>
  );
  return (
    <div className="grid grid-cols-4 gap-1.5 text-xs sm:grid-cols-8">
      {tile("Filled", buckets.filled, "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400")}
      {tile("Partial", buckets.partial, "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400")}
      {tile("Working", buckets.working, "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400")}
      {tile("Rejected", buckets.rejected, "border-destructive/40 bg-destructive/10 text-destructive")}
      {tile("Errored", buckets.errored, "border-destructive/30 bg-destructive/5 text-destructive")}
      {tile("Cancelled", buckets.cancelled, "border-muted-foreground/30 bg-muted/30 text-muted-foreground")}
      {tile("Skipped", buckets.skipped, "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400")}
      {tile("Pending", buckets.pending, "border-border bg-muted/20 text-muted-foreground")}
    </div>
  );
}

function MiniList({ title, rows }: { title: string; rows: Array<{ key: string; text: string }> }) {
  return (
    <div>
      <div className="text-muted-foreground mb-1">{title}</div>
      <ul className="space-y-1 max-h-40 overflow-auto">
        {rows.length === 0 ? (
          <li className="text-muted-foreground italic">none</li>
        ) : rows.map((r) => <li key={r.key} className="font-mono">{r.text}</li>)}
      </ul>
    </div>
  );
}

// ── Order timeline ──────────────────────────────────────────────────────────
// Each broker order gets an expandable per-stage timeline so it's obvious
// where in the lifecycle a trade stalled or failed and why. All data is
// already loaded via getLiveStatus (orders + fills).

type OrderRow = {
  id: string;
  symbol: string;
  side: string;
  quantity: number | string;
  status: string;
  reject_reason: string | null;
  broker_order_id: string | null;
  created_at: string;
  submitted_at: string | null;
  updated_at?: string;
};

type FillRow = {
  id: string;
  order_id: string;
  side: string;
  quantity: number | string;
  fill_price: number | string;
  filled_at: string;
};

type OutcomeKey = "accepted" | "filled" | "partial" | "rejected" | "errored" | "cancelled" | "skipped" | "pending";

function classifyOutcome(o: OrderRow): { key: OutcomeKey; label: string; cls: string; Icon: typeof CheckCircle2 } {
  const staleMs = Date.now() - new Date(o.updated_at ?? o.created_at).getTime();
  switch (o.status) {
    case "filled":
      return { key: "filled", label: "Filled", cls: "border-emerald-500/50 bg-emerald-500/10 text-emerald-500", Icon: CheckCircle2 };
    case "partial":
      return { key: "partial", label: "Partially filled", cls: "border-emerald-500/50 bg-emerald-500/10 text-emerald-500", Icon: CheckCircle2 };
    case "submitted":
      return { key: "accepted", label: "Accepted · working", cls: "border-sky-500/50 bg-sky-500/10 text-sky-500", Icon: Send };
    case "rejected":
      return { key: "rejected", label: "Rejected by Saxo", cls: "border-destructive/50 bg-destructive/10 text-destructive", Icon: Ban };
    case "error":
      return { key: "errored", label: "Errored", cls: "border-destructive/50 bg-destructive/10 text-destructive", Icon: XCircle };
    case "cancelled":
      return { key: "cancelled", label: "Cancelled", cls: "border-muted-foreground/40 bg-muted/40 text-muted-foreground", Icon: Ban };
    case "pending":
      if (staleMs > 15 * 60_000) {
        return { key: "skipped", label: "Skipped · never reached broker", cls: "border-amber-500/50 bg-amber-500/10 text-amber-500", Icon: SkipForward };
      }
      return { key: "pending", label: "Pending", cls: "border-muted-foreground/40 bg-muted/40 text-muted-foreground", Icon: Clock };
    default:
      return { key: "pending", label: o.status, cls: "border-muted-foreground/40 bg-muted/40 text-muted-foreground", Icon: Clock };
  }
}

function TimelineStep({
  Icon,
  title,
  at,
  detail,
  tone,
  reached,
}: {
  Icon: typeof CheckCircle2;
  title: string;
  at?: string | null;
  detail?: string;
  tone: "done" | "pending" | "error" | "warn" | "muted";
  reached: boolean;
}) {
  const toneMap = {
    done: "bg-emerald-500/15 text-emerald-500 border-emerald-500/40",
    pending: "bg-sky-500/15 text-sky-500 border-sky-500/40",
    error: "bg-destructive/15 text-destructive border-destructive/40",
    warn: "bg-amber-500/15 text-amber-500 border-amber-500/40",
    muted: "bg-muted/40 text-muted-foreground border-border",
  } as const;
  return (
    <li className="flex items-start gap-2">
      <span
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${toneMap[tone]} ${
          reached ? "" : "opacity-40"
        }`}
      >
        <Icon className="h-3 w-3" />
      </span>
      <div className="min-w-0 flex-1">
        <div className={`text-[11px] font-medium ${reached ? "text-foreground" : "text-muted-foreground"}`}>
          {title}
        </div>
        {at && <div className="font-mono text-[10px] text-muted-foreground">{new Date(at).toLocaleString("en-GB", { timeZone: "Europe/London" })}</div>}
        {detail && <div className="mt-0.5 break-words text-[11px] text-muted-foreground">{detail}</div>}
      </div>
    </li>
  );
}

function OrderTimeline({ order, fills }: { order: OrderRow; fills: FillRow[] }) {
  const outcome = classifyOutcome(order);
  const orderFills = fills.filter((f) => f.order_id === order.id);
  const reachedBroker = !!order.submitted_at && order.status !== "pending" || order.status === "submitted" || order.status === "filled" || order.status === "partial" || order.status === "rejected";
  const errored = order.status === "error";
  const skipped = outcome.key === "skipped";

  const outcomeStep = (() => {
    switch (outcome.key) {
      case "filled":
      case "partial":
        return { Icon: CheckCircle2, tone: "done" as const, title: outcome.label, at: orderFills[0]?.filled_at ?? order.updated_at ?? null };
      case "accepted":
        return { Icon: Send, tone: "pending" as const, title: "Accepted — awaiting fill", at: order.updated_at ?? order.submitted_at };
      case "rejected":
        return { Icon: Ban, tone: "error" as const, title: "Rejected by Saxo", at: order.updated_at ?? null };
      case "errored":
        return { Icon: XCircle, tone: "error" as const, title: "Errored during placement", at: order.updated_at ?? null };
      case "cancelled":
        return { Icon: Ban, tone: "muted" as const, title: "Cancelled", at: order.updated_at ?? null };
      case "skipped":
        return { Icon: SkipForward, tone: "warn" as const, title: "Skipped — never routed", at: order.updated_at ?? null };
      default:
        return { Icon: Clock, tone: "muted" as const, title: "Pending", at: null as string | null };
    }
  })();

  return (
    <div className="mt-2 rounded-md border border-border/60 bg-background/60 p-2">
      <ol className="space-y-2">
        <TimelineStep Icon={Zap} title="Order created" at={order.created_at} tone="done" reached />
        <TimelineStep
          Icon={Send}
          title="Submitted to Saxo"
          at={order.submitted_at ?? undefined}
          detail={skipped ? "Never sent — routing was skipped before it reached the broker." : undefined}
          tone={skipped ? "warn" : reachedBroker || errored ? "done" : "muted"}
          reached={!!order.submitted_at || reachedBroker || errored}
        />
        <TimelineStep
          Icon={outcomeStep.Icon}
          title={outcomeStep.title}
          at={outcomeStep.at ?? undefined}
          detail={order.reject_reason ?? undefined}
          tone={outcomeStep.tone}
          reached={outcome.key !== "pending"}
        />
        {orderFills.length > 0 && (
          <li className="ml-7 space-y-1 border-l border-border/60 pl-3">
            {orderFills.map((f) => (
              <div key={f.id} className="font-mono text-[10px] text-muted-foreground">
                {new Date(f.filled_at).toLocaleString("en-GB", { timeZone: "Europe/London" })} · {f.side} {Number(f.quantity)} @ {Number(f.fill_price).toFixed(2)}
              </div>
            ))}
          </li>
        )}
      </ol>
      {order.broker_order_id && (
        <div className="mt-2 font-mono text-[10px] text-muted-foreground">
          Broker ref: {order.broker_order_id}
        </div>
      )}
    </div>
  );
}

function OrderTimelineList({ orders, fills }: { orders: OrderRow[]; fills: FillRow[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div>
      <div className="text-muted-foreground mb-1">Orders ({orders.length})</div>
      <ul className="max-h-72 space-y-1 overflow-auto">
        {orders.length === 0 ? (
          <li className="italic text-muted-foreground">none</li>
        ) : (
          orders.map((o) => {
            const isOpen = open.has(o.id);
            const outcome = classifyOutcome(o);
            return (
              <li key={o.id} className="rounded-md border border-border/60 bg-card/40">
                <button
                  type="button"
                  onClick={() => toggle(o.id)}
                  aria-expanded={isOpen}
                  className="flex w-full items-start gap-2 p-2 text-left hover:bg-muted/30"
                >
                  {isOpen ? (
                    <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[11px]">
                      <span className="text-muted-foreground">{new Date(o.created_at).toLocaleString("en-GB", { timeZone: "Europe/London" })}</span>
                      {" · "}
                      <span className="uppercase">{o.side}</span>{" "}
                      {Number(o.quantity)} {o.symbol}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <span
                        className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium ${outcome.cls}`}
                      >
                        <outcome.Icon className="h-3 w-3" />
                        {outcome.label}
                      </span>
                      {o.reject_reason && !isOpen && (
                        <span className="truncate text-[10px] text-destructive/80" title={o.reject_reason}>
                          — {o.reject_reason}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
                {isOpen && (
                  <div className="px-2 pb-2">
                    <OrderTimeline order={o} fills={fills} />
                  </div>
                )}
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

function StatusPill({
  state,
  label,
  detail,
}: {
  state: "connected" | "disconnected" | "warning" | "error" | "loading";
  label: string;
  detail?: string;
}) {
  const map = {
    connected: { icon: CheckCircle2, cls: "border-emerald-500/50 bg-emerald-500/10 text-emerald-500" },
    disconnected: { icon: XCircle, cls: "border-muted-foreground/40 bg-muted/40 text-muted-foreground" },
    warning: { icon: AlertTriangle, cls: "border-amber-500/50 bg-amber-500/10 text-amber-500" },
    error: { icon: XCircle, cls: "border-destructive/50 bg-destructive/10 text-destructive" },
    loading: { icon: Loader2, cls: "border-border bg-muted/30 text-muted-foreground" },
  } as const;
  const { icon: Icon, cls } = map[state];
  return (
    <div className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${cls}`}>
      <Icon className={`h-4 w-4 ${state === "loading" ? "animate-spin" : ""}`} />
      <span className="font-medium">{label}</span>
      {detail && <span className="text-xs opacity-80">· {detail}</span>}
    </div>
  );
}

export function SaxoOAuthPanel() {
  const startFn = useServerFn(startSaxoOAuth);
  const statusFn = useServerFn(getSaxoOAuthStatus);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["saxo-oauth-status"], queryFn: () => statusFn({}), refetchInterval: 30_000 });
  const mStart = useMutation({
    mutationFn: (env: "sim" | "live") => startFn({ data: { env } }),
    onSuccess: (r) => { window.open(r.url, "_blank", "noopener"); toast.info("Complete the Saxo login in the new tab, then click Refresh."); },
    onError: (e: Error) => toast.error(e.message),
  });

  const pillFor = (env: "sim" | "live") => {
    if (q.isLoading) return <StatusPill state="loading" label={`${env.toUpperCase()}: checking…`} />;
    if (q.error) return <StatusPill state="error" label={`${env.toUpperCase()}: error`} detail={(q.error as Error).message} />;
    const st = env === "sim" ? q.data?.sim : q.data?.live;
    const secs = st?.secondsUntilExpiry ?? 0;
    const mins = st?.secondsUntilExpiry != null ? Math.max(0, Math.round(secs / 60)) : null;
    const refreshMins = st?.secondsUntilRefreshExpiry != null ? Math.max(0, Math.round(st.secondsUntilRefreshExpiry / 60)) : null;
    if (!st?.connected && !st?.usingLegacyToken) return <StatusPill state="disconnected" label={`${env.toUpperCase()}: not connected`} detail="click Connect below" />;
    if (st.usingLegacyToken) return <StatusPill state="warning" label={`${env.toUpperCase()}: legacy 24h token`} detail="reconnect for auto-refresh" />;
    // Refresh token gone → true reconnect required.
    if (!st.refreshTokenValid) return <StatusPill state="error" label={`${env.toUpperCase()}: refresh token expired`} detail="reconnect required" />;
    // Access token elapsed but refresh token still valid → the next call (or
    // the 15-min cron) will roll it forward on demand.
    if (secs <= 0) return <StatusPill state="warning" label={`${env.toUpperCase()}: auto-renewing`} detail={refreshMins != null ? `refresh valid ${refreshMins}m` : "refresh valid"} />;
    if (secs < 15 * 60) return <StatusPill state="warning" label={`${env.toUpperCase()}: connected`} detail={`expires in ${mins}m — auto-refresh pending`} />;
    return <StatusPill state="connected" label={`${env.toUpperCase()}: connected`} detail={`auto-refresh · expires in ${mins}m`} />;
  };

  const row = (label: "SIM" | "LIVE", env: "sim" | "live") => {
    const st = env === "sim" ? q.data?.sim : q.data?.live;
    const ok = !!st?.connected && !st?.usingLegacyToken;
    return (
      <div className="flex flex-col gap-2 py-1 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">{pillFor(env)}</div>
        <Button size="sm" className="w-full sm:w-auto" variant={ok ? "outline" : "default"} onClick={() => mStart.mutate(env)} disabled={mStart.isPending}>
          {ok ? "Reconnect" : `Connect (${label})`}
        </Button>
      </div>
    );
  };

  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">Saxo broker connection</div>
        <Button size="sm" variant="ghost" onClick={() => qc.invalidateQueries({ queryKey: ["saxo-oauth-status"] })} disabled={q.isFetching}>
          <RefreshCw className={`h-3 w-3 mr-1 ${q.isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      {row("SIM", "sim")}
      {row("LIVE", "live")}

      {q.data?.sim.usingLegacyToken && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Currently using the 24-hour developer token. Click <b>Connect (SIM)</b> above to switch to OAuth with auto-refresh.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
