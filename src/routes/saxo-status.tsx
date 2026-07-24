import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getSaxoOAuthStatus, startSaxoOAuth } from "@/lib/live.functions";
import { AppHeader } from "@/components/app-header";
import { PageLoading } from "@/components/page-loading";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";

export const Route = createFileRoute("/saxo-status")({
  head: () => ({
    meta: [
      { title: "Saxo Connection Status — Aegis" },
      { name: "description", content: "Verify Saxo SIM and LIVE OAuth configuration, token lifetimes, and last successful authentication." },
      { property: "og:title", content: "Saxo Connection Status — Aegis" },
      { property: "og:description", content: "SIM and LIVE broker connection diagnostics for Aegis." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SaxoStatusPage,
});

type EnvKey = "sim" | "live";

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { timeZone: "Europe/London" });
}

function fmtDuration(secs: number | null): string {
  if (secs == null) return "—";
  if (secs <= 0) return "expired";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function StatusPill({
  tone,
  label,
}: {
  tone: "ok" | "warn" | "err" | "muted";
  label: string;
}) {
  const cls =
    tone === "ok"
      ? "bg-emerald-500/15 text-emerald-500 border-emerald-500/30"
      : tone === "warn"
        ? "bg-amber-500/15 text-amber-500 border-amber-500/30"
        : tone === "err"
          ? "bg-red-500/15 text-red-500 border-red-500/30"
          : "bg-muted text-muted-foreground border-border";
  return (
    <Badge variant="outline" className={cls}>
      {label}
    </Badge>
  );
}

function overallTone(s: {
  appConfigured: boolean;
  connected: boolean;
  secondsUntilExpiry: number | null;
  refreshTokenValid?: boolean;
}): { tone: "ok" | "warn" | "err" | "muted"; label: string } {
  if (!s.appConfigured) return { tone: "err", label: "App credentials missing" };
  if (!s.connected) return { tone: "muted", label: "Not connected" };
  const s2 = s.secondsUntilExpiry ?? 0;
  // With refresh token still valid, an elapsed access token is auto-renewing
  // (on-demand via getAccessToken, and every 15 min via the cron).
  if (s2 <= 0 && s.refreshTokenValid === false) return { tone: "err", label: "Refresh token expired — reconnect" };
  if (s2 <= 0) return { tone: "warn", label: "Auto-renewing" };
  if (s2 < 3600) return { tone: "warn", label: "Token expiring soon" };
  return { tone: "ok", label: "Connected" };
}

function EnvCard({
  env,
  status,
  onConnect,
  connecting,
}: {
  env: EnvKey;
  status: Awaited<ReturnType<typeof getSaxoOAuthStatus>>["sim"];
  onConnect: () => void;
  connecting: boolean;
}) {
  const t = overallTone(status);
  const label = env.toUpperCase();

  const rows: Array<{ k: string; v: React.ReactNode; hint?: string }> = [
    {
      k: "App credentials",
      v: status.appConfigured ? (
        <span className="inline-flex items-center gap-1.5 text-emerald-500">
          <CheckCircle2 className="h-4 w-4" /> Configured
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-red-500">
          <XCircle className="h-4 w-4" /> Missing
        </span>
      ),
      hint:
        env === "live"
          ? "SAXO_APP_KEY_LIVE / SAXO_APP_SECRET_LIVE"
          : "SAXO_APP_KEY_SIM / SAXO_APP_SECRET_SIM (or SAXO_APP_KEY / SAXO_APP_SECRET)",
    },
    {
      k: "OAuth connection",
      v: status.connected ? (
        <span className="inline-flex items-center gap-1.5 text-emerald-500">
          <CheckCircle2 className="h-4 w-4" /> Connected
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <XCircle className="h-4 w-4" /> Not connected
        </span>
      ),
      hint: status.usingLegacyToken ? "Using legacy SAXO_ACCESS_TOKEN env var" : undefined,
    },
    {
      k: "Last successful auth",
      v: <span className="font-mono text-xs">{fmtDateTime(status.lastAuthAt)}</span>,
    },
    {
      k: "Access token expires",
      v: (
        <span className="font-mono text-xs">
          {fmtDateTime(status.expiresAt)}
          {status.secondsUntilExpiry != null && (
            <span className="ml-2 text-muted-foreground">
              (in {fmtDuration(status.secondsUntilExpiry)})
            </span>
          )}
        </span>
      ),
    },
    {
      k: "Refresh token expires",
      v: <span className="font-mono text-xs">{fmtDateTime(status.refreshExpiresAt)}</span>,
      hint: "Re-authorize before this lapses (Saxo ~30 days rolling).",
    },
    {
      k: "Redirect URI",
      v: <span className="break-all font-mono text-xs">{status.redirectUri}</span>,
      hint: "Must match the Redirect URL registered in the Saxo Developer Portal.",
    },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="text-lg">Saxo {label}</CardTitle>
          <div className="mt-1 text-xs text-muted-foreground">
            {env === "live"
              ? "Production account — real orders will be routed here."
              : "Sandbox environment — safe for paper testing."}
          </div>
        </div>
        <StatusPill tone={t.tone} label={t.label} />
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="divide-y divide-border rounded-md border border-border">
          {rows.map((r) => (
            <div key={r.k} className="grid grid-cols-1 gap-1 px-3 py-2 sm:grid-cols-3">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">{r.k}</dt>
              <dd className="sm:col-span-2">
                <div>{r.v}</div>
                {r.hint && (
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{r.hint}</div>
                )}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={onConnect}
            disabled={!status.appConfigured || connecting}
          >
            <ExternalLink className="mr-1.5 h-4 w-4" />
            {status.connected ? `Reconnect ${label}` : `Connect ${label}`}
          </Button>
          {!status.appConfigured && (
            <span className="inline-flex items-center gap-1 text-xs text-amber-500">
              <AlertTriangle className="h-3.5 w-3.5" /> Save app credentials first.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function SaxoStatusPage() {
  const navigate = useNavigate();
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"]>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
      if (!data.session) navigate({ to: "/auth" });
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (!s) navigate({ to: "/auth" });
    });
    return () => data.subscription.unsubscribe();
  }, [navigate]);

  const fetchStatus = useServerFn(getSaxoOAuthStatus);
  const startOAuth = useServerFn(startSaxoOAuth);

  const q = useQuery({
    queryKey: ["saxo-status"],
    queryFn: () => fetchStatus(),
    refetchInterval: 30_000,
    enabled: !!session,
  });

  const onConnect = async (env: EnvKey) => {
    try {
      const { url } = await startOAuth({ data: { env } });
      window.location.href = url;
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  if (!ready || !session) {
    return (
      <PageLoading />
    );
  }

  return (
    <div className="min-h-dvh bg-background">
      <AppHeader email={session.user.email} />
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Saxo Connection Status</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Verify SIM and LIVE credentials, OAuth tokens, and last successful authentication.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
              <RefreshCw className={`mr-1.5 h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Link
              to="/admin"
              className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              ← Back to Admin
            </Link>
          </div>
        </div>

        {q.isLoading && (
          <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
            Loading Saxo status…
          </div>
        )}

        {q.error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-500">
            Failed to load status: {q.error instanceof Error ? q.error.message : String(q.error)}
          </div>
        )}

        {q.data && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <EnvCard env="sim" status={q.data.sim} onConnect={() => onConnect("sim")} connecting={false} />
            <EnvCard env="live" status={q.data.live} onConnect={() => onConnect("live")} connecting={false} />
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Troubleshooting</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Invalid client_id:</span> SIM and LIVE
              use separate app keys. Register a LIVE app in the Saxo Developer Portal and save
              <span className="mx-1 font-mono text-xs">SAXO_APP_KEY_LIVE</span> /
              <span className="mx-1 font-mono text-xs">SAXO_APP_SECRET_LIVE</span>.
            </p>
            <p>
              <span className="font-medium text-foreground">Error 400 at login:</span> the
              Redirect URL registered with Saxo must exactly match the URI shown above.
            </p>
            <p>
              <span className="font-medium text-foreground">Token expired:</span> auto-refresh
              triggers within 5 min of expiry. If the refresh token has lapsed, reconnect.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
