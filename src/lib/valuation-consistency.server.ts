// Server driver for the valuation consistency check.
//
// Reads the stored snapshot series, finds implausible day-over-day jumps, and
// builds a price-unit audit for the offending days so the report can name the
// exact quote responsible.

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildPriceUnitAudit } from "./price-unit-audit.server";
import type { PriceUnitAudit } from "./price-unit-audit";
import { ukDayKey } from "./uk-time";
import {
  checkValuationConsistency,
  DEFAULT_GAP_WEEKDAYS,
  DEFAULT_JUMP_FACTOR,
  type ConsistencySnapshot,
  type ValuationConsistencyReport,
} from "./valuation-consistency";

export type ValuationConsistencyResult = ValuationConsistencyReport & { error?: string };

/** Audit at most this many suspect days per run — each one hits price_cache. */
const MAX_AUDITED_DAYS = 3;

export async function runValuationConsistencyCheck(
  supabase: SupabaseClient,
  portfolioId: string,
  options: { jumpFactor?: number; lookbackDays?: number; gapWeekdays?: number } = {},
): Promise<ValuationConsistencyResult> {
  const jumpFactor = options.jumpFactor ?? DEFAULT_JUMP_FACTOR;
  const gapWeekdays = options.gapWeekdays ?? DEFAULT_GAP_WEEKDAYS;
  const today = ukDayKey(new Date());
  const lookback = options.lookbackDays ?? 180;
  const since = new Date(Date.now() - lookback * 86_400_000).toISOString().slice(0, 10);

  const [{ data: portfolio }, { data: snapshotRows }] = await Promise.all([
    supabase.from("portfolios").select("id, currency").eq("id", portfolioId).maybeSingle(),
    supabase
      .from("equity_snapshots")
      .select("snapshot_date, cash, holdings_value, total_value")
      .eq("portfolio_id", portfolioId)
      .gte("snapshot_date", since)
      .order("snapshot_date", { ascending: true }),
  ]);

  const base = String((portfolio as { currency?: string | null } | null)?.currency ?? "GBP");
  const snapshots = (snapshotRows ?? []) as ConsistencySnapshot[];

  if (!portfolio) {
    return {
      portfolio_id: portfolioId,
      base_ccy: base.toUpperCase(),
      daysChecked: 0,
      threshold: jumpFactor,
      jumps: [],
      worst: null,
      gaps: [],
      gapThreshold: gapWeekdays,
      error: "portfolio not found",
    };
  }

  // First pass with no audits: cheap, and tells us which days to audit.
  const firstPass = checkValuationConsistency({
    portfolioId,
    snapshots,
    baseCcy: base,
    jumpFactor,
    gapWeekdays,
    today,
  });
  // Continuity faults are reported even when every ratio is plausible.
  if (firstPass.jumps.length === 0) return firstPass;

  const days = [...firstPass.jumps]
    .sort((a, b) => Math.max(b.ratio, 1 / b.ratio) - Math.max(a.ratio, 1 / a.ratio))
    .slice(0, MAX_AUDITED_DAYS)
    .map((j) => j.date);

  const audits: Record<string, PriceUnitAudit | null> = {};
  for (const date of days) {
    try {
      audits[date] = await buildPriceUnitAudit(supabase, portfolioId, date);
    } catch {
      audits[date] = null;
    }
  }

  return checkValuationConsistency({
    portfolioId,
    snapshots,
    audits,
    baseCcy: base,
    jumpFactor,
    gapWeekdays,
    today,
  });
}
