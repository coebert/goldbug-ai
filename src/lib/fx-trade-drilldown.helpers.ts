// Runtime helpers extracted from fx-trade-drilldown.functions.ts.
// Server-function modules get split during the build, so module-scope code that
// sits next to the exported createServerFn declarations can vanish from the
// generated bundle and fail at runtime. Keeping it in a plain module avoids that.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type FxTradeDrilldownLeg = {
  triggeredBySymbol: string | null;
  fromCcy: string | null;
  toCcy: string | null;
  amountFrom: number | null;
  amountTo: number | null;
  rate: number | null;
  stale: boolean | null;
  createdAt: string;
};

export type FxTradeDrilldownDecision = {
  decisionId: string | null;
  asOf: string | null;
  createdAt: string;
  /** Base→broker capture recorded at the start of the tick, if any. */
  capture: {
    pair: string;
    rate: number | null;
    source: string | null;
    stale: boolean | null;
  } | null;
  legs: FxTradeDrilldownLeg[];
};

export type FxTradeDrilldown = {
  requestedAt: string;
  decisions: FxTradeDrilldownDecision[];
};

export type LogRow = {
  created_at: string;
  method: string;
  path: string | null;
  request: unknown;
  response: unknown;
};

export function getStr(o: unknown, k: string): string | null {
  if (o && typeof o === "object" && k in (o as Record<string, unknown>)) {
    const v = (o as Record<string, unknown>)[k];
    return typeof v === "string" ? v : null;
  }
  return null;
}

export function getNum(o: unknown, k: string): number | null {
  if (o && typeof o === "object" && k in (o as Record<string, unknown>)) {
    const v = (o as Record<string, unknown>)[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return null;
}

export function getBool(o: unknown, k: string): boolean | null {
  if (o && typeof o === "object" && k in (o as Record<string, unknown>)) {
    const v = (o as Record<string, unknown>)[k];
    return typeof v === "boolean" ? v : null;
  }
  return null;
}
