import { getDailyCandles } from "@/lib/market-data.server";
import { UNIVERSE } from "@/lib/universe.server";
import { evaluateSetup, RECLAIM_SCAN_RULES, type SetupMatch } from "@/lib/setup-scan";

/**
 * High-volatility names outside the tradable universe that fit the archetype's
 * habitat (AI infrastructure, recent IPOs, heavily shorted momentum). Scanned
 * for monitoring even where position sizing would stay small.
 */
const HIGH_VOL_CANDIDATES: { symbol: string; name: string }[] = [
  { symbol: "CRWV", name: "CoreWeave" },
  { symbol: "NBIS", name: "Nebius Group" },
  { symbol: "SMCI", name: "Super Micro Computer" },
  { symbol: "MSTR", name: "MicroStrategy" },
  { symbol: "COIN", name: "Coinbase" },
  { symbol: "PLTR", name: "Palantir" },
  { symbol: "MARA", name: "MARA Holdings" },
  { symbol: "RIOT", name: "Riot Platforms" },
  { symbol: "AFRM", name: "Affirm" },
  { symbol: "SOUN", name: "SoundHound AI" },
  { symbol: "IONQ", name: "IonQ" },
  { symbol: "RGTI", name: "Rigetti Computing" },
  { symbol: "ARM", name: "Arm Holdings" },
  { symbol: "AMD", name: "AMD" },
  { symbol: "MU", name: "Micron" },
  { symbol: "VRT", name: "Vertiv" },
  { symbol: "DELL", name: "Dell Technologies" },
  { symbol: "ASTS", name: "AST SpaceMobile" },
  { symbol: "RKLB", name: "Rocket Lab" },
  { symbol: "OKLO", name: "Oklo" },
];

export type ScanCandidate = { symbol: string; name: string | null };

export function scanCandidates(): ScanCandidate[] {
  const seen = new Set<string>();
  const out: ScanCandidate[] = [];
  for (const c of [
    ...HIGH_VOL_CANDIDATES,
    ...UNIVERSE.filter((u) => u.asset_class !== "etf").map((u) => ({ symbol: u.symbol, name: u.name })),
  ]) {
    const key = c.symbol.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ symbol: c.symbol, name: c.name });
  }
  return out;
}

export type ScanReport = {
  scanned: number;
  matches: SetupMatch[];
  nearMisses: { symbol: string; reason: string }[];
  errors: string[];
  rules: typeof RECLAIM_SCAN_RULES;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /429|rate.?limit|too many requests/i.test(msg);
}

/**
 * Fetch candles with exponential backoff on provider rate limits so a busy
 * upstream slows the scan down instead of failing it.
 */
async function candlesWithBackoff(symbol: string, days: number) {
  let delay = 800;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await getDailyCandles(symbol, days);
    } catch (err) {
      if (!isRateLimit(err) || attempt === 2) throw err;
      await sleep(delay + Math.random() * 250);
      delay *= 2;
    }
  }
  throw new Error(`${symbol}: rate limited`);
}

/** Run the post-reclaim archetype scan across the candidate list. */
export async function runReclaimScan(limit = 40): Promise<ScanReport> {
  const candidates = scanCandidates().slice(0, limit);
  const matches: SetupMatch[] = [];
  const nearMisses: { symbol: string; reason: string }[] = [];
  const errors: string[] = [];
  let scanned = 0;

  // Small batches keep the upstream price provider inside its rate limits.
  const batchSize = 5;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (c) => {
        try {
          const candles = await candlesWithBackoff(c.symbol, 260);
          scanned += 1;
          const verdict = evaluateSetup(
            c.symbol,
            candles.map((k) => ({
              date: k.date,
              close: Number(k.close),
              high: Number(k.high ?? k.close),
              low: Number(k.low ?? k.close),
              volume: Number(k.volume ?? 0),
            })),
            { name: c.name },
          );
          if (verdict.match) matches.push(verdict.match);
          else nearMisses.push({ symbol: c.symbol, reason: verdict.rejected });
        } catch (err) {
          errors.push(`${c.symbol}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
    // Pace batches so the upstream provider is not hammered.
    if (i + batchSize < candidates.length) await sleep(250);
  }

  matches.sort((a, b) => b.score - a.score);
  return { scanned, matches, nearMisses, errors, rules: RECLAIM_SCAN_RULES };
}

/** Re-evaluate a single symbol, for the "add to watchlist" confirmation path. */
export async function evaluateSymbolSetup(symbol: string): Promise<SetupMatch | null> {
  const candles = await getDailyCandles(symbol, 260);
  const verdict = evaluateSetup(
    symbol,
    candles.map((k) => ({
      date: k.date,
      close: Number(k.close),
      high: Number(k.high ?? k.close),
      low: Number(k.low ?? k.close),
      volume: Number(k.volume ?? 0),
    })),
  );
  return verdict.match;
}
