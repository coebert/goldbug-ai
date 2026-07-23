// Web push sender. Uses the `web-push` library, which is compatible with the
// Cloudflare Worker runtime under nodejs_compat (crypto + https are supported).
// Only importable from server code.

import webpush from "web-push";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

let configured = false;
function ensureConfigured() {
  if (configured) return;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT || "mailto:noreply@aegis.local";
  if (!pub || !priv) throw new Error("VAPID keys not configured");
  webpush.setVapidDetails(subj, pub, priv);
  configured = true;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  requireInteraction?: boolean;
}

export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; removed: number; failed: number }> {
  ensureConfigured();
  const { data: subs, error } = await supabaseAdmin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", userId);
  if (error) throw error;
  if (!subs || subs.length === 0) return { sent: 0, removed: 0, failed: 0 };

  const body = JSON.stringify(payload);
  let sent = 0, removed = 0, failed = 0;

  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: 60 * 60 * 12 },
      );
      sent++;
      await supabaseAdmin
        .from("push_subscriptions")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", s.id);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number })?.statusCode;
      if (status === 404 || status === 410) {
        // Subscription gone — remove it
        await supabaseAdmin.from("push_subscriptions").delete().eq("id", s.id);
        removed++;
      } else {
        console.error("push send failed", status, err);
        failed++;
      }
    }
  }
  return { sent, removed, failed };
}
