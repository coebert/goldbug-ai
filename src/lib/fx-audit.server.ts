// Pure assembly helpers for the FX audit surface. Kept out of the
// `.functions.ts` file so integration tests can call the same code the
// server-function handler runs, without going through the RPC boundary.

import { getFxRateAudited } from "@/lib/fx.server";

export const AUDIT_CCYS = ["GBP", "USD", "EUR"] as const;
export type AuditCcy = (typeof AUDIT_CCYS)[number];

export type FxAuditPair = {
  from: AuditCcy;
  to: AuditCcy;
  rate: number;
  source: string;
  stale: boolean;
  observedAt: string;
  impliedInverse: number;
};

/**
 * Build the full six-row FX audit matrix (USD/GBP/EUR cross-pairs, excluding
 * same-currency identity rows). Returned sorted by "from+to" so callers and
 * tests see a stable ordering.
 *
 * IMPORTANT: only ONE direction of each unordered pair is fetched from the
 * FX provider. The reverse row is derived as `1 / rate` from the SAME quote
 * (same source, same observation timestamp, same stale flag). This mirrors
 * how the sizer and pre-funding trimmer resolve inverses at execution time,
 * so the audit surface can NEVER disagree with the rate actually applied to
 * a trade. Fetching both directions independently produced small drift when
 * providers rounded the two quotes differently — audit vs. execution parity
 * broke silently.
 */
export async function buildFxAuditPairs(): Promise<FxAuditPair[]> {
  const directional: Array<[AuditCcy, AuditCcy]> = [];
  for (let i = 0; i < AUDIT_CCYS.length; i++) {
    for (let j = i + 1; j < AUDIT_CCYS.length; j++) {
      directional.push([AUDIT_CCYS[i], AUDIT_CCYS[j]]);
    }
  }
  const quotes = await Promise.all(
    directional.map(([f, t]) => getFxRateAudited(f, t).then((r) => ({ f, t, r }))),
  );
  const pairs: FxAuditPair[] = [];
  for (const { f, t, r } of quotes) {
    const inverse = r.rate > 0 ? 1 / r.rate : 0;
    pairs.push({
      from: f,
      to: t,
      rate: r.rate,
      source: r.source,
      stale: r.stale,
      observedAt: new Date(r.observedAtMs).toISOString(),
      impliedInverse: inverse,
    });
    pairs.push({
      from: t,
      to: f,
      rate: inverse,
      // Mark derived rows so the UI can show `<source> (derived 1/rate)`.
      source: `${r.source}:inverse`,
      stale: r.stale,
      observedAt: new Date(r.observedAtMs).toISOString(),
      impliedInverse: r.rate,
    });
  }
  return pairs.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
}
