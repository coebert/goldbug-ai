// Loading/saving the hand-set per-symbol limits.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { engineSymbolKey } from "./price-symbol";
import { emptyOverride, type SymbolOverride } from "./symbol-overrides";

type Row = {
  symbol: string;
  max_position_pct: number | null;
  stop_loss_pct: number | null;
  take_profit_pct: number | null;
  min_signal_strength: number | null;
  paused: boolean;
  note: string | null;
  updated_at: string | null;
};

function toOverride(r: Row): SymbolOverride {
  return {
    symbol: String(r.symbol),
    maxPositionPct: r.max_position_pct == null ? null : Number(r.max_position_pct),
    stopLossPct: r.stop_loss_pct == null ? null : Number(r.stop_loss_pct),
    takeProfitPct: r.take_profit_pct == null ? null : Number(r.take_profit_pct),
    minSignalStrength: r.min_signal_strength == null ? null : Number(r.min_signal_strength),
    paused: Boolean(r.paused),
    note: r.note == null ? null : String(r.note),
    updatedAt: r.updated_at ? String(r.updated_at) : null,
  };
}

const SELECT =
  "symbol, max_position_pct, stop_loss_pct, take_profit_pct, min_signal_strength, paused, note, updated_at";

/** All hand-set limits for a user, keyed by canonical engine symbol. */
export async function loadSymbolOverrides(
  userId: string,
): Promise<Map<string, SymbolOverride>> {
  const out = new Map<string, SymbolOverride>();
  if (!userId) return out;
  const { data } = await supabaseAdmin
    .from("symbol_risk_overrides")
    .select(SELECT)
    .eq("user_id", userId);
  for (const r of (data ?? []) as Row[]) {
    out.set(engineSymbolKey(r.symbol), toOverride(r));
  }
  return out;
}

export async function loadSymbolOverride(
  userId: string,
  symbol: string,
): Promise<SymbolOverride | null> {
  const all = await loadSymbolOverrides(userId);
  return all.get(engineSymbolKey(symbol)) ?? null;
}

export async function saveSymbolOverride(
  userId: string,
  input: {
    symbol: string;
    maxPositionPct?: number | null;
    stopLossPct?: number | null;
    takeProfitPct?: number | null;
    minSignalStrength?: number | null;
    paused?: boolean;
    note?: string | null;
  },
): Promise<SymbolOverride> {
  const symbol = engineSymbolKey(input.symbol);
  const { data, error } = await supabaseAdmin
    .from("symbol_risk_overrides")
    .upsert(
      {
        user_id: userId,
        symbol,
        max_position_pct: input.maxPositionPct ?? null,
        stop_loss_pct: input.stopLossPct ?? null,
        take_profit_pct: input.takeProfitPct ?? null,
        min_signal_strength: input.minSignalStrength ?? null,
        paused: input.paused ?? false,
        note: input.note ?? null,
      },
      { onConflict: "user_id,symbol" },
    )
    .select(SELECT)
    .single();
  if (error) throw new Error(error.message);
  return data ? toOverride(data as Row) : emptyOverride(symbol);
}

export async function deleteSymbolOverride(userId: string, symbol: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("symbol_risk_overrides")
    .delete()
    .eq("user_id", userId)
    .eq("symbol", engineSymbolKey(symbol));
  if (error) throw new Error(error.message);
}
