import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type WebhookDeliveryRow = {
  id: string;
  category: string;
  event: string;
  portfolioId: string | null;
  endpointHost: string | null;
  status: string;
  attempts: number;
  httpStatus: number | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
};

/** Recent outbound alert-webhook deliveries for the signed-in user. */
export const getWebhookDeliveries = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        category: z.string().max(120).optional(),
        portfolioId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<WebhookDeliveryRow[]> => {
    let q = context.supabase
      .from("alert_webhook_deliveries")
      .select(
        "id, category, event, portfolio_id, endpoint_host, status, attempts, http_status, error, duration_ms, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 10);
    if (data.category) q = q.eq("category", data.category);
    if (data.portfolioId) q = q.eq("portfolio_id", data.portfolioId);

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return (rows ?? []).map((r) => ({
      id: r.id,
      category: r.category,
      event: r.event,
      portfolioId: r.portfolio_id,
      endpointHost: r.endpoint_host,
      status: r.status,
      attempts: r.attempts,
      httpStatus: r.http_status,
      error: r.error,
      durationMs: r.duration_ms,
      createdAt: r.created_at,
    }));
  });
