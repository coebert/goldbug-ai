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
 * Each pair carries the underlying observation timestamp so the UI can prove
 * *when* the rate was captured — not just its provenance.
 */
export async function buildFxAuditPairs(): Promise<FxAuditPair[]> {
  const jobs: Promise<FxAuditPair>[] = [];
  for (const f of AUDIT_CCYS) {
    for (const t of AUDIT_CCYS) {
      if (f === t) continue;
      jobs.push(
        getFxRateAudited(f, t).then((r) => ({
          from: f,
          to: t,
          rate: r.rate,
          source: r.source,
          stale: r.stale,
          observedAt: new Date(r.observedAtMs).toISOString(),
          impliedInverse: r.rate > 0 ? 1 / r.rate : 0,
        })),
      );
    }
  }
  const pairs = await Promise.all(jobs);
  return pairs.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
}
