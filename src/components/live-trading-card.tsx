// Live trading control card. Renders on the portfolio detail page.
// - Shows current mode (paper / live_sim / live_prod), broker status, kill-switch
// - Ping broker, sync balance/positions, activate/deactivate, pause/resume
// - Displays recent broker orders, fills, and reconciliation drift

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  activateLive, deactivateLive, pauseLive, killAllLive, resumeAllLive, getAuditLog,
  pingBroker, syncBrokerBalance, getLiveStatus, reconcilePortfolio,
  startSaxoOAuth, getSaxoOAuthStatus,
} from "@/lib/live.functions";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Radio, RefreshCw, ShieldOff, Power, PauseCircle, PlayCircle, History, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Explain } from "@/components/explain";

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

  const [ackRisk, setAckRisk] = useState(false);
  const [targetEnv, setTargetEnv] = useState<"sim" | "prod">("sim");
  const [showAudit, setShowAudit] = useState(false);

  const q = useQuery({
    queryKey: ["live-status", portfolioId],
    queryFn: () => status({ data: { portfolioId } }),
  });

  const auditQ = useQuery({
    queryKey: ["live-audit", portfolioId],
    queryFn: () => audit({ data: { portfolioId, limit: 20 } }),
    enabled: showAudit,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["live-status", portfolioId] });
    qc.invalidateQueries({ queryKey: ["live-audit", portfolioId] });
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
    onSuccess: (r) => { toast.success(r.changed ? "Reverted to paper mode" : "Already in paper mode"); refresh(); },
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
    onSuccess: (r) => toast.success(`Balance ${r.balance.cash.toFixed(2)} ${r.balance.currency}, ${r.positions.length} positions`),
    onError: (e: Error) => toast.error(e.message),
  });
  const mRecon = useMutation({
    mutationFn: () => reconcile({ data: { portfolioId } }),
    onSuccess: (r) => { toast[r.drift ? "warning" : "success"](r.drift ? "Drift detected — see log" : "In sync with broker"); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const s = q.data;
  const mode = s?.portfolio.mode ?? "paper";
  const isLive = mode === "live_sim" || mode === "live_prod";
  const paused = !!s?.portfolio.live_paused;

  return (
    <Card>
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
                <> · since {new Date(s.portfolio.live_activated_at).toLocaleString()}</>
              )}
            </span>
            <Button size="sm" variant="destructive" onClick={() => mDeact.mutate(promptReason("Revert to paper"))} disabled={mDeact.isPending}>
              Revert to paper
            </Button>
          </div>
        )}

        {s && (s.orders.length > 0 || s.fills.length > 0 || s.reconciliation.length > 0) && (
          <div className="grid gap-3 md:grid-cols-3 text-xs">
            <MiniList title={`Orders (${s.orders.length})`} rows={s.orders.map((o) => ({
              key: o.id,
              text: `${new Date(o.created_at).toLocaleString()} · ${o.side} ${o.quantity} ${o.symbol} · ${o.status}`,
            }))} />
            <MiniList title={`Fills (${s.fills.length})`} rows={s.fills.map((f) => ({
              key: f.id,
              text: `${new Date(f.filled_at).toLocaleString()} · ${f.side} ${f.quantity} @ ${Number(f.fill_price).toFixed(2)}`,
            }))} />
            <MiniList title="Reconciliation" rows={s.reconciliation.map((r) => ({
              key: r.id,
              text: `${new Date(r.as_of).toLocaleString()} · ${r.drift_flag ? "DRIFT" : "OK"}${r.drift_notes ? ` · ${r.drift_notes}` : ""}`,
            }))} />
          </div>
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
                        <span className="text-muted-foreground">{new Date(e.created_at).toLocaleString()}</span>
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
    const mins = st?.secondsUntilExpiry != null ? Math.max(0, Math.round(st.secondsUntilExpiry / 60)) : null;
    if (!st?.connected && !st?.usingLegacyToken) return <StatusPill state="disconnected" label={`${env.toUpperCase()}: not connected`} detail="click Connect below" />;
    if (st.usingLegacyToken) return <StatusPill state="warning" label={`${env.toUpperCase()}: legacy 24h token`} detail="reconnect for auto-refresh" />;
    if ((st.secondsUntilExpiry ?? 0) <= 0) return <StatusPill state="error" label={`${env.toUpperCase()}: token expired`} detail="reconnect required" />;
    if ((st.secondsUntilExpiry ?? 0) < 15 * 60) return <StatusPill state="warning" label={`${env.toUpperCase()}: connected`} detail={`expires in ${mins}m — auto-refresh pending`} />;
    return <StatusPill state="connected" label={`${env.toUpperCase()}: connected`} detail={`auto-refresh · expires in ${mins}m`} />;
  };

  const row = (label: string, env: "sim" | "live") => {
    const st = env === "sim" ? q.data?.sim : q.data?.live;
    const ok = !!st?.connected && !st?.usingLegacyToken;
    return (
      <div className="flex items-center justify-between gap-2 py-1">
        {pillFor(env)}
        <Button size="sm" variant={ok ? "outline" : "default"} onClick={() => mStart.mutate(env)} disabled={mStart.isPending}>
          {ok ? "Reconnect" : `Connect (${label})`}
        </Button>
      </div>
    );
  };

  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Saxo broker connection</div>
        <Button size="sm" variant="ghost" onClick={() => qc.invalidateQueries({ queryKey: ["saxo-oauth-status"] })} disabled={q.isFetching}>
          <RefreshCw className={`h-3 w-3 mr-1 ${q.isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      {row(<Explain term="sim_vs_live">SIM</Explain>, "sim")}
      {row(<Explain term="sim_vs_live">LIVE</Explain>, "live")}
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
