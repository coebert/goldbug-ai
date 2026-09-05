// Compute and persist per-symbol historical signal strength.
//
// Reads the same training dataset the decision model is fitted on, scores
// every historical row with the stored coefficients, then groups by symbol so
// each instrument gets its own track record. Results land in
// `symbol_signal_strength` so both the daily comparison view and the live
// decision prompt can read them cheaply (rebuilding the dataset per tick would
// be far too slow).

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildDataset } from "./dataset.server";
import { normaliseByDate } from "./fit";
import { FEATURE_KEYS } from "./features";
import { loadLatestModel } from "./model.server";
import {
  summariseSymbolStrength,
  type StrengthObservation,
  type SymbolStrength,
} from "./symbol-strength";
import {
  summariseMarketStrengths,
  type MarketStrength,
} from "./market-strength";
import { UNIVERSE } from "../universe.server";

export type { SymbolStrength } from "./symbol-strength";

function symbolKey(symbol: string): string {
  return (symbol.split(":")[0] ?? symbol).trim().toUpperCase().replace(/\.L$/, "");
}

export type ComputeStrengthResult = {
  ok: boolean;
  error?: string;
  horizonDays: number;
  rows: SymbolStrength[];
  from: string | null;
  to: string | null;
  /** True when a fitted model supplied the scores (otherwise raw outcomes only). */
  modelScored: boolean;
  /** Market × time-of-day cells measured from the same observations. */
  marketRows: MarketStrength[];
};

/**
 * Rebuild per-symbol strength from the account's full recorded history and
 * store it. Returns the rows it wrote, strongest first.
 */
export async function computeAndStoreSymbolStrengths(args: {
  userId: string;
  horizonDays?: number;
  realMoneyOnly?: boolean;
  historyYears?: number;
}): Promise<ComputeStrengthResult> {
  const horizonDays = args.horizonDays ?? 5;
  const empty: ComputeStrengthResult = {
    ok: false,
    horizonDays,
    rows: [],
    from: null,
    to: null,
    modelScored: false,
    marketRows: [],
  };

  const ds = await buildDataset({
    userId: args.userId,
    horizonDays,
    ...(args.realMoneyOnly == null ? {} : { realMoneyOnly: args.realMoneyOnly }),
    ...(args.historyYears == null ? {} : { historyYears: args.historyYears }),
  });
  if (ds.samples.length === 0) {
    return { ...empty, error: "No history to measure yet." };
  }

  const model = await loadLatestModel(args.userId);
  const coefs =
    model && model.coefficients.length === FEATURE_KEYS.length ? model.coefficients : null;

  const normalised = normaliseByDate(ds.samples, FEATURE_KEYS.length);
  const bySymbol = new Map<string, StrengthObservation[]>();
  const allObs: Array<StrengthObservation & { symbol: string; at?: string | null }> = [];
  for (const row of normalised) {
    // With no fitted model, fall back to the account's own measured bucket
    // proxy: the row's trend feature. Better than refusing to answer.
    const score = coefs
      ? row.z.reduce((a, z, i) => a + z * (coefs[i] ?? 0), 0)
      : (row.z[0] ?? 0);
    const list = bySymbol.get(row.symbol) ?? [];
    list.push({ date: row.date, score, y: row.y, w: row.w });
    bySymbol.set(row.symbol, list);
    allObs.push({ date: row.date, score, y: row.y, w: row.w, symbol: row.symbol, at: row.at ?? null });
  }

  const rows = [...bySymbol.entries()]
    .map(([symbol, obs]) => summariseSymbolStrength(symbol, obs))
    .sort((a, b) => b.strength - a.strength);

  const now = new Date().toISOString();
  const payload = rows.map((r) => ({
    user_id: args.userId,
    symbol: r.symbol,
    symbol_key: symbolKey(r.symbol),
    horizon_days: horizonDays,
    samples: r.samples,
    dates: r.dates,
    hit_rate: r.hitRate,
    mean_net_bps: r.meanNetBps,
    ic: r.ic,
    t_stat: r.tStat,
    strength: r.strength,
    from_date: r.from,
    to_date: r.to,
    computed_at: now,
    updated_at: now,
  }));

  // De-duplicate on the conflict key: several spellings of the same
  // instrument (AAPL / AAPL:xnas) collapse to one row.
  const deduped = new Map<string, (typeof payload)[number]>();
  for (const p of payload) {
    const k = p.symbol_key;
    const prev = deduped.get(k);
    if (!prev || p.samples > prev.samples) deduped.set(k, p);
  }

  const { error } = await supabaseAdmin
    .from("symbol_signal_strength")
    .upsert([...deduped.values()], { onConflict: "user_id,symbol_key,horizon_days" });

  // Same evidence, grouped by market and time of day: crypto, forex and
  // equities each get their own track record, split into London-time
  // sessions, so the AI can weight each market differently at different
  // hours. Rebuilt history rows (no timestamp) feed the all-day cells only.
  const assetClassBySymbol = new Map(
    UNIVERSE.map((u) => [u.symbol.toUpperCase(), u.asset_class as string]),
  );
  const marketRows = summariseMarketStrengths({ observations: allObs, assetClassBySymbol });
  const { error: marketError } = await supabaseAdmin.from("market_signal_strength").upsert(
    marketRows.map((r) => ({
      user_id: args.userId,
      market: r.market,
      session: r.session,
      horizon_days: horizonDays,
      samples: r.strength.samples,
      dates: r.strength.dates,
      hit_rate: r.strength.hitRate,
      mean_net_bps: r.strength.meanNetBps,
      ic: r.strength.ic,
      t_stat: r.strength.tStat,
      strength: r.strength.strength,
      from_date: r.strength.from,
      to_date: r.strength.to,
      computed_at: now,
      updated_at: now,
    })),
    { onConflict: "user_id,market,session,horizon_days" },
  );

  const firstError = error ?? marketError;
  return {
    ok: !firstError,
    ...(firstError ? { error: firstError.message } : {}),
    horizonDays,
    rows,
    from: ds.from,
    to: ds.to,
    modelScored: Boolean(coefs),
    marketRows,
  };
}

