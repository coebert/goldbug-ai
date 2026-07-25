import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Trade error dashboard data source.
 *
 * Reads the user's own live_orders + live_broker_log rows via the RLS-scoped
 * client and stitches each failed order together with the pre-placement
 * signals that shaped or blocked it in the same tick:
 *
 *   - PRE_PLACE_RECONCILE        top-of-tick broker cash refresh
 *   - FX_CAPTURE                 portfolio→broker currency conversion
 *   - PRE_PLACE_AFFORDABILITY    budget trim decisions
 *   - PRE_PLACE_FX_BLOCK         FX unavailable → cross-ccy buys blocked
 *   - PRECHECK_REJECT            broker-side precheck rejection
 *
 * Each error row exposes: order metadata, root-cause error code + message,
 * the FX source/rate/stale flag that was captured in the same window, and
 * the specific affordability decision (allowed / skipped / blocked) so the
 * user can see exactly why the trade failed without reading log JSON.
 */

export type TradeErrorRow = {
  id: string;
  createdAt: string;
  portfolioId: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  status: string; // "error" | "rejected"
  brokerOrderId: string | null;
  rejectReason: string | null;
  rootCauseCode: string | null;
  rootCauseMessage: string | null;
  fx: {
    from: string | null;
    to: string | null;
    rate: number | null;
    source: string | null;
    stale: boolean | null;
  } | null;
  affordability:
    | { kind: "allowed"; notionalBrokerCcy: number | null }
    | { kind: "skipped"; reason: string; notionalBrokerCcy: number | null }
    | { kind: "fx_blocked"; reason: string }
    | { kind: "no_data" };
};

const InputSchema = z.object({
  portfolioId: z.string().uuid(),
  sinceHours: z.number().int().min(1).max(720).default(72),
  limit: z.number().int().min(1).max(200).default(100),
});

type LogRow = {
  id: string;
  created_at: string;
  method: string;
  path: string;
  status: number | null;
  request: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
  error: string | null;
};

function nearestBefore<T extends { created_at: string }>(
  rows: T[],
  at: string,
  windowMs = 10 * 60 * 1000,
): T | null {
  const atMs = Date.parse(at);
  let best: T | null = null;
  let bestDelta = Infinity;
  for (const r of rows) {
    const rMs = Date.parse(r.created_at);
    const delta = atMs - rMs;
    if (delta >= 0 && delta <= windowMs && delta < bestDelta) {
      best = r;
      bestDelta = delta;
    }
  }
  return best;
}

