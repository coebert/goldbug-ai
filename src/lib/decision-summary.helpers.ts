// Runtime helpers extracted from decision-summary.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

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

export function ukIsoDate(now = new Date()): string {
  // Match the trading engine's UTC run_date convention.
  return now.toISOString().slice(0, 10);
}

export const BLOCK_LABEL: Record<string, string> = {
  cooldown: "Post-loss cooldown",
  gap_guard: "Overnight-gap guard",
  gross_exposure: "Gross-exposure cap",
  asset_class_cap: "Asset-class cap",
  correlation_cluster: "Correlation-cluster cap",
  per_symbol_cap: "Per-symbol cap",
  min_trade_size: "Below minimum trade size",
  circuit_breaker: "Circuit breaker",
  retail_mania: "Retail-mania guardrail",
  other: "Other guardrail",
};

export function labelBlock(cat: string): string {
  return BLOCK_LABEL[cat] ?? cat;
}

export function buildHeadline(s: {
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
