// Authenticated entry points for the per-symbol desk page.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SymbolDesk, SymbolDetail } from "./symbol-desk.server";
import type { SymbolOverride } from "./symbol-overrides";

export type { SymbolDesk, SymbolDeskRow, SymbolDetail } from "./symbol-desk.server";

export const getSymbolDesk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid().optional(),
        horizonDays: z.number().int().min(1).max(60).optional(),
      })
      .parse(data ?? {}),
  )
  .handler(async ({ data, context }): Promise<SymbolDesk | null> => {
    const { buildSymbolDesk } = await import("./symbol-desk.server");
    return buildSymbolDesk({
      userId: context.userId,
      ...(data.portfolioId ? { portfolioId: data.portfolioId } : {}),
      ...(data.horizonDays == null ? {} : { horizonDays: data.horizonDays }),
    });
  });

export const getSymbolDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        symbol: z.string().min(1).max(40),
        portfolioId: z.string().uuid().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }): Promise<SymbolDetail | null> => {
    const { buildSymbolDetail } = await import("./symbol-desk.server");
    return buildSymbolDetail({
      userId: context.userId,
      symbol: data.symbol,
      ...(data.portfolioId ? { portfolioId: data.portfolioId } : {}),
    });
  });

export const saveSymbolLimits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        symbol: z.string().min(1).max(40),
        maxPositionPct: z.number().min(0.001).max(1).nullable().default(null),
        stopLossPct: z.number().min(0.001).max(1).nullable().default(null),
        takeProfitPct: z.number().min(0.001).max(5).nullable().default(null),
        minSignalStrength: z.number().min(0).max(1).nullable().default(null),
        paused: z.boolean().default(false),
        note: z.string().max(400).nullable().default(null),
      })
      .parse(data),
  )
  .handler(async ({ data, context }): Promise<SymbolOverride> => {
    const { saveSymbolOverride } = await import("./symbol-overrides.server");
    return saveSymbolOverride(context.userId, data);
  });

export const clearSymbolLimits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ symbol: z.string().min(1).max(40) }).parse(data))
  .handler(async ({ data, context }) => {
    const { deleteSymbolOverride } = await import("./symbol-overrides.server");
    await deleteSymbolOverride(context.userId, data.symbol);
    return { ok: true };
  });
