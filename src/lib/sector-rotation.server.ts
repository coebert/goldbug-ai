// Sector rotation scoring. Uses SPDR sector ETFs as sector proxies, computes
// 30d and 90d momentum, ranks them, and persists to sector_scores. Symbols in
// our universe are mapped to sectors so the engine can boost/penalise buys.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getDailyCandles, pctChange } from "./market-data.server";

const SECTOR_ETFS: Array<{ sector: string; etf: string }> = [
  { sector: "technology", etf: "XLK" },
  { sector: "financials", etf: "XLF" },
  { sector: "healthcare", etf: "XLV" },
  { sector: "energy", etf: "XLE" },
  { sector: "consumer_discretionary", etf: "XLY" },
  { sector: "consumer_staples", etf: "XLP" },
  { sector: "industrials", etf: "XLI" },
  { sector: "materials", etf: "XLB" },
  { sector: "utilities", etf: "XLU" },
  { sector: "real_estate", etf: "XLRE" },
  { sector: "communications", etf: "XLC" },
];

const SYMBOL_TO_SECTOR: Record<string, string> = {
  AAPL: "technology", MSFT: "technology", GOOGL: "communications", META: "communications",
  NVDA: "technology", AMZN: "consumer_discretionary", TSLA: "consumer_discretionary",
  JPM: "financials", V: "financials", HSBA: "financials",
  JNJ: "healthcare", AZN: "healthcare",
  BP: "energy", "BP.L": "energy",
  VOD: "communications", ULVR: "consumer_staples",
  "VOD.L": "communications", "AZN.L": "healthcare", "HSBA.L": "financials", "ULVR.L": "consumer_staples",
  QQQ: "technology", SPY: "financials", VTI: "financials", ISF: "financials", "ISF.L": "financials",
};

export function symbolSector(symbol: string): string | null {
  const key = symbol.toUpperCase();
  return SYMBOL_TO_SECTOR[key] ?? SYMBOL_TO_SECTOR[key.split(".")[0]] ?? null;
}

export type SectorScore = {
  sector: string;
  etf: string;
  momentum_30d: number | null;
  momentum_90d: number | null;
  score: number;
  rank: number;
};

export async function refreshSectorScores(asOf: string): Promise<SectorScore[]> {
  const rows: SectorScore[] = [];
  await Promise.all(
    SECTOR_ETFS.map(async ({ sector, etf }) => {
      try {
        const candles = await getDailyCandles(etf, 120, asOf);
        if (candles.length < 30) return;
        const closes = candles.map((c) => c.close);
        const m30 = pctChange(closes, 30);
        const m90 = pctChange(closes, 90) ?? m30;
        const score = (m30 ?? 0) * 0.7 + (m90 ?? 0) * 0.3;
        rows.push({ sector, etf, momentum_30d: m30, momentum_90d: m90, score, rank: 0 });
      } catch {
        /* ignore individual sector failures */
      }
    }),
  );
  rows.sort((a, b) => b.score - a.score);
  rows.forEach((r, i) => (r.rank = i + 1));

  const persist = rows.map((r) => ({
    sector: r.sector,
    etf_symbol: r.etf,
    momentum_30d: r.momentum_30d,
    momentum_90d: r.momentum_90d,
    score: r.score,
    rank: r.rank,
    as_of: asOf,
  }));
  if (persist.length > 0) {
    await supabaseAdmin
      .from("sector_scores")
      .upsert(persist, { onConflict: "sector,as_of" });
  }
  return rows;
}

export function sectorSizeMultiplier(sector: string | null, scores: SectorScore[]): { mult: number; note: string } {
  if (!sector || scores.length === 0) return { mult: 1, note: "" };
  const s = scores.find((x) => x.sector === sector);
  if (!s) return { mult: 1, note: "" };
  const n = scores.length;
  if (s.rank <= Math.max(1, Math.floor(n / 3))) return { mult: 1.1, note: `sector ${sector} top-tercile ×1.10` };
  if (s.rank > n - Math.max(1, Math.floor(n / 3))) return { mult: 0.7, note: `sector ${sector} bottom-tercile ×0.70` };
  return { mult: 1, note: "" };
}
