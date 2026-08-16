// Data layer for the thesis-break impact row: load the daily tape plus the
// real news/insider/fundamentals evidence, replay the same tape with the exit
// layer off and on, and reduce it to the compact impact summary the card shows.

import { fetchUniverseHistory } from "@/lib/real-market-tape.server";
import { loadRealEvidenceTape } from "./thesis-break-evidence.server";
import type { EvidenceNewsRow } from "./thesis-break-evidence";
import { replayArm, splitFiringsByHistory, type ReplayTape } from "./thesis-break-replay";
import { computeThesisBreakImpact, type ThesisImpactResult } from "./thesis-break-impact";

export type { ThesisImpactResult };

export const THESIS_IMPACT_UNIVERSE = [
  "AAPL",
  "MKS.L",
  "MSFT",
  "NVDA",
  "JPM",
  "TSCO.L",
  "BP.L",
  "TSLA",
];

const iso = (d: Date) => d.toISOString().slice(0, 10);

async function loadNews(
  supabase: { from: (t: string) => any },
  from: string,
  to: string,
): Promise<EvidenceNewsRow[]> {
  const rows: EvidenceNewsRow[] = [];
  const page = 1000;
  for (let offset = 0; offset < 10_000; offset += page) {
    const { data, error } = await supabase
      .from("news_cache")
      .select("news_date, headline, summary, sentiment")
      .gte("news_date", from)
      .lte("news_date", to)
      .not("sentiment", "is", null)
      .order("news_date", { ascending: false })
      .range(offset, offset + page - 1);
    if (error) break;
    const batch = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of batch) {
      rows.push({
        headline: (r["headline"] as string) ?? "",
        summary: (r["summary"] as string | null) ?? null,
        sentiment: r["sentiment"] == null ? null : String(r["sentiment"]),
        date: ((r["news_date"] as string) ?? "").slice(0, 10) || null,
      });
    }
    if (batch.length < page) break;
  }
  return rows;
}

export type ThesisImpactRequest = {
  symbols?: string[];
  /** Calendar days of price history to replay (warm-up included). */
  lookbackDays?: number;
};

export async function runThesisBreakImpact(
  supabase: { from: (t: string) => any },
  req: ThesisImpactRequest = {},
): Promise<ThesisImpactResult> {
  const symbols = (req.symbols?.length ? req.symbols : THESIS_IMPACT_UNIVERSE).map((s) =>
    s.toUpperCase(),
  );
  const to = iso(new Date());
  const lookback = Math.min(900, Math.max(180, req.lookbackDays ?? 360));
  const from = iso(new Date(Date.now() - lookback * 86_400_000));

  const histories = await fetchUniverseHistory(symbols, { from, to });
  const tape: ReplayTape = {};
  for (const h of histories) {
    const bars = h.bars
      .filter((b) => Number.isFinite(b.close) && b.close > 0)
      .map((b) => ({ date: b.date, close: (b.adjClose ?? b.close) as number }));
    if (bars.length > 60) tape[h.symbol] = bars;
  }
  const loaded = Object.keys(tape);
  if (loaded.length === 0) throw new Error("No price history available for the replay universe");
  const dates = [...new Set(loaded.flatMap((s) => tape[s]!.map((b) => b.date)))].sort();

  const news = await loadNews(supabase, dates[0] ?? from, to);
  const evidence = await loadRealEvidenceTape({ symbols: loaded, dates, news, asOf: to });

  const base = replayArm(tape, { thesisBreak: false });
  const withLayer = replayArm(tape, { thesisBreak: true, evidence });
  const firing = splitFiringsByHistory(withLayer.trades);

  return {
    ...computeThesisBreakImpact(base, withLayer, firing),
    symbols: loaded,
    from: dates[0] ?? from,
    to,
    evidenceFrom: evidence.from ?? null,
    evidenceTo: evidence.to ?? null,
  };
}
