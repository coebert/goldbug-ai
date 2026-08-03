// Server-side runner for the price/unit scaling auditor. Pulls the caller's
// holdings + recent price_cache history and feeds them into the pure
// detector. Returns a compact response the admin card can render directly.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  auditHoldingScalings,
  type HoldingScanRow,
  type ScalingFinding,
} from "@/lib/price-scaling-audit";
import { UNIVERSE, type AssetClass } from "@/lib/universe.server";

import { CANONICAL_AC, canonicalFor, HISTORY_DAYS } from "./price-scaling-audit.helpers";
import type { ScalingAuditResponse } from "./price-scaling-audit.helpers";
export type { ScalingAuditResponse };

export const runPriceScalingAudit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({}).parse(input ?? {}),
  )
  .handler(async ({ context }): Promise<ScalingAuditResponse> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // The admin client bypasses RLS, so ownership MUST be enforced here:
    // scope the portfolio scan to the authenticated caller's own rows and
    // derive every downstream query from those ids only.
    const { data: portfolios } = await supabaseAdmin
      .from("portfolios")
      .select("id, name")
      .eq("user_id", context.userId);

    const nameById = new Map<string, string>();
    for (const p of portfolios ?? []) nameById.set(p.id, p.name);
    const portfolioIds = [...nameById.keys()];
    if (portfolioIds.length === 0) {
      return { ran_at: new Date().toISOString(), findings: [], totals: { scanned: 0, findings: 0, errors: 0, warnings: 0 } };
    }

    const { data: holdings, error: hErr } = await supabaseAdmin
      .from("holdings")
      .select("portfolio_id, symbol, asset_class, quantity, avg_cost")
      .in("portfolio_id", portfolioIds)
      .gt("quantity", 0);
    if (hErr) throw new Error(hErr.message);

    const symbols = Array.from(new Set((holdings ?? []).map((h) => h.symbol)));
    if (symbols.length === 0) {
      return { ran_at: new Date().toISOString(), findings: [], totals: { scanned: 0, findings: 0, errors: 0, warnings: 0 } };
    }

    // Pull the last N days of closes per symbol, sorted ascending so we can
    // hand oldest → newest to the detector.
    const sinceISO = new Date(Date.now() - HISTORY_DAYS * 86_400_000)
      .toISOString().slice(0, 10);
    const { data: closes, error: cErr } = await supabaseAdmin
      .from("price_cache")
      .select("symbol, price_date, close")
      .in("symbol", symbols)
      .gte("price_date", sinceISO)
      .order("price_date", { ascending: true });
    if (cErr) throw new Error(cErr.message);

    const historyBySymbol = new Map<string, number[]>();
    const latestBySymbol = new Map<string, number>();
    for (const c of closes ?? []) {
      const n = Number(c.close);
      if (!Number.isFinite(n)) continue;
      const arr = historyBySymbol.get(c.symbol) ?? [];
      arr.push(n);
      historyBySymbol.set(c.symbol, arr);
      latestBySymbol.set(c.symbol, n); // ascending order → last write wins
    }

    const scanRows: HoldingScanRow[] = (holdings ?? []).map((h) => ({
      portfolio_id: h.portfolio_id,
      portfolio_name: nameById.get(h.portfolio_id) ?? null,
      symbol: h.symbol,
      asset_class: h.asset_class,
      quantity: Number(h.quantity),
      avg_cost: Number(h.avg_cost),
      latest_close: latestBySymbol.get(h.symbol) ?? null,
      price_history: historyBySymbol.get(h.symbol) ?? [],
      canonical_asset_class: canonicalFor(h.symbol),
    }));

    const findings = auditHoldingScalings(scanRows);
    const errors = findings.filter((f) => f.severity === "error").length;
    const warnings = findings.length - errors;
    return {
      ran_at: new Date().toISOString(),
      findings,
      totals: { scanned: scanRows.length, findings: findings.length, errors, warnings },
    };
  });