export const getTradeErrors = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ data, context }) => {
    const sinceIso = new Date(Date.now() - data.sinceHours * 3600_000).toISOString();

    const ordersQ = await context.supabase
      .from("live_orders")
      .select(
        "id, portfolio_id, symbol, side, quantity, status, broker_order_id, reject_reason, created_at, client_order_id",
      )
      .eq("portfolio_id", data.portfolioId)
      .in("status", ["error", "rejected"])
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (ordersQ.error) throw new Error(ordersQ.error.message);
    const orders = ordersQ.data ?? [];

    const logsQ = await context.supabase
      .from("live_broker_log")
      .select("id, created_at, method, path, status, request, response, error")
      .eq("portfolio_id", data.portfolioId)
      .in("method", [
        "FX_CAPTURE",
        "PRE_PLACE_RECONCILE",
        "PRE_PLACE_AFFORDABILITY",
        "PRE_PLACE_FX_BLOCK",
        "PRECHECK_REJECT",
      ])
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(500);
    if (logsQ.error) throw new Error(logsQ.error.message);
    const logs = (logsQ.data ?? []) as LogRow[];

    const fxLogs = logs.filter((l) => l.method === "FX_CAPTURE");
    const trimLogs = logs.filter((l) => l.method === "PRE_PLACE_AFFORDABILITY");
    const blockLogs = logs.filter((l) => l.method === "PRE_PLACE_FX_BLOCK");
    const precheckLogs = logs.filter((l) => l.method === "PRECHECK_REJECT");

    const rows: TradeErrorRow[] = orders.map((o) => {
      const at = o.created_at as string;

      // FX capture for this tick.
      const fxRow = nearestBefore(fxLogs, at);
      let fx: TradeErrorRow["fx"] = null;
      if (fxRow) {
        const path = fxRow.path ?? ""; // "/fx/GBP->EUR"
        const m = /\/fx\/([A-Z]{3})->([A-Z]{3})/.exec(path);
        const resp = (fxRow.response ?? {}) as {
          rate?: number;
          source?: string;
          stale?: boolean;
        };
        fx = {
          from: m?.[1] ?? null,
          to: m?.[2] ?? null,
          rate: typeof resp.rate === "number" ? resp.rate : null,
          source: resp.source ?? null,
          stale: typeof resp.stale === "boolean" ? resp.stale : null,
        };
      }

      // Root cause: prefer a PRECHECK_REJECT that names this symbol,
      // else fall back to the order's reject_reason. Precheck stores
      // request.symbol so match on it inside a 10 minute window.
      let rootCauseCode: string | null = null;
      let rootCauseMessage: string | null = o.reject_reason ?? null;
      const atMs = Date.parse(at);
      const precheckForSymbol = precheckLogs.find((p) => {
        const req = (p.request ?? {}) as { symbol?: string };
        if (req.symbol !== o.symbol) return false;
        const dt = Math.abs(Date.parse(p.created_at) - atMs);
        return dt <= 10 * 60 * 1000;
      });
      if (precheckForSymbol) {
        const resp = (precheckForSymbol.response ?? {}) as {
          ErrorCode?: string | null;
          Message?: string | null;
        };
        rootCauseCode = resp.ErrorCode ?? null;
        rootCauseMessage = resp.Message ?? rootCauseMessage;
      } else if (o.reject_reason) {
        // Attempt to extract a Saxo ErrorCode from the reject_reason blob.
        const codeMatch = /"ErrorCode"\s*:\s*"([^"]+)"/.exec(o.reject_reason);
        if (codeMatch) rootCauseCode = codeMatch[1];
      }

      // Affordability decision. FX block wins if it fired in the window.
      const blockRow = nearestBefore(blockLogs, at);
      const trimRow = nearestBefore(trimLogs, at);
      let affordability: TradeErrorRow["affordability"] = { kind: "no_data" };

      if (blockRow) {
        affordability = {
          kind: "fx_blocked",
          reason:
            blockRow.error ?? "fx unavailable — cross-currency buys blocked",
        };
      } else if (trimRow) {
        const resp = (trimRow.response ?? {}) as {
          skipped?: Array<{
            symbol?: string;
            side?: string;
            notionalBrokerCcy?: number;
            reason?: string;
          }>;
        };
        const skipped = resp.skipped ?? [];
        const mine = skipped.find(
          (s) => s.symbol === o.symbol && s.side === o.side,
        );
        if (mine) {
          affordability = {
            kind: "skipped",
            reason: mine.reason ?? "insufficient broker cash",
            notionalBrokerCcy: mine.notionalBrokerCcy ?? null,
          };
        } else {
          affordability = { kind: "allowed", notionalBrokerCcy: null };
        }
      }

      return {
        id: o.id as string,
        createdAt: at,
        portfolioId: o.portfolio_id as string,
        symbol: o.symbol as string,
        side: o.side as "buy" | "sell",
        quantity: Number(o.quantity),
        status: o.status as string,
        brokerOrderId: (o.broker_order_id as string | null) ?? null,
        rejectReason: (o.reject_reason as string | null) ?? null,
        rootCauseCode,
        rootCauseMessage,
        fx,
        affordability,
      } satisfies TradeErrorRow;
    });

    return {
      rows,
      windowHours: data.sinceHours,
      totalErrors: rows.length,
    };
  });
