// Today's decision summary — merges the AI decision audit trail with the
// counterfactual (blocked-buy) log so users can see every symbol the AI
// considered on the current run date plus a plain-language reason why the
// engine ultimately traded (or didn't). RLS on the authenticated Supabase
// client scopes both tables to the caller's own portfolios.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type DecisionSummaryEntry = {
  symbol: string;
  action: "buy" | "sell" | "hold" | null;
  outcome:
    | "filled"
    | "partial"
    | "placed"
    | "pending"
    | "rejected"
    | "cancelled"
    | "skipped"
    | "hold"
    | "error"
    | "blocked"
    | null;
  outcomeDetail: string | null;
  blockCategory: string | null;
  blockReason: string | null;
  rationale: string | null;
  decidedAt: string | null;
  source: string | null;
  notional: number | null;
  price: number | null;
  instrumentCcy: string | null;
};

export type DecisionSummary = {
  portfolioId: string;
  runDate: string;
  hasRunToday: boolean;
  totalConsidered: number;
  tradedCount: number;
  blockedCount: number;
  holdCount: number;
  byAction: Record<"buy" | "sell" | "hold", number>;
  byOutcome: Record<string, number>;
  byBlockCategory: Record<string, number>;
  entries: DecisionSummaryEntry[];
  headline: string;
};

function ukIsoDate(now = new Date()): string {
  // Match the trading engine's UTC run_date convention.
  return now.toISOString().slice(0, 10);
}

const BLOCK_LABEL: Record<string, string> = {
  cooldown: "Post-loss cooldown",
  gap_guard: "Overnight-gap guard",
  gross_exposure: "Gross-exposure cap",
  asset_class_cap: "Asset-class cap",
  correlation_cluster: "Correlation-cluster cap",
  per_symbol_cap: "Per-symbol cap",
  min_trade_size: "Below minimum trade size",
  circuit_breaker: "Circuit breaker",
  other: "Other guardrail",
};

function labelBlock(cat: string): string {
  return BLOCK_LABEL[cat] ?? cat;
}

function buildHeadline(s: {
  hasRunToday: boolean;
  tradedCount: number;
  blockedCount: number;
  holdCount: number;
  totalConsidered: number;
  byBlockCategory: Record<string, number>;
}): string {
  if (!s.hasRunToday && s.blockedCount === 0) {
    return "No AI run recorded today yet. The next scheduled tick will produce decisions.";
  }
  if (s.tradedCount > 0) {
    const parts: string[] = [
      `Placed ${s.tradedCount} order${s.tradedCount === 1 ? "" : "s"}`,
    ];
    if (s.holdCount > 0) parts.push(`held ${s.holdCount} position${s.holdCount === 1 ? "" : "s"}`);
    if (s.blockedCount > 0) parts.push(`${s.blockedCount} candidate${s.blockedCount === 1 ? "" : "s"} blocked`);
    return parts.join(" · ") + ".";
  }
  // No trades — explain why.
  const cats = Object.entries(s.byBlockCategory).sort((a, b) => b[1] - a[1]);
  if (cats.length > 0) {
    const top = cats
      .slice(0, 3)
      .map(([c, n]) => `${n} ${labelBlock(c).toLowerCase()}`)
      .join(", ");
    return `No trades placed today. ${s.totalConsidered} candidate${s.totalConsidered === 1 ? "" : "s"} considered — blocked by ${top}.`;
  }
  if (s.holdCount > 0 && s.totalConsidered > 0) {
    return `No trades placed today. AI reviewed ${s.totalConsidered} candidate${s.totalConsidered === 1 ? "" : "s"} and chose to hold — no signal strong enough to act.`;
  }
  return "No trades placed today — no eligible orders were surfaced by the strategy engine.";
}

