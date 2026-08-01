// Server driver for the bulk `instrument_ccy` correction.
//
// Re-runs the consistency check (so the plan is always computed from live
// data, never from a stale client payload), plans the safe corrections, and
// writes them back scoped to the requested portfolio.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  planInstrumentCcyFixes,
  type InstrumentCcyFixPlan,
  type InstrumentCcyFixPlanItem,
} from "./instrument-ccy-fix";
import { runInstrumentCcyCheck } from "./instrument-ccy-check.server";

export type InstrumentCcyFixResult = InstrumentCcyFixPlan & {
  portfolio_id: string;
  /** Rows actually written; empty in dry-run mode. */
  applied: InstrumentCcyFixPlanItem[];
  dry_run: boolean;
  errors: { symbol: string; message: string }[];
};

export async function applyInstrumentCcyFixesForPortfolio(
  supabase: SupabaseClient,
  portfolioId: string,
  options: { dryRun?: boolean; symbols?: string[] } = {},
): Promise<InstrumentCcyFixResult> {
  const dryRun = options.dryRun ?? false;
  const report = await runInstrumentCcyCheck(supabase, portfolioId);
  const plan = planInstrumentCcyFixes(report.findings);

  const wanted = options.symbols?.length
    ? new Set(options.symbols.map((s) => s.trim().toUpperCase()))
    : null;
  const targets = wanted
    ? plan.fixes.filter((f) => wanted.has(f.symbol.toUpperCase()))
    : plan.fixes;

  const applied: InstrumentCcyFixPlanItem[] = [];
  const errors: { symbol: string; message: string }[] = [];

  if (!dryRun) {
    for (const fix of targets) {
      const { error } = await supabase
        .from("holdings")
        .update({ instrument_ccy: fix.to_ccy })
        .eq("portfolio_id", portfolioId)
        .eq("symbol", fix.symbol);
      if (error) errors.push({ symbol: fix.symbol, message: error.message });
      else applied.push(fix);
    }
  }

  return {
    ...plan,
    fixes: targets,
    portfolio_id: portfolioId,
    applied,
    dry_run: dryRun,
    errors,
  };
}
