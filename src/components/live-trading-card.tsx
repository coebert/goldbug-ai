// Live trading control card. Renders on the portfolio detail page.
// - Shows current mode (paper / live_sim / live_prod), broker status, kill-switch
// - Ping broker, sync balance/positions, activate/deactivate, pause/resume
// - Displays recent broker orders, fills, and reconciliation drift

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  activateLive, deactivateLive, pauseLive, killAllLive,
  pingBroker, syncBrokerBalance, getLiveStatus, reconcilePortfolio,
} from "@/lib/live.functions";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, Radio, RefreshCw, ShieldOff, Power, PauseCircle, PlayCircle } from "lucide-react";
import { toast } from "sonner";

export function LiveTradingCard({ portfolioId }: { portfolioId: string }) {
  const qc = useQueryClient();
  const status = useServerFn(getLiveStatus);
  const activate = useServerFn(activateLive);
  const deactivate = useServerFn(deactivateLive);
  const pause = useServerFn(pauseLive);
  const killAll = useServerFn(killAllLive);
  const ping = useServerFn(pingBroker);
  const syncBal = useServerFn(syncBrokerBalance);
  const reconcile = useServerFn(reconcilePortfolio);

  const [ackRisk, setAckRisk] = useState(false);
  const [targetEnv, setTargetEnv] = useState<"sim" | "prod">("sim");

  const q = useQuery({
    queryKey: ["live-status", portfolioId],
    queryFn: () => status({ data: { portfolioId } }),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["live-status", portfolioId] });

  const mAct = useMutation({
    mutationFn: () => activate({ data: { portfolioId, targetEnv, useBrokerBalance: true, acknowledgeRisk: true } }),
    onSuccess: (r) => { toast.success(`Live ${targetEnv === "prod" ? "PRODUCTION" : "SIM"} activated. Starting cash: ${r.startingCash ?? "unchanged"}`); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const mDeact = useMutation({
    mutationFn: () => deactivate({ data: { portfolioId } }),
    onSuccess: () => { toast.success("Reverted to paper mode"); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const mPause = useMutation({
    mutationFn: (paused: boolean) => pause({ data: { portfolioId, paused } }),
    onSuccess: (r) => { toast.success(r.paused ? "Paused live trading" : "Resumed live trading"); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const mKill = useMutation({
    mutationFn: () => killAll({}),
    onSuccess: () => { toast.warning("Kill-switch engaged — all live portfolios paused"); refresh(); },
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
          <Button variant="destructive" size="sm" onClick={() => mKill.mutate()} disabled={mKill.isPending}>
            <ShieldOff className="h-4 w-4 mr-1" /> Kill-switch
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!s?.hasToken && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>SAXO_ACCESS_TOKEN missing</AlertTitle>
            <AlertDescription>
              Add a 24-hour developer token in project secrets (SAXO_ACCESS_TOKEN, plus optional SAXO_ENV=sim|live and SAXO_ACCOUNT_KEY).
            </AlertDescription>
          </Alert>
        )}

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
            <Button size="sm" variant="outline" onClick={() => mPause.mutate(!paused)} disabled={mPause.isPending}>
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
            <Button size="sm" variant="destructive" onClick={() => mDeact.mutate()} disabled={mDeact.isPending}>
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
