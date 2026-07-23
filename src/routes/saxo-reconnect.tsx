import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { getSaxoOAuthStatus, startSaxoOAuth } from "@/lib/live.functions";
import { AppHeader } from "@/components/app-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Circle, Loader2, ExternalLink, ArrowRight, PartyPopper, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/saxo-reconnect")({
  head: () => ({
    meta: [
      { title: "Reconnect Saxo — Aegis" },
      { name: "description", content: "Guided OAuth reconnect wizard for Saxo SIM and LIVE with per-stage confirmation." },
      { property: "og:title", content: "Reconnect Saxo — Aegis" },
      { property: "og:description", content: "Step-by-step Saxo OAuth reconnect: authorize, callback received, refresh token stored." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SaxoReconnectPage,
});

type EnvKey = "sim" | "live";
type Stage = "authorize" | "callback" | "stored" | "done";

interface EnvSnapshot {
  lastAuthAt: string | null;
  refreshExpiresAt: string | null;
}

function StageRow({
  state,
  title,
  description,
}: {
  state: "pending" | "active" | "done";
  title: string;
  description: string;
}) {
  const Icon = state === "done" ? CheckCircle2 : state === "active" ? Loader2 : Circle;
  const iconCls =
    state === "done"
      ? "text-emerald-500"
      : state === "active"
        ? "text-primary animate-spin"
        : "text-muted-foreground/60";
  return (
    <div className="flex items-start gap-3 rounded-md border border-border/60 bg-background/40 p-3">
      <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${iconCls}`} />
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{title}</span>
          {state === "done" && (
            <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-500">
              Confirmed
            </Badge>
          )}
          {state === "active" && (
            <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
              Waiting…
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function useSession() {
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user.email ?? null);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setEmail(s?.user.email ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);
  return { email, ready };
}

function EnvWizard({
  env,
  status,
  snapshot,
  setSnapshot,
  onComplete,
  active,
}: {
  env: EnvKey;
  status: {
    connected: boolean;
    lastAuthAt: string | null;
    refreshExpiresAt: string | null;
    appConfigured: boolean;
  } | undefined;
  snapshot: EnvSnapshot | null;
  setSnapshot: (s: EnvSnapshot) => void;
  onComplete: () => void;
  active: boolean;
}) {
  const start = useServerFn(startSaxoOAuth);
  const [popupOpened, setPopupOpened] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completedRef = useRef(false);

  // Detect stages from live status vs snapshot.
  const callbackReceived = useMemo(() => {
    if (!snapshot || !status) return false;
    if (snapshot.lastAuthAt !== (status.lastAuthAt ?? null)) return true;
    return false;
  }, [snapshot, status]);

  const tokenStored = useMemo(() => {
    if (!callbackReceived || !status) return false;
    return status.connected && !!status.refreshExpiresAt;
  }, [callbackReceived, status]);

  useEffect(() => {
    if (tokenStored && active && !completedRef.current) {
      completedRef.current = true;
      // Small delay so user sees the green tick before advancing.
      const t = setTimeout(onComplete, 900);
      return () => clearTimeout(t);
    }
  }, [tokenStored, active, onComplete]);

  const stage: Stage = tokenStored ? "done" : callbackReceived ? "stored" : popupOpened ? "callback" : "authorize";

  async function handleStart() {
    setError(null);
    setStarting(true);
    try {
      // Capture snapshot BEFORE opening the popup — the callback bumps updated_at.
      setSnapshot({
        lastAuthAt: status?.lastAuthAt ?? null,
        refreshExpiresAt: status?.refreshExpiresAt ?? null,
      });
      const { url } = await start({ data: { env } });
      const w = window.open(url, `saxo-oauth-${env}`, "width=600,height=760");
      if (!w) {
        setError("Popup blocked. Allow popups for this site and try again, or use the link below to open in a new tab.");
      }
      setPopupOpened(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start OAuth flow");
    } finally {
      setStarting(false);
    }
  }

  const disabled = !active || (status && !status.appConfigured);

  return (
    <Card className={active ? "border-primary/40" : "opacity-70"}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <span className="text-lg font-semibold">
              {env === "sim" ? "Step 1 — SIM (paper)" : "Step 2 — LIVE (real money)"}
            </span>
          </span>
          {status?.connected && !active && (
            <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-500">
              Complete
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {status && !status.appConfigured && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div>
              <p className="font-medium text-amber-500">App credentials not configured for {env.toUpperCase()}</p>
              <p className="text-muted-foreground">
                Save <code className="rounded bg-muted px-1">SAXO_APP_KEY_{env.toUpperCase()}</code> and{" "}
                <code className="rounded bg-muted px-1">SAXO_APP_SECRET_{env.toUpperCase()}</code> before reconnecting.
              </p>
            </div>
          </div>
        )}

        <StageRow
          state={stage === "authorize" ? (active ? "active" : "pending") : "done"}
          title="Authorize with Saxo"
          description={`Open the Saxo ${env.toUpperCase()} sign-in page and approve access.`}
        />
        <StageRow
          state={
            stage === "callback" ? "active" : stage === "stored" || stage === "done" ? "done" : "pending"
          }
          title="Callback received"
          description="Aegis received the authorization code from Saxo."
        />
        <StageRow
          state={stage === "stored" ? "active" : stage === "done" ? "done" : "pending"}
          title="Refresh token stored"
          description="Tokens saved to the database; auto-refresh will keep the session alive."
        />

        {active && stage !== "done" && (
          <div className="flex flex-col gap-2 pt-2">
            <Button onClick={handleStart} disabled={disabled || starting} className="w-full">
              {starting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Opening Saxo…
                </>
              ) : popupOpened ? (
                <>
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Reopen authorize window
                </>
              ) : (
                <>
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Open Saxo {env.toUpperCase()} authorize
                </>
              )}
            </Button>
            {popupOpened && (
              <p className="text-center text-xs text-muted-foreground">
                Complete the Saxo sign-in in the popup. This page auto-detects each stage every 2 seconds.
              </p>
            )}
            {error && (
              <p className="text-center text-xs text-red-500">{error}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SaxoReconnectPage() {
  const { email, ready } = useSession();
  const navigate = useNavigate();
  useEffect(() => {
    if (ready && !email) navigate({ to: "/auth" });
  }, [ready, email, navigate]);

  const getStatus = useServerFn(getSaxoOAuthStatus);
  const { data } = useQuery({
    queryKey: ["saxo-oauth-status-wizard"],
    queryFn: () => getStatus(),
    enabled: !!email,
    refetchInterval: 2000,
    refetchOnWindowFocus: true,
  });

  const [current, setCurrent] = useState<EnvKey | "done">("sim");
  const [simSnapshot, setSimSnapshot] = useState<EnvSnapshot | null>(null);
  const [liveSnapshot, setLiveSnapshot] = useState<EnvSnapshot | null>(null);

  if (!ready || !email) {
    return (
      <div className="min-h-screen bg-background">
        <AppHeader email={email} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <AppHeader email={email} />
      <main className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Reconnect Saxo</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Step-by-step OAuth reconnect for SIM and LIVE. Each stage is confirmed automatically.
            </p>
          </div>
          <Link
            to="/admin"
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
          >
            ← Admin
          </Link>
        </div>

        <div className="space-y-4">
          <EnvWizard
            env="sim"
            status={data?.sim}
            snapshot={simSnapshot}
            setSnapshot={setSimSnapshot}
            active={current === "sim"}
            onComplete={() => setCurrent("live")}
          />
          <EnvWizard
            env="live"
            status={data?.live}
            snapshot={liveSnapshot}
            setSnapshot={setLiveSnapshot}
            active={current === "live"}
            onComplete={() => setCurrent("done")}
          />

          {current === "done" && (
            <Card className="border-emerald-500/40 bg-emerald-500/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-emerald-500">
                  <PartyPopper className="h-5 w-5" />
                  All connections refreshed
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Both SIM and LIVE tokens are stored. Auto-refresh will keep the access tokens alive; you'll only need
                  to redo this when the refresh token approaches expiry (~30 days).
                </p>
                <div className="flex gap-2">
                  <Link
                    to="/admin"
                    className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    Back to Admin
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    to="/saxo-status"
                    className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
                  >
                    View full diagnostics
                  </Link>
                </div>
              </CardContent>
            </Card>
          )}

          <p className="text-center text-xs text-muted-foreground">
            Tip: if a popup is blocked, click the button again — the browser only asks once.
          </p>
        </div>
      </main>
    </div>
  );
}
