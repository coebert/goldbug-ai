import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getAdminHealth, type AdminHealthSnapshot, type BrokerEnvHealth } from "@/lib/admin.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CheckCircle2, Clock, RefreshCw, ShieldAlert, XCircle, Radio } from "lucide-react";
import { SaxoOAuthPanel } from "@/components/live-trading-card";
import { PushNotificationsCard } from "@/components/push-notifications-card";

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
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const q = useQuery({
    queryKey: ["admin-health"],
    queryFn: () => fetchHealth(),
    refetchInterval: 60_000,
  });

  const s = q.data;
  const alerts = s ? computeAlerts(s) : [];
  void tick;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold sm:text-2xl">Admin — Broker & Routing Health</h1>
          <p className="text-sm text-muted-foreground">
            Live SIM/PROD broker status, OAuth token countdown, last routed order, and alerts.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">← Home</Link>
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
            <Radio className="h-4 w-4 text-primary" /> Broker connection — Connect your Saxo account
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SaxoOAuthPanel />
        </CardContent>
      </Card>

      <PushNotificationsCard />



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