/** Stored market × session strengths, for cheap live lookups. */
export async function loadMarketStrengths(
  userId: string,
  horizonDays = 5,
): Promise<MarketStrength[]> {
  const { data } = await supabaseAdmin
    .from("market_signal_strength")
    .select("market, session, samples, dates, hit_rate, mean_net_bps, ic, t_stat, strength, from_date, to_date")
    .eq("user_id", userId)
    .eq("horizon_days", horizonDays);
  return (data ?? []).map((r) => ({
    market: r.market as MarketStrength["market"],
    session: r.session as MarketStrength["session"],
    strength: {
      symbol: `${r.market} ${r.session}`,
      samples: Number(r.samples) || 0,
      dates: Number(r.dates) || 0,
      hitRate: r.hit_rate == null ? null : Number(r.hit_rate),
      meanNetBps: r.mean_net_bps == null ? null : Number(r.mean_net_bps),
      ic: r.ic == null ? null : Number(r.ic),
      tStat: r.t_stat == null ? null : Number(r.t_stat),
      strength: Number(r.strength) || 0,
      from: r.from_date == null ? null : String(r.from_date),
      to: r.to_date == null ? null : String(r.to_date),
    },
  }));
}

/** Stored strengths keyed by base symbol, for cheap live lookups. */
export async function loadSymbolStrengths(
  userId: string,
  horizonDays = 5,
): Promise<Map<string, SymbolStrength>> {
  const out = new Map<string, SymbolStrength>();
  const { data } = await supabaseAdmin
    .from("symbol_signal_strength")
    .select("symbol, symbol_key, samples, dates, hit_rate, mean_net_bps, ic, t_stat, strength, from_date, to_date")
    .eq("user_id", userId)
    .eq("horizon_days", horizonDays);
  for (const r of data ?? []) {
    out.set(String(r.symbol_key), {
      symbol: String(r.symbol),
      samples: Number(r.samples) || 0,
      dates: Number(r.dates) || 0,
      hitRate: r.hit_rate == null ? null : Number(r.hit_rate),
      meanNetBps: r.mean_net_bps == null ? null : Number(r.mean_net_bps),
      ic: r.ic == null ? null : Number(r.ic),
      tStat: r.t_stat == null ? null : Number(r.t_stat),
      strength: Number(r.strength) || 0,
      from: r.from_date == null ? null : String(r.from_date),
      to: r.to_date == null ? null : String(r.to_date),
    });
  }
  return out;
}

export { symbolKey as strengthSymbolKey };
