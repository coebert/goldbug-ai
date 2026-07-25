import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * Count recent PRECHECK_REJECT rows for a portfolio and separate out the
 * cash-side rejections (InsufficientCash, InsufficientBuyingPower) that
 * should prompt the user to correct their cash assumption or per-symbol
 * risk sizing. Reads via the RLS-scoped supabase client so callers only
 * ever see their own portfolios' rows.
 *
 * Threshold logic lives in the UI so operators can tweak it without a
 * migration; this function just returns the raw counts + a bounded set of
 * example reasons for display.
 */
export const getPrecheckCashRejects = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        // 24h window is enough to catch a run of failing ticks without
        // flagging on an isolated blip from earlier in the week.
        sinceHours: z.number().int().min(1).max(168).default(24),
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    const sinceIso = new Date(Date.now() - data.sinceHours * 3600_000).toISOString();
    const q = await context.supabase
      .from("live_broker_log")
      .select("id, created_at, error, response")
      .eq("portfolio_id", data.portfolioId)
      .eq("method", "PRECHECK_REJECT")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(100);
    if (q.error) throw new Error(q.error.message);
    const rows = q.data ?? [];

    // A precheck rejection is "cash-side" when Saxo returned one of the
    // known InsufficientCash / InsufficientBuyingPower codes, or when the
    // human-readable message clearly names cash. We match on either the
    // structured ErrorCode (preferred) or the message text (fallback).
    const cashCodePattern = /^(insufficient(cash|buyingpower)|nocashavailable)$/i;
    const cashTextPattern = /insufficient.*(cash|buying power|funds)|not enough (cash|funds)/i;

    type Sample = { code: string | null; message: string | null; at: string };
    const samples: Sample[] = [];
    let cashCount = 0;
    let firstAt: string | null = null;
    let lastAt: string | null = null;

    for (const row of rows) {
      const resp = (row.response ?? {}) as { ErrorCode?: string | null; Message?: string | null };
      const code = resp.ErrorCode ?? null;
      const message = resp.Message ?? row.error ?? null;
      const isCash =
        (code && cashCodePattern.test(code)) ||
        (typeof message === "string" && cashTextPattern.test(message));
      if (!isCash) continue;

      cashCount += 1;
      if (!lastAt) lastAt = row.created_at;
      firstAt = row.created_at;
      if (samples.length < 3) samples.push({ code, message, at: row.created_at });
    }

    return {
      totalPrecheckRejects: rows.length,
      cashRejects: cashCount,
      windowHours: data.sinceHours,
      firstAt,
      lastAt,
      samples,
    };
  });
