// Daily valuation drift reconciliation.
//
// The gate stops implausible snapshots at write time, but a snapshot can also
// go stale: the holdings or FX rates behind it change while the stored row does
// not. This job recomputes each portfolio's latest snapshot from source data
// and reports the difference, so drift surfaces as an alert instead of as a
// number someone happens to notice on a tile.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { valuePortfolioHoldings } from "./value-holdings.server";
import type { KernelHolding } from "./kernel";

/** Relative gap above which a stored snapshot is considered drifted. */
export const DRIFT_WARN_PCT = 0.005; // 0.5%
export const DRIFT_ALERT_PCT = 0.02; // 2%

type PortfolioRow = {
  id: string;
  name: string | null;
  base_currency: string | null;
  cash: number | null;
};

type SnapshotRow = { snapshot_date: string; total_value: number | null };

type HoldingRow = { symbol: string };

export type DriftRow = {
  portfolioId: string;
  portfolioName: string;
  snapshotDate: string;
  storedTotal: number;
  recomputedTotal: number;
  diff: number;
  diffPct: number;
  severity: "ok" | "warn" | "alert";
  degraded: boolean;
  reasons: string[];
};

export function classifyDrift(storedTotal: number, recomputedTotal: number): {
  diff: number;
  diffPct: number;
  severity: DriftRow["severity"];
} {
  const diff = recomputedTotal - storedTotal;
  const denom = Math.abs(storedTotal) > 1e-9 ? Math.abs(storedTotal) : Math.abs(recomputedTotal);
  const diffPct = denom > 1e-9 ? Math.abs(diff) / denom : 0;
  const severity: DriftRow["severity"] =
    diffPct >= DRIFT_ALERT_PCT ? "alert" : diffPct >= DRIFT_WARN_PCT ? "warn" : "ok";
  return { diff, diffPct, severity };
}

/** Recompute the latest snapshot for every portfolio and report the drift. */
export async function reconcileValuationDrift(): Promise<DriftRow[]> {
  const { data: portfolios } = await supabaseAdmin
    .from("portfolios")
    .select("id, name, base_currency, cash");

  const out: DriftRow[] = [];

  for (const p of (portfolios ?? []) as unknown as PortfolioRow[]) {
    const portfolioId = String(p.id);
    const base = String(p.base_currency ?? "GBP").toUpperCase();

    const { data: snap } = await supabaseAdmin
      .from("equity_snapshots")
      .select("snapshot_date, total_value")
      .eq("portfolio_id", portfolioId)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!snap) continue;
    const snapshot = snap as unknown as SnapshotRow;

    const { data: holdings } = await supabaseAdmin
      .from("holdings")
      .select("symbol, quantity, avg_cost, instrument_ccy, asset_class")
      .eq("portfolio_id", portfolioId);

    const symbols = [...new Set(((holdings ?? []) as unknown as HoldingRow[]).map((h) => String(h.symbol)))];
    const prices = new Map<string, number>();
    if (symbols.length > 0) {
      const { getPriceOn } = await import("@/lib/market-data.server");
      const { normalizeMarketPriceForTrading } = await import("@/lib/market-price-units");
      await Promise.all(
        symbols.map(async (sym) => {
          try {
            const raw = await getPriceOn(sym, String(snapshot.snapshot_date));
            if (raw != null) {
              prices.set(sym, normalizeMarketPriceForTrading(sym, raw));
            }
          } catch {
            /* leave unpriced — the kernel flags it */
          }
        }),
      );
    }

    const res = await valuePortfolioHoldings({
      holdings: (holdings ?? []) as unknown as KernelHolding[],
      normalizedPrices: prices,
      wallet: { [base]: Number(p.cash ?? 0) },
      baseCcy: base,
      asOf: String(snapshot.snapshot_date),
    });

    const stored = Number(snapshot.total_value ?? 0);
    const { diff, diffPct, severity } = classifyDrift(stored, res.totalValue);

    out.push({
      portfolioId,
      portfolioName: String(p.name ?? "Portfolio"),
      snapshotDate: String(snapshot.snapshot_date),
      storedTotal: stored,
      recomputedTotal: res.totalValue,
      diff,
      diffPct,
      severity,
      degraded: res.provenance.degraded,
      reasons: [...new Set(res.provenance.warnings.map((w) => w.code))],
    });
  }

  // Persist anything worth a human look. Clean runs write nothing so the table
  // stays a list of real problems rather than a log.
  const notable = out.filter((r) => r.severity !== "ok");
  if (notable.length > 0) {
    try {
      await supabaseAdmin.from("valuation_write_rejections").insert(
        notable.map((r) => ({
          portfolio_id: r.portfolioId,
          snapshot_date: r.snapshotDate,
          reason: `drift_${r.severity}`,
          source: "reconcile_drift",
          attempted: JSON.parse(JSON.stringify(r)),
          violations: JSON.parse(JSON.stringify(r.reasons)),
        })),
      );
    } catch {
      /* reporting must never fail the job */
    }
  }

  return out;
}
