// Client-callable RPC surface for learned broker instrument blocks
// (Saxo suitability / appropriateness / permission rejections).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAal2 } from "@/lib/_server/require-aal2";

export interface BrokerBlockDTO {
  symbol: string;
  symbolKey: string;
  reason: string;
  detail: string | null;
  hitCount: number;
  lastSeenAt: string;
}

export interface BrokerBlockEventDTO {
  id: string;
  createdAt: string;
  broker: string;
  symbol: string;
  symbolKey: string;
  reason: string;
  detail: string | null;
  rejectReason: string | null;
  errorCode: string | null;
  orderId: string | null;
  side: string | null;
  quantity: number | null;
  recommendedAction: string;
  firstBlock: boolean;
  hitCount: number;
}

export const listBrokerInstrumentBlocks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ blocks: BrokerBlockDTO[] }> => {
    const { loadActiveBrokerBlocks } = await import(
      "@/lib/broker-instrument-blocks.server"
    );
    const blocks = await loadActiveBrokerBlocks(context.userId);
    return { blocks };
  });

export const listBrokerBlockEvents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z.object({ limit: z.number().int().min(1).max(200).optional() }).parse(data ?? {}),
  )
  .handler(async ({ context, data }): Promise<{ events: BrokerBlockEventDTO[] }> => {
    const { loadBrokerBlockEvents } = await import(
      "@/lib/broker-instrument-blocks.server"
    );
    const events = await loadBrokerBlockEvents(context.userId, data.limit ?? 50);
    return { events };
  });

// Unblocking re-enters a symbol into the live universe, so it is gated by the
// same second-factor policy as the trading server functions, and scoped to
// rows the caller owns.
export const clearBrokerInstrumentBlock = createServerFn({ method: "POST" })
  .middleware([requireAal2])
  .inputValidator((data) =>
    z
      .object({ symbolKey: z.string().min(1).max(32), broker: z.string().min(1).max(32).optional() })
      .parse(data),
  )
  .handler(async ({ context, data }): Promise<{ cleared: boolean }> => {
    const { clearBrokerBlock } = await import(
      "@/lib/broker-instrument-blocks.server"
    );
    const cleared = await clearBrokerBlock({
      userId: context.userId,
      symbolKey: data.symbolKey,
      broker: data.broker ?? "saxo",
    });
    return { cleared: cleared > 0 };
  });

export interface RecheckBlocksResultDTO {
  checked: number;
  cleared: number;
  stillBlocked: number;
  unknown: number;
  message: string;
  results: Array<{
    symbol: string;
    symbolKey: string;
    outcome: string;
    note: string;
    /** Verbatim broker evidence so the user knows what to fix in Saxo. */
    brokerCode: string | null;
    brokerMessage: string | null;
    brokerPreCheckResult: string | null;
    brokerDetails: string[];
    reason: string | null;
  }>;
}

/**
 * Force a resync of broker approvals: dry-run a precheck per blocked symbol
 * and lift the ones Saxo no longer refuses. Same second-factor gate as
 * manual unblocking, since it can put instruments back in the live universe.
 */
export const recheckBrokerInstrumentBlocks = createServerFn({ method: "POST" })
  .middleware([requireAal2])
  .handler(async ({ context }): Promise<RecheckBlocksResultDTO> => {
    const { recheckBrokerBlocks } = await import("@/lib/broker-block-recheck.server");
    return await recheckBrokerBlocks({ userId: context.userId });
  });

