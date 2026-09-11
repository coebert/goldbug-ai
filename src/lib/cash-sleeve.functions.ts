import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type CashSleeveControls = {
  enabled: boolean;
  symbol: string;
  buffer: number;
};

export const getCashSleeve = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CashSleeveControls> => {
    const { data, error } = await context.supabase
      .from("trading_controls")
      .select("cash_sleeve_enabled, cash_sleeve_symbol, cash_sleeve_buffer")
      .eq("id", true)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      enabled: Boolean(data?.cash_sleeve_enabled),
      symbol: String(data?.cash_sleeve_symbol ?? "ERNS.L"),
      buffer: Number(data?.cash_sleeve_buffer ?? 1500),
    };
  });

export const saveCashSleeve = createServerFn({ method: "POST" })
  .inputValidator((data) =>
    z
      .object({
        enabled: z.boolean(),
        symbol: z.string().min(1).max(24),
        buffer: z.number().min(0).max(1_000_000),
      })
      .parse(data),
  )
  .middleware([requireSupabaseAuth])
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("trading_controls")
      .update({
        cash_sleeve_enabled: data.enabled,
        cash_sleeve_symbol: data.symbol.toUpperCase(),
        cash_sleeve_buffer: data.buffer,
      })
      .eq("id", true);
    if (error) throw new Error(error.message);
    return { ok: true as const, ...data };
  });
