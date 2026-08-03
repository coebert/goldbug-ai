// Runtime helpers extracted from backfill-holdings-history.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { buildHoldingSeries } from "@/lib/build-holding-series";
import {
  auditHoldingSeriesBatch,
  formatIssue,
  type SeriesSanityIssue,
} from "@/lib/holdings-series-sanity";

export const MIC_TO_YAHOO: Record<string, string> = {
  xlon: "L", xetr: "DE", xpar: "PA", xams: "AS", xmil: "MI",
  xmad: "MC", xswx: "SW", xtse: "TO", xhkg: "HK", xtks: "T",
  xasx: "AX", xsto: "ST", xcse: "CO", xhel: "HE", xose: "OL",
  xnas: "", xnys: "", arcx: "", bats: "",
};

export function resolveYahoo(sym: string): string {
  const colon = sym.lastIndexOf(":");
  if (colon < 0) return sym;
  const base = sym.slice(0, colon);
  const mic = sym.slice(colon + 1).toLowerCase();
  const yahoo = MIC_TO_YAHOO[mic];
  if (yahoo == null) return sym;
  return yahoo ? `${base}.${yahoo}` : base;
}

export type BackfillReport = {
  portfoliosScanned: number;
  holdingsScanned: number;
  symbolsRefreshed: number;
  symbolsFailed: number;
  seriesBuilt: number;
  issues: SeriesSanityIssue[];
  perSymbol: Array<{ symbol: string; refreshed: boolean; error?: string; days: number }>;
};
