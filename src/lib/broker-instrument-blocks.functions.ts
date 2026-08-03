// Client-callable RPC surface for learned broker instrument blocks
// (Saxo suitability / appropriateness / permission rejections).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

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

export const clearBrokerInstrumentBlock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) =>
    z
      .object({ symbolKey: z.string().min(1).max(32), broker: z.string().max(32).optional() })
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
    return { cleared };
  });
