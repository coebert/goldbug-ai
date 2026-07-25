// Server function: read wallet_snapshots for a portfolio to power the
// per-currency wallet time-series chart.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const InputSchema = z.object({
  portfolioId: z.string().uuid(),
  sinceDays: z.number().int().min(1).max(3650).optional(),
});

export type WalletHistoryRow = {
  snapshot_date: string;
  base_ccy: string;
  base_total: number;
  cash_by_ccy: Record<string, number>;
};

export type WalletHistoryResult = {
  rows: WalletHistoryRow[];
  currencies: string[]; // union of currencies seen across the window
  baseCcy: string | null;
};

export const getWalletHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => InputSchema.parse(raw))
  .handler(async ({ data, context }): Promise<WalletHistoryResult> => {
    const { supabase } = context;
    const since = data.sinceDays
      ? new Date(Date.now() - data.sinceDays * 86400_000).toISOString().slice(0, 10)
      : null;

    let q = supabase
      .from("wallet_snapshots")
      .select("snapshot_date, cash_by_ccy, base_ccy, base_total")
      .eq("portfolio_id", data.portfolioId)
      .order("snapshot_date", { ascending: true });
    if (since) q = q.gte("snapshot_date", since);

    const { data: rowsRaw, error } = await q;
    if (error) throw error;

    const rows: WalletHistoryRow[] = (rowsRaw ?? []).map((r) => ({
      snapshot_date: String(r.snapshot_date),
      base_ccy: String(r.base_ccy ?? "GBP").toUpperCase(),
      base_total: Number(r.base_total ?? 0),
      cash_by_ccy:
        r.cash_by_ccy && typeof r.cash_by_ccy === "object" && !Array.isArray(r.cash_by_ccy)
          ? Object.fromEntries(
              Object.entries(r.cash_by_ccy as Record<string, unknown>).map(([k, v]) => [
                k.toUpperCase(),
                Number(v) || 0,
              ]),
            )
          : {},
    }));

    const currencies = new Set<string>();
    for (const r of rows) for (const c of Object.keys(r.cash_by_ccy)) currencies.add(c);

    return {
      rows,
      currencies: Array.from(currencies).sort(),
      baseCcy: rows.length ? rows[rows.length - 1].base_ccy : null,
    };
  });
