// Automated price/unit scaling auditor.
//
// This module is the *pure* detector — no I/O, no server bindings. Callers
// pass a normalised bundle of {holding, latest_close, price_history,
// canonical_asset_class} and get back a list of findings. The server fn in
// `price-scaling-audit.functions.ts` handles the I/O and passes rows here.
//
// It exists because unit mixing (GBX vs GBP, ETF-vs-stock miscategorisation,
// stock-split unnoticed) has caused P&L-tile bugs before (see the 2026-07-28
// VUKE/VMID incident). Any future symbol added to the universe or ingested
// from the broker must be scanned automatically, on every admin refresh.

import type { AssetClass } from "@/lib/universe.server";
import { isLsePenceQuoted } from "@/lib/market-price-units";

// ────────────────────────────────────────────────────────────────────────
// Plausible-range envelopes.
//
// These are intentionally *loose* — the auditor is looking for order-of-
// magnitude mistakes (100x scaling from GBX/GBP confusion, 10x from stock
// splits), not micro-drift. Anything outside these envelopes for the
// declared unit is a scaling anomaly worth surfacing.

const RANGES = {
  // LSE common stocks quoted in GBX (pence). Real-world FTSE prices span
  // ~10p (small caps) through ~10,000p (Berkeley Group). Values in £s
  // (0.01–100) after a phantom /100 would still fall inside — this range
  // catches the *other* direction: an already-normalised GBP figure
  // sneaking back in as if it were GBX.
  lseStockGbx: { min: 5, max: 50_000 }, // pence
  // LSE ETFs / ETCs / ETNs quote in GBP directly (£3–£500 typical).
  lseEtfGbp: { min: 0.5, max: 2_000 },
  // Generic "reasonable price" for anything else. Splits/reverse-splits
  // are caught by the ratio check below rather than this envelope.
  genericFinite: { min: 0.0001, max: 1_000_000 },
} as const;

export type ScalingFinding = {
  symbol: string;
  portfolio_id: string | null;
  portfolio_name: string | null;
  category:
    | "asset_class_mismatch"
    | "asset_class_missing"
    | "lse_stock_out_of_gbx_range"
    | "lse_etf_out_of_gbp_range"
    | "price_ratio_jump"
    | "non_finite_price"
    | "non_positive_price";
  severity: "warning" | "error";
  detail: string;
  observed: {
    price: number | null;
    avg_cost: number | null;
    quantity: number | null;
    asset_class: string | null;
    canonical_asset_class: AssetClass | null;
    historical_median: number | null;
    ratio: number | null;
  };
};

export type HoldingScanRow = {
  portfolio_id: string | null;
  portfolio_name: string | null;
  symbol: string;
  asset_class: string | null;
  quantity: number | null;
  avg_cost: number | null;
  latest_close: number | null;
  price_history: number[]; // recent daily closes, oldest → newest
  canonical_asset_class: AssetClass | null;
};

/**
 * Ratio jumps larger than this vs the historical median almost always mean
 * a split/reverse-split (or a GBX-scaled price landing in a GBP cache row).
 * 20x is comfortably above dividend or spin-off adjustment noise.
 */
const RATIO_JUMP_THRESHOLD = 20;

