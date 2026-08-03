// Runtime helpers extracted from admin.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface BrokerEnvHealth {
  env: "sim" | "live";
  ping: { ok: boolean; latencyMs: number | null; accountId?: string; reason?: string };
  oauth: {
    connected: boolean;
    expiresAt: string | null;
    refreshExpiresAt: string | null;
    secondsUntilExpiry: number | null;
    usingLegacyToken: boolean;
  };
}

export interface RoutingActivity {
  lastSuccessAt: string | null;
  lastSuccessPath: string | null;
  lastSuccessEnv: string | null;
  lastFailureAt: string | null;
  lastFailureError: string | null;
  successCount24h: number;
  failureCount24h: number;
  paperSkipCount24h: number;
}

export interface AdminHealthSnapshot {
  generatedAt: string;
  paperOnlyKillSwitch: boolean;
  environments: BrokerEnvHealth[];
  routing: RoutingActivity;
  cron: { lastRunAt: string | null; ranWithinHour: boolean };
}

export async function envHealth(userId: string, env: "sim" | "live"): Promise<BrokerEnvHealth> {
  const { getOAuthStatus } = await import("@/lib/brokers/saxo-oauth.server");
  const oauth = await getOAuthStatus(env);

  let ping: BrokerEnvHealth["ping"] = { ok: false, latencyMs: null, reason: "not attempted" };
  try {
    const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
    const adapter = await buildSaxoAdapter({ userId, envOverride: env });
    const t0 = Date.now();
    const p = await adapter.ping();
    ping = {
      ok: p.ok,
      latencyMs: Date.now() - t0,
      accountId: p.accountId,
      reason: p.ok ? undefined : (p.reason ?? "unknown"),
    };
  } catch (e) {
    ping = { ok: false, latencyMs: null, reason: e instanceof Error ? e.message : String(e) };
  }
  return { env, ping, oauth };
}
