// Data layer for the policy-nudge replay: pull the daily tape for the symbols
// tracked policy makers actually move, plus the cached headline archive, and
// hand both to the pure replay engine.

import { getDailyCandlesRange, type Candle } from "@/lib/market-data.server";
import { TRACKED_POLICY_MAKERS, type PolicyRow } from "@/lib/policy-makers";
import {
  runPolicyNudgeReplay,
  type PolicyNudgeReplayResult,
  type PolicyReplayParams,
} from "./policy-nudge-replay";
import { runPolicyNudgeSweep, type PolicySweepResult } from "./policy-nudge-sweep";

export type PolicyReplayRequest = {
  symbols?: string[];
  /** Calendar days of history to replay (365-900). */
  lookbackDays?: number;
  params?: Partial<PolicyReplayParams>;
};

/** Every symbol at least one tracked policy maker is mapped to, deduped. */
export const POLICY_UNIVERSE: string[] = [
  ...new Set(TRACKED_POLICY_MAKERS.flatMap((m) => m.symbols)),
].sort();

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Page the headline archive — two years of news exceeds a single 1k page. */
async function loadNews(
  supabase: { from: (t: string) => any },
  from: string,
  to: string,
): Promise<PolicyRow[]> {
  const rows: PolicyRow[] = [];
  const page = 1000;
  for (let offset = 0; offset < 20_000; offset += page) {
    const { data, error } = await supabase
      .from("news_cache")
      .select("news_date, source, headline, url, summary, sentiment")
      .gte("news_date", from)
      .lte("news_date", to)
      .order("news_date", { ascending: false })
      .range(offset, offset + page - 1);
    if (error) break;
    const batch = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of batch) {
      rows.push({
        headline: (r["headline"] as string) ?? "",
        summary: (r["summary"] as string | null) ?? null,
        source: (r["source"] as string | null) ?? null,
        url: (r["url"] as string | null) ?? null,
        date: ((r["news_date"] as string) ?? "").slice(0, 10) || null,
        sentiment: r["sentiment"] == null ? null : Number(r["sentiment"]),
      });
    }
    if (batch.length < page) break;
  }
  return rows;
}

/** Tape + headline archive for a replay window, shared by replay and sweep. */
async function loadReplayInputs(
  supabase: { from: (t: string) => any },
  req: PolicyReplayRequest,
): Promise<{ prices: Map<string, Candle[]>; news: PolicyRow[] }> {
  const symbols = (req.symbols?.length ? req.symbols : POLICY_UNIVERSE).map((s) =>
    s.trim().toUpperCase(),
  );
  const lookbackDays = Math.max(365, Math.min(900, req.lookbackDays ?? 730));

  const to = iso(new Date());
  // Extra warm-up so the 50-day average exists on the first replayed bar.
  const from = iso(new Date(Date.now() - (lookbackDays + 90) * 86_400_000));
  const newsFrom = iso(new Date(Date.now() - (lookbackDays + 10) * 86_400_000));

  const prices = new Map<string, Candle[]>();
  const loadTape = async (sym: string) => {
    try {
      const c = await getDailyCandlesRange(sym, from, to);
      if (c.length > 0) prices.set(sym, c);
    } catch (err) {
      console.error(`policy-nudge-replay: tape failed for ${sym}`, err);
    }
  };
  for (let i = 0; i < symbols.length; i += 4) {
    await Promise.all(symbols.slice(i, i + 4).map(loadTape));
  }

  const news = await loadNews(supabase, newsFrom, to);
  return { prices, news };
}

export async function runPolicyReplay(
  supabase: { from: (t: string) => any },
  req: PolicyReplayRequest = {},
): Promise<PolicyNudgeReplayResult> {
  const { prices, news } = await loadReplayInputs(supabase, req);
  return runPolicyNudgeReplay({ prices, news, params: req.params ?? {} });
}

export type PolicySweepRequest = PolicyReplayRequest & {
  nudgeScales?: number[];
  regimeGains?: number[];
};

/** Sensitivity grid over nudge strength × regime-scaling gain, one tape load. */
export async function runPolicySweep(
  supabase: { from: (t: string) => any },
  req: PolicySweepRequest = {},
): Promise<PolicySweepResult> {
  const { prices, news } = await loadReplayInputs(supabase, req);
  return runPolicyNudgeSweep({
    prices,
    news,
    params: req.params ?? {},
    nudgeScales: req.nudgeScales,
    regimeGains: req.regimeGains,
  });
}