export const getTodaysDecisionSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) =>
    z
      .object({
        portfolioId: z.string().uuid(),
        runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(i),
  )
  .handler(async ({ data, context }): Promise<DecisionSummary> => {
    const runDate = data.runDate ?? ukIsoDate();

    const [auditRes, cfRes] = await Promise.all([
      context.supabase
        .from("ai_decision_audit")
        .select(
          "symbol, action, outcome, outcome_detail, rationale, decided_at, source, notional, price, instrument_ccy",
        )
        .eq("portfolio_id", data.portfolioId)
        .eq("run_date", runDate)
        .order("decided_at", { ascending: true })
        .limit(500),
      context.supabase
        .from("counterfactuals")
        .select(
          "symbol, side, block_reason, block_category, conviction, hypothetical_price, hypothetical_spend, created_at",
        )
        .eq("portfolio_id", data.portfolioId)
        .eq("as_of", runDate)
        .order("created_at", { ascending: true })
        .limit(500),
    ]);

    if (auditRes.error) throw new Error(auditRes.error.message);
    if (cfRes.error) throw new Error(cfRes.error.message);

    const auditRows = auditRes.data ?? [];
    const cfRows = cfRes.data ?? [];

    // Merge on symbol, preferring the audit row (it has the executed outcome).
    const bySym = new Map<string, DecisionSummaryEntry>();

    for (const r of auditRows) {
      const sym = String(r.symbol);
      const action = (r.action as DecisionSummaryEntry["action"]) ?? null;
      const outcome = (r.outcome as DecisionSummaryEntry["outcome"]) ?? null;
      const existing = bySym.get(sym);
      const entry: DecisionSummaryEntry = {
        symbol: sym,
        action,
        outcome,
        outcomeDetail: (r.outcome_detail as string | null) ?? null,
        blockCategory: existing?.blockCategory ?? null,
        blockReason: existing?.blockReason ?? null,
        rationale: (r.rationale as string | null) ?? null,
        decidedAt: (r.decided_at as string | null) ?? null,
        source: (r.source as string | null) ?? null,
        notional: r.notional == null ? null : Number(r.notional),
        price: r.price == null ? null : Number(r.price),
        instrumentCcy: (r.instrument_ccy as string | null) ?? null,
      };
      bySym.set(sym, entry);
    }

    for (const r of cfRows) {
      const sym = String(r.symbol);
      const existing = bySym.get(sym);
      if (existing) {
        // Attach the block context to an existing audit entry (e.g. the
        // engine both recorded a "buy" intent and the guardrail block).
        if (!existing.blockCategory) existing.blockCategory = (r.block_category as string | null) ?? null;
        if (!existing.blockReason) existing.blockReason = (r.block_reason as string | null) ?? null;
        if (!existing.outcome) existing.outcome = "blocked";
        continue;
      }
      bySym.set(sym, {
        symbol: sym,
        action: (r.side as "buy" | "sell") ?? null,
        outcome: "blocked",
        outcomeDetail: null,
        blockCategory: (r.block_category as string | null) ?? null,
        blockReason: (r.block_reason as string | null) ?? null,
        rationale: null,
        decidedAt: (r.created_at as string | null) ?? null,
        source: "guardrail",
        notional: r.hypothetical_spend == null ? null : Number(r.hypothetical_spend),
        price: r.hypothetical_price == null ? null : Number(r.hypothetical_price),
        instrumentCcy: null,
      });
    }

    const entries = Array.from(bySym.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));

    const byAction: DecisionSummary["byAction"] = { buy: 0, sell: 0, hold: 0 };
    const byOutcome: Record<string, number> = {};
    const byBlockCategory: Record<string, number> = {};
    let tradedCount = 0;
    let blockedCount = 0;
    let holdCount = 0;

    for (const e of entries) {
      if (e.action && (e.action === "buy" || e.action === "sell" || e.action === "hold")) {
        byAction[e.action] += 1;
      }
      if (e.outcome) byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1;
      if (e.blockCategory) byBlockCategory[e.blockCategory] = (byBlockCategory[e.blockCategory] ?? 0) + 1;
      if (e.outcome === "filled" || e.outcome === "placed" || e.outcome === "partial" || e.outcome === "pending") {
        tradedCount += 1;
      } else if (e.outcome === "blocked" || e.outcome === "rejected" || e.outcome === "skipped") {
        blockedCount += 1;
      } else if (e.action === "hold" || e.outcome === "hold") {
        holdCount += 1;
      }
    }

    const summary: DecisionSummary = {
      portfolioId: data.portfolioId,
      runDate,
      hasRunToday: auditRows.length > 0,
      totalConsidered: entries.length,
      tradedCount,
      blockedCount,
      holdCount,
      byAction,
      byOutcome,
      byBlockCategory,
      entries,
      headline: "",
    };
    summary.headline = buildHeadline(summary);
    return summary;
  });
