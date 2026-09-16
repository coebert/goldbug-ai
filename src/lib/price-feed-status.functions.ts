// Read-only price-feed health for the UI. No LLM credits are spent here.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type PriceFeedStatusRow = {
  symbol: string;
  feedSymbol: string | null;
  status: string;
  lastOkAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  updatedAt: string;
};

export const getPriceFeedStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("price_feed_status")
      .select("symbol,feed_symbol,status,last_ok_at,last_error,consecutive_failures,updated_at")
      .order("status", { ascending: true })
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    const rows: PriceFeedStatusRow[] = (data ?? []).map((r) => ({
      symbol: r.symbol as string,
      feedSymbol: (r.feed_symbol as string | null) ?? null,
      status: (r.status as string) ?? "ok",
      lastOkAt: (r.last_ok_at as string | null) ?? null,
      lastError: (r.last_error as string | null) ?? null,
      consecutiveFailures: Number(r.consecutive_failures ?? 0),
      updatedAt: r.updated_at as string,
    }));
    return {
      total: rows.length,
      fallbacks: rows.filter((r) => r.status !== "ok"),
    };
  });
