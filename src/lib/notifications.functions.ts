// Authenticated server functions for the in-app notifications panel.
//
// Notifications for `pending_slices` security events are written server-side
// by `maybeNotifySecurityEvent` (see security-alerts.server.ts) alongside the
// push notification. This module exposes read + mutate endpoints for the UI.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Json } from "@/integrations/supabase/types";

export type NotificationRow = {
  id: string;
  category: string;
  severity: string;
  title: string;
  body: string | null;
  portfolio_id: string | null;
  slice_id: string | null;
  details: Json;
  read_at: string | null;
  created_at: string;
};

export const listNotifications = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      category: z.string().trim().min(1).max(64).optional(),
      categories: z.array(z.string().trim().min(1).max(64)).min(1).max(10).optional(),
      unreadOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(200).default(50),
    }).parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<{
    rows: NotificationRow[];
    unreadCount: number;
  }> => {
    const { supabase } = context;
    let q = supabase
      .from("notifications")
      .select("id, category, severity, title, body, portfolio_id, slice_id, details, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.categories) q = q.in("category", data.categories);
    else if (data.category) q = q.eq("category", data.category);
    if (data.unreadOnly) q = q.is("read_at", null);
    const { data: rows, error } = await q;
    if (error) throw new Error(`notifications query failed: ${error.message}`);

    let cq = supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null);
    if (data.categories) cq = cq.in("category", data.categories);
    else if (data.category) cq = cq.eq("category", data.category);
    const { count, error: countErr } = await cq;
    if (countErr) throw new Error(`notifications unread count failed: ${countErr.message}`);

    return { rows: (rows ?? []) as NotificationRow[], unreadCount: count ?? 0 };
  });

export const markNotificationsRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .in("id", data.ids)
      .is("read_at", null);
    if (error) throw new Error(`mark read failed: ${error.message}`);
    return { ok: true, updated: data.ids.length };
  });

export const markNotificationsUnread = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("notifications")
      .update({ read_at: null })
      .in("id", data.ids);
    if (error) throw new Error(`mark unread failed: ${error.message}`);
    return { ok: true, updated: data.ids.length };
  });

export const markAllNotificationsRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      category: z.string().trim().min(1).max(64).optional(),
      categories: z.array(z.string().trim().min(1).max(64)).min(1).max(10).optional(),
    })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .is("read_at", null);
    if (data.categories) q = q.in("category", data.categories);
    else if (data.category) q = q.eq("category", data.category);
    const { error } = await q;
    if (error) throw new Error(`mark all read failed: ${error.message}`);
    return { ok: true };
  });

export const deleteNotifications = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("notifications")
      .delete()
      .in("id", data.ids);
    if (error) throw new Error(`delete failed: ${error.message}`);
    return { ok: true, deleted: data.ids.length };
  });
