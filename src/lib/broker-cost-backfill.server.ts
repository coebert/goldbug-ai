/**
 * One-shot backfill of Saxo's booked charges onto the existing fill tape.
 *
 * The hourly loop only ever ingests charges for the tick it runs in, so the
 * fills placed before cost ingestion existed would stay on modelled costs
 * until they aged out of the KPI window — the card would keep saying
 * "estimated" for a month while real invoices sat unread at the broker. This
 * walks every broker-linked portfolio over the same 45-day report window and
 * pulls them in now.
 *
 * Idempotent: re-matching a fill on its broker trade id overwrites the charge
 * rather than adding to it, so running this twice cannot double-count.
 */

import { createLogger } from "@/lib/_server/log";
import { resolvePortfolioBrokerLink } from "./brokers/portfolio-broker-link.server";
import {
  ingestBrokerCostsForPortfolio,
  COST_INGEST_LOOKBACK_DAYS,
  type CostIngestResult,
} from "./broker-cost-ingest.server";
import {
  summariseBackfill,
  summarisePortfolioBackfill,
  type CostBackfillPortfolio,
  type CostBackfillSummary,
} from "./broker-cost-backfill";

const log = createLogger("broker-cost-backfill");

type DbClient = { from: (t: string) => any };

async function invoicedCount(db: DbClient, portfolioId: string, fromIso: string): Promise<number> {
  try {
    const res = await db
      .from("live_fills")
      .select("id", { count: "exact", head: true })
      .eq("portfolio_id", portfolioId)
      .eq("fee_source", "broker")
      .gte("filled_at", fromIso);
    return Number(res?.count ?? 0) || 0;
  } catch {
    return 0;
  }
}

export async function backfillBrokerCosts(args: {
  db: DbClient;
  userId: string;
  /** Limit to one portfolio; omitted, every broker-linked portfolio is synced. */
  portfolioId?: string;
  lookbackDays?: number;
  now?: Date;
}): Promise<CostBackfillSummary> {
  const lookbackDays = args.lookbackDays ?? COST_INGEST_LOOKBACK_DAYS;
  const now = args.now ?? new Date();
  const fromIso = new Date(now.getTime() - lookbackDays * 86_400_000).toISOString();

  let query = args.db
    .from("portfolios")
    .select("id, name, mode, broker, broker_account_id")
    .eq("user_id", args.userId);
  if (args.portfolioId) query = query.eq("id", args.portfolioId);
  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const out: CostBackfillPortfolio[] = [];

  for (const p of rows) {
    const portfolioId = String(p["id"]);
    const name = String(p["name"] ?? "Portfolio");
    const mode = String(p["mode"] ?? "");
    const before = await invoicedCount(args.db, portfolioId, fromIso);

    const link = resolvePortfolioBrokerLink({
      broker: (p["broker"] as string | null) ?? null,
      broker_account_id: (p["broker_account_id"] as string | null) ?? null,
    });
    if (!link.linked || (mode !== "live_sim" && mode !== "live_prod")) {
      // A locally simulated ledger has no broker invoice to fetch. Reported,
      // not silently dropped, so the card can explain the zero.
      out.push(
        summarisePortfolioBackfill({
          portfolioId,
          name,
          mode,
          invoicedBefore: before,
          invoicedAfter: before,
          result: null,
          skipped: link.linked ? "portfolio does not trade through the broker" : link.reason,
        }),
      );
      continue;
    }

    let result: CostIngestResult | null = null;
    let skipped: string | null = null;
    try {
      const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
      const adapter = await buildSaxoAdapter({
        userId: args.userId,
        portfolioId,
        envOverride: mode === "live_prod" ? "live" : "sim",
        accountKey: link.accountKey,
      });
      result = await ingestBrokerCostsForPortfolio({
        portfolioId,
        userId: args.userId,
        adapter,
        lookbackDays,
        now,
      });
    } catch (e) {
      skipped = e instanceof Error ? e.message : String(e);
      log.warn("cost backfill failed", { portfolioId, error: skipped });
    }

    const after = await invoicedCount(args.db, portfolioId, fromIso);
    out.push(
      summarisePortfolioBackfill({
        portfolioId,
        name,
        mode,
        invoicedBefore: before,
        invoicedAfter: after,
        result,
        skipped,
      }),
    );
  }

  return summariseBackfill({ portfolios: out, lookbackDays, ranAt: now.toISOString() });
}
