// Region-aware earnings-event thresholds.
//
// The blackout defaults (veto 2d, haircut 5d) were fitted on US names, where
// companies report quarterly and the scheduled date is reliable. Outside the
// US the same numbers quietly stop big European and Japanese ideas from ever
// trading:
//
//   * European and Japanese issuers report half-yearly or quarterly with much
//     longer confirmation lead times, so the provider date is usually an
//     estimate that sits inside the haircut window for weeks;
//   * pre-print drift is smaller than in the US, so a five-day haircut costs
//     more edge than it saves.
//
// So the window is tightened outside the US, never widened, and exits are
// still never gated. Pure module.

import { marketRegion, type MarketRegion } from "../market-region";
import { DEFAULT_HAIRCUT_DAYS, DEFAULT_VETO_DAYS } from "./earnings-gate";

export type EarningsThresholds = {
  region: MarketRegion;
  vetoDays: number;
  haircutDays: number;
};

export function earningsThresholdsForRegion(region: MarketRegion): EarningsThresholds {
  switch (region) {
    case "japan":
      return { region, vetoDays: 1, haircutDays: 2 };
    case "europe":
    case "uk":
      return { region, vetoDays: 1, haircutDays: 3 };
    case "apac":
      return { region, vetoDays: 1, haircutDays: 3 };
    default:
      return { region, vetoDays: DEFAULT_VETO_DAYS, haircutDays: DEFAULT_HAIRCUT_DAYS };
  }
}

export function earningsThresholdsFor(symbol: string | null | undefined): EarningsThresholds {
  return earningsThresholdsForRegion(marketRegion(symbol));
}