function median(xs: number[]): number | null {
  const clean = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 1 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function inRange(x: number, r: { min: number; max: number }): boolean {
  return x >= r.min && x <= r.max;
}

export function auditHoldingScalings(rows: HoldingScanRow[]): ScalingFinding[] {
  const findings: ScalingFinding[] = [];

  for (const r of rows) {
    const price = r.latest_close ?? r.avg_cost ?? null;
    const declaredAc = (r.asset_class ?? "").toLowerCase();
    const canonicalAc = r.canonical_asset_class;
    const isLse = isLsePenceQuoted(r.symbol);
    const hist = median(r.price_history);

    // 1. Missing asset_class on a live holding — impossible to normalise
    // GBX↔GBP without it. This must never happen; treat as error.
    if (!declaredAc && (r.quantity ?? 0) > 0) {
      findings.push({
        symbol: r.symbol,
        portfolio_id: r.portfolio_id,
        portfolio_name: r.portfolio_name,
        category: "asset_class_missing",
        severity: "error",
        detail: `Holding for ${r.symbol} has no asset_class set; normalisation cannot decide GBX vs GBP.`,
        observed: obs(r, hist, null),
      });
    }

    // 2. Declared asset_class disagrees with the canonical universe entry.
    // Almost always means a broker/ingest classified an ETF as a stock,
    // which then trips the GBX/100 divide for a GBP-priced ETF.
    if (declaredAc && canonicalAc && declaredAc !== canonicalAc) {
      findings.push({
        symbol: r.symbol,
        portfolio_id: r.portfolio_id,
        portfolio_name: r.portfolio_name,
        category: "asset_class_mismatch",
        severity: "error",
        detail: `Holding declares asset_class="${declaredAc}" but universe says "${canonicalAc}".`,
        observed: obs(r, hist, null),
      });
    }

    // 3. Non-finite / non-positive prices — safe-fail everywhere but
    // signals a broken feed we should be told about.
    if (price != null) {
      if (!Number.isFinite(price)) {
        findings.push({
          symbol: r.symbol, portfolio_id: r.portfolio_id, portfolio_name: r.portfolio_name,
          category: "non_finite_price", severity: "error",
          detail: `Latest price for ${r.symbol} is not finite (NaN/Infinity).`,
          observed: obs(r, hist, null),
        });
      } else if (price <= 0) {
        findings.push({
          symbol: r.symbol, portfolio_id: r.portfolio_id, portfolio_name: r.portfolio_name,
          category: "non_positive_price", severity: "error",
          detail: `Latest price for ${r.symbol} is <= 0 (${price}).`,
          observed: obs(r, hist, null),
        });
      }
    }

    // 4. LSE envelope checks — only when price is finite and positive.
    if (price != null && Number.isFinite(price) && price > 0 && isLse) {
      const effectiveAc = canonicalAc ?? (declaredAc as AssetClass | "" | null);
      const treatAsEtf = effectiveAc === "etf" || effectiveAc === "commodity" || effectiveAc === "crypto";
      if (treatAsEtf) {
        // LSE ETFs quote in GBP. A price landing in the pence range (>~500)
        // is almost certainly a raw GBX value that missed normalisation.
        if (!inRange(price, RANGES.lseEtfGbp)) {
          findings.push({
            symbol: r.symbol, portfolio_id: r.portfolio_id, portfolio_name: r.portfolio_name,
            category: "lse_etf_out_of_gbp_range", severity: "warning",
            detail:
              price > RANGES.lseEtfGbp.max
                ? `${r.symbol} (LSE ETF) price ${price} is outside GBP range ${RANGES.lseEtfGbp.min}–${RANGES.lseEtfGbp.max}; suspect raw GBX not normalised.`
                : `${r.symbol} (LSE ETF) price ${price} is unusually small for a GBP ETF.`,
            observed: obs(r, hist, null),
          });
        }
      } else {
        // LSE common stocks quote in GBX. A price landing in single-pounds
        // (say < 5p) is almost certainly a phantom /100 already applied.
        if (!inRange(price, RANGES.lseStockGbx)) {
          findings.push({
            symbol: r.symbol, portfolio_id: r.portfolio_id, portfolio_name: r.portfolio_name,
            category: "lse_stock_out_of_gbx_range", severity: "warning",
            detail:
              price < RANGES.lseStockGbx.min
                ? `${r.symbol} (LSE stock) price ${price} is below GBX range; suspect double-normalisation to GBP.`
                : `${r.symbol} (LSE stock) price ${price} is above GBX range ${RANGES.lseStockGbx.min}–${RANGES.lseStockGbx.max}.`,
            observed: obs(r, hist, null),
          });
        }
      }
    }

    // 5. Ratio jump vs historical median — catches splits and cache-
    // corruption where a single row landed in the wrong unit.
    if (price != null && Number.isFinite(price) && price > 0 && hist != null && hist > 0) {
      const ratio = price / hist;
      if (ratio >= RATIO_JUMP_THRESHOLD || ratio <= 1 / RATIO_JUMP_THRESHOLD) {
        findings.push({
          symbol: r.symbol, portfolio_id: r.portfolio_id, portfolio_name: r.portfolio_name,
          category: "price_ratio_jump", severity: "warning",
          detail:
            `${r.symbol} latest price ${price} is ${ratio.toFixed(1)}x the ${r.price_history.length}-day ` +
            `median (${hist}). Likely split/reverse-split or a unit-scale bug in the cache.`,
          observed: obs(r, hist, ratio),
        });
      }
    }
  }

  return findings;
}

function obs(
  r: HoldingScanRow,
  hist: number | null,
  ratio: number | null,
): ScalingFinding["observed"] {
  return {
    price: r.latest_close ?? null,
    avg_cost: r.avg_cost ?? null,
    quantity: r.quantity ?? null,
    asset_class: r.asset_class ?? null,
    canonical_asset_class: r.canonical_asset_class ?? null,
    historical_median: hist,
    ratio,
  };
}
