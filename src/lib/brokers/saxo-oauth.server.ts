// Saxo Bank OAuth 2.0 Code Grant with auto-refresh. Server-only.
// Docs: https://www.developer.saxo/openapi/learn/oauth-authorization-code-flow
//
// Environment-scoped: SIM and LIVE use different app credentials and different
// auth hosts. Tokens are persisted in public.saxo_oauth_tokens (service_role only).
//
// Refresh policy: proactively refresh when < 5 min remaining. Refresh tokens
// themselves also expire (Saxo currently ~30 days rolling) — surfaced via
// refresh_expires_at so the UI can prompt the user to reauthorize before it lapses.

import type { BrokerEnv } from "./adapter";
import { createHmac, timingSafeEqual } from "node:crypto";

const AUTH_HOST = {
  sim: "https://sim.logonvalidation.net",
  live: "https://live.logonvalidation.net",
} as const;

const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh if < 5 min left

interface TokenRow {
  env: BrokerEnv;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  refresh_expires_at: string | null;
  token_type: string;
  updated_at: string;
}

function publishedOrigin(): string {
  // Callback must match the redirect URI registered with Saxo.
  return process.env.PUBLIC_APP_URL ?? "https://goldbug-ai.lovable.app";
}

export function redirectUri(): string {
  return `${publishedOrigin()}/api/public/saxo/callback`;
}

function stateSecret(): string {
  const s = process.env.CRON_SECRET;
  if (!s) throw new Error("CRON_SECRET is not set (reused to sign OAuth state).");
  return s;
}

/** Signed, time-bound state parameter: env|ts|hmac(env|ts). */
export function signState(env: BrokerEnv): string {
  const ts = Date.now().toString();
  const mac = createHmac("sha256", stateSecret()).update(`${env}|${ts}`).digest("hex");
  return `${env}.${ts}.${mac}`;
}

export function verifyState(state: string): { env: BrokerEnv } | null {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [env, ts, mac] = parts;
  if (env !== "sim" && env !== "live") return null;
  const ageMs = Date.now() - Number(ts);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 15 * 60 * 1000) return null;
  const expected = createHmac("sha256", stateSecret()).update(`${env}|${ts}`).digest("hex");
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { env };
}

function appCreds(env: BrokerEnv): { key: string; secret: string } {
  // Saxo issues SEPARATE app credentials for SIM and LIVE (different auth hosts,
  // different client_id namespaces). Prefer per-env secrets; fall back to the
  // generic SAXO_APP_KEY/SECRET (kept for SIM back-compat).
  const key =
    env === "live"
      ? process.env.SAXO_APP_KEY_LIVE ?? process.env.SAXO_APP_KEY
      : process.env.SAXO_APP_KEY_SIM ?? process.env.SAXO_APP_KEY;
  const secret =
    env === "live"
      ? process.env.SAXO_APP_SECRET_LIVE ?? process.env.SAXO_APP_SECRET
      : process.env.SAXO_APP_SECRET_SIM ?? process.env.SAXO_APP_SECRET;
  if (!key || !secret) {
    const suffix = env === "live" ? "_LIVE" : "_SIM";
    throw new Error(
      `SAXO_APP_KEY${suffix} / SAXO_APP_SECRET${suffix} not configured. Register a ${env.toUpperCase()} app in the Saxo Developer Portal and save both secrets.`,
    );
  }
  return { key, secret };
}

export function getAuthorizeUrl(env: BrokerEnv): string {
  const { key } = appCreds(env);
  const u = new URL(`${AUTH_HOST[env]}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", key);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("state", signState(env));
  return u.toString();
}

interface SaxoTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // seconds
  refresh_token: string;
  refresh_token_expires_in?: number; // seconds
}

async function tokenRequest(env: BrokerEnv, form: URLSearchParams): Promise<SaxoTokenResponse> {
  const { key, secret } = appCreds(env);
  const basic = Buffer.from(`${key}:${secret}`).toString("base64");
  const res = await fetch(`${AUTH_HOST[env]}/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Saxo token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as SaxoTokenResponse;
}

async function persist(env: BrokerEnv, tok: SaxoTokenResponse): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = Date.now();
  const expiresAt = new Date(now + tok.expires_in * 1000).toISOString();
  const refreshExpiresAt = tok.refresh_token_expires_in
    ? new Date(now + tok.refresh_token_expires_in * 1000).toISOString()
    : null;
  const { error } = await supabaseAdmin.from("saxo_oauth_tokens").upsert(
    {
      env,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: expiresAt,
      refresh_expires_at: refreshExpiresAt,
      token_type: tok.token_type ?? "Bearer",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "env" },
  );
  if (error) throw new Error(`Failed to store Saxo tokens: ${error.message}`);
}

export async function exchangeAuthorizationCode(env: BrokerEnv, code: string): Promise<void> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
  });
  const tok = await tokenRequest(env, form);
  await persist(env, tok);
}

async function loadRow(env: BrokerEnv): Promise<TokenRow | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("saxo_oauth_tokens")
    .select("*")
    .eq("env", env)
    .maybeSingle();
  if (error) throw error;
  return (data as TokenRow | null) ?? null;
}

async function refreshRow(row: TokenRow): Promise<TokenRow> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: row.refresh_token,
    redirect_uri: redirectUri(),
  });
  const tok = await tokenRequest(row.env, form);
  await persist(row.env, tok);
  const fresh = await loadRow(row.env);
  if (!fresh) throw new Error("Token row missing after refresh");
  return fresh;
}

/**
 * Return a valid access token for the given env. Refreshes proactively if the
 * current one is within REFRESH_SKEW_MS of expiry. Falls back to the legacy
 * SAXO_ACCESS_TOKEN env var if no OAuth row exists yet (backward compat).
 */
export async function getAccessToken(env: BrokerEnv): Promise<string> {
  const row = await loadRow(env);
  if (!row) {
    const legacy = process.env.SAXO_ACCESS_TOKEN;
    if (legacy) return legacy;
    throw new Error(
      `No Saxo OAuth token stored for env=${env}. Connect the account via the Saxo OAuth flow first.`,
    );
  }
  const expiresMs = new Date(row.expires_at).getTime();
  if (expiresMs - Date.now() > REFRESH_SKEW_MS) return row.access_token;
  const fresh = await refreshRow(row);
  return fresh.access_token;
}

export interface OAuthStatus {
  env: BrokerEnv;
  connected: boolean;
  expiresAt: string | null;
  refreshExpiresAt: string | null;
  secondsUntilExpiry: number | null;
  usingLegacyToken: boolean;
}

export async function getOAuthStatus(env: BrokerEnv): Promise<OAuthStatus> {
  const row = await loadRow(env);
  if (!row) {
    return {
      env,
      connected: !!process.env.SAXO_ACCESS_TOKEN,
      expiresAt: null,
      refreshExpiresAt: null,
      secondsUntilExpiry: null,
      usingLegacyToken: !!process.env.SAXO_ACCESS_TOKEN,
    };
  }
  const secs = Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000);
  return {
    env,
    connected: true,
    expiresAt: row.expires_at,
    refreshExpiresAt: row.refresh_expires_at,
    secondsUntilExpiry: secs,
    usingLegacyToken: false,
  };
}
