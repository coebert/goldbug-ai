/**
 * Import a downloaded broker booking statement onto the fill tape.
 *
 * The live cost report on this account returns trades without money, so fees
 * stay modelled. This lets the statement itself be the invoice source: parse
 * it, hand it to the existing charge matcher as a one-shot "adapter", and let
 * the normal FX conversion, pence/pound unit gate and `fee_source: broker`
 * stamping run exactly as they do for an API-sourced report.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  parseBrokerStatement,
  earliestChargeDate,
  type StatementParseIssue,
} from "@/lib/broker-statement-parse";

export type StatementImportPortfolio = {
  id: string;
  name: string;
  mode: string;
  fills: number;
  invoicedFills: number;
};

export type StatementImportResult = {
  dryRun: boolean;
  rowsRead: number;
  chargesParsed: number;
  columns: string[];
  unmappedColumns: string[];
  skipped: StatementParseIssue[];
  totalsByCurrency: Record<string, number>;
  /** First few parsed rows, so the operator can eyeball the mapping. */
  preview: Array<{
    symbol: string | null;
    side: string | null;
    quantity: number | null;
    tradedAt: string | null;
    currency: string;
    total: number;
  }>;
  /** Populated on a real import. */
  fillsConsidered: number;
  fillsUpdated: number;
  unmatchedCharges: number;
  unmatchedFills: number;
  unitMismatches: number;
  chargedTotal: number;
  currency: string;
  message: string;
};

export const listStatementImportPortfolios = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<StatementImportPortfolio[]> => {
    const { data } = await context.supabase
      .from("portfolios")
      .select("id, name, mode")
      .in("mode", ["live_prod", "live_sim"])
      .order("live_activated_at", { ascending: false, nullsFirst: false });

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const out: StatementImportPortfolio[] = [];
    for (const p of rows) {
      const id = String(p["id"]);
      const [all, invoiced] = await Promise.all([
        context.supabase
          .from("live_fills")
          .select("id", { count: "exact", head: true })
          .eq("portfolio_id", id),
        context.supabase
          .from("live_fills")
          .select("id", { count: "exact", head: true })
          .eq("portfolio_id", id)
          .eq("fee_source", "broker"),
      ]);
      out.push({
        id,
        name: String(p["name"] ?? "Portfolio"),
        mode: String(p["mode"] ?? ""),
        fills: Number(all?.count ?? 0) || 0,
        invoicedFills: Number(invoiced?.count ?? 0) || 0,
      });
    }
    return out;
  });

export const importBrokerStatement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        text: z.string().min(1).max(4_000_000),
        dryRun: z.boolean().optional(),
        defaultCurrency: z.string().min(3).max(4).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }): Promise<StatementImportResult> => {
    const parsed = parseBrokerStatement(data.text, {
      ...(data.defaultCurrency ? { defaultCurrency: data.defaultCurrency } : {}),
    });

    const preview = parsed.charges.slice(0, 10).map((c) => ({
      symbol: c.symbol ?? null,
      side: c.side ?? null,
      quantity: c.quantity ?? null,
      tradedAt: c.tradedAt ?? null,
      currency: c.currency,
      total: c.total,
    }));

    const base: StatementImportResult = {
      dryRun: data.dryRun ?? false,
      rowsRead: parsed.rowsRead,
      chargesParsed: parsed.charges.length,
      columns: parsed.columns,
      unmappedColumns: parsed.unmappedColumns,
      skipped: parsed.skipped.slice(0, 20),
      totalsByCurrency: parsed.totalsByCurrency,
      preview,
      fillsConsidered: 0,
      fillsUpdated: 0,
      unmatchedCharges: 0,
      unmatchedFills: 0,
      unitMismatches: 0,
      chargedTotal: 0,
      currency: "GBP",
      message: "",
    };

    if (parsed.charges.length === 0) {
      return {
        ...base,
        message:
          parsed.skipped[0]?.reason ??
          "No charges could be read from this file — check it contains a header row and a cost column.",
      };
    }

    // Ownership check: the importer writes with the admin client, so the
    // portfolio must be provably the caller's before anything is touched.
    const { data: book } = await context.supabase
      .from("portfolios")
      .select("id")
      .eq("id", data.portfolioId)
      .maybeSingle();
    if (!book) throw new Error("Portfolio not found");

    if (data.dryRun) {
      return {
        ...base,
        message: `${parsed.charges.length} charge rows read. Nothing written yet.`,
      };
    }

    const earliest = earliestChargeDate(parsed.charges);
    const spanDays = earliest
      ? Math.ceil((Date.now() - Date.parse(earliest)) / 86_400_000) + 5
      : 365;
    const lookbackDays = Math.min(3650, Math.max(45, spanDays));

    const { ingestBrokerCostsForPortfolio } = await import("@/lib/broker-cost-ingest.server");
    const res = await ingestBrokerCostsForPortfolio({
      portfolioId: data.portfolioId,
      userId: context.userId,
      lookbackDays,
      adapter: {
        getTradeCharges: async () => ({
          supported: true,
          charges: parsed.charges,
          endpoint: "statement-import",
        }),
      },
    });

    return {
      ...base,
      fillsConsidered: res.fillsConsidered,
      fillsUpdated: res.fillsUpdated,
      unmatchedCharges: res.unmatchedCharges,
      unmatchedFills: res.unmatchedFills,
      unitMismatches: res.unitMismatches,
      chargedTotal: res.chargedTotal,
      currency: res.currency,
      message:
        res.fillsUpdated > 0
          ? `${res.fillsUpdated} trades now priced with the broker's own charges.`
          : "No trades matched the rows in this statement — check the dates and symbols line up with your fills.",
    };
  });
