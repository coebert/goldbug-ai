/**
 * Admin action: re-run the broker charge sync for fills that still read zero.
 *
 * Ordinary ingestion walks the whole lookback window and is happy to leave a
 * row alone; that is how a real-money tape ended up with every `live_fills.fee`
 * at 0 while Saxo had in fact invoiced the trades. This driver targets only the
 * zero-fee rows, snapshots each one before the pass, re-runs ingestion for the
 * owning portfolio, then diffs the same rows afterwards so the operator sees
 * exactly which fills moved and by how much — and writes that list to the
 * broker log as an audit trail.
 */

import { createLogger } from "@/lib/_server/log";
import { resolvePortfolioBrokerLink } from "./brokers/portfolio-broker-link.server";
import {
  ingestBrokerCostsForPortfolio,
  COST_INGEST_LOOKBACK_DAYS,
} from "./broker-cost-ingest.server";

const log = createLogger("zero-fee-resync");

export type ZeroFeeFillChange = {
  fillId: string;
  portfolioId: string;
  portfolioName: string;
  symbol: string;
  side: string;
  quantity: number;
  fillPrice: number;
  currency: string;
  filledAt: string;
  feeBefore: number;
  feeAfter: number;
  feeSourceBefore: string | null;
  feeSourceAfter: string | null;
  syncStatusBefore: string | null;
  syncStatusAfter: string | null;
  /** Reason the row is still on zero after the pass, when it is. */
  reason: string | null;
};

export type ZeroFeeResyncPortfolio = {
  portfolioId: string;
  name: string;
  mode: string;
  zeroFeeBefore: number;
  zeroFeeAfter: number;
  updated: number;
  chargedTotal: number;
  currency: string;
  skipped: string | null;
};

export type ZeroFeeResyncResult = {
  ranAt: string;
  lookbackDays: number;
  portfolios: ZeroFeeResyncPortfolio[];
  /** Every fill whose fee, source or sync status actually moved. */
  updatedFills: ZeroFeeFillChange[];
  /** Zero-fee fills the broker report still does not cover. */
  unchangedFills: ZeroFeeFillChange[];
  zeroFeeBefore: number;
  zeroFeeAfter: number;
  totalCharged: number;
};

type FillRow = Record<string, unknown>;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (v == null ? null : String(v));

const FILL_COLUMNS =
  "id, portfolio_id, symbol, side, quantity, fill_price, currency, filled_at, fee, fee_source, fee_sync_status, fee_sync_reason";

function toChange(
  before: FillRow,
  after: FillRow | undefined,
  portfolioName: string,
): ZeroFeeFillChange {
  const src = after ?? before;
  return {
    fillId: String(before["id"]),
    portfolioId: String(before["portfolio_id"] ?? ""),
    portfolioName,
    symbol: String(before["symbol"] ?? ""),
    side: String(before["side"] ?? ""),
    quantity: num(before["quantity"]),
    fillPrice: num(before["fill_price"]),
    currency: String(before["currency"] ?? "GBP").toUpperCase(),
    filledAt: String(before["filled_at"] ?? ""),
    feeBefore: num(before["fee"]),
    feeAfter: num(src["fee"]),
    feeSourceBefore: str(before["fee_source"]),
    feeSourceAfter: str(src["fee_source"]),
    syncStatusBefore: str(before["fee_sync_status"]),
    syncStatusAfter: str(src["fee_sync_status"]),
    reason: str(src["fee_sync_reason"]),
  };
}

function moved(c: ZeroFeeFillChange): boolean {
  return (
    c.feeAfter !== c.feeBefore ||
    c.feeSourceAfter !== c.feeSourceBefore ||
    c.syncStatusAfter !== c.syncStatusBefore
  );
}

/**
 * Re-runs charge ingestion for every broker-linked live portfolio that still
 * holds zero-fee fills, and reports the per-fill outcome.
 */
export async function resyncZeroFeeFills(args: {
  db: { from: (t: string) => any };
  userId: string;
  portfolioId?: string;
  lookbackDays?: number;
  now?: Date;
}): Promise<ZeroFeeResyncResult> {
  const lookbackDays = args.lookbackDays ?? COST_INGEST_LOOKBACK_DAYS;
  const now = args.now ?? new Date();
  const fromIso = new Date(now.getTime() - lookbackDays * 86_400_000).toISOString();

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  let pq = args.db
    .from("portfolios")
    .select("id, name, mode, broker, broker_account_id")
    .eq("user_id", args.userId);
  if (args.portfolioId) pq = pq.eq("id", args.portfolioId);
  const { data: pData, error: pErr } = await pq;
  if (pErr) throw pErr;

  const portfolios = (pData ?? []) as FillRow[];
  const out: ZeroFeeResyncPortfolio[] = [];
  const updatedFills: ZeroFeeFillChange[] = [];
  const unchangedFills: ZeroFeeFillChange[] = [];
  let totalCharged = 0;

  for (const p of portfolios) {
    const portfolioId = String(p["id"]);
    const name = String(p["name"] ?? "Portfolio");
    const mode = String(p["mode"] ?? "");

    // Snapshot the zero-fee rows first: after the pass their fee has moved, so
    // there would be no way to tell an already-invoiced row from a repaired one.
    const beforeRes = await supabaseAdmin
      .from("live_fills")
      .select(FILL_COLUMNS)
      .eq("portfolio_id", portfolioId)
      .gte("filled_at", fromIso)
      .or("fee.is.null,fee.eq.0")
      .order("filled_at", { ascending: true })
      .limit(2000);
    const beforeRows = (beforeRes.data ?? []) as FillRow[];

    if (beforeRows.length === 0) {
      out.push({
        portfolioId,
        name,
        mode,
        zeroFeeBefore: 0,
        zeroFeeAfter: 0,
        updated: 0,
        chargedTotal: 0,
        currency: "GBP",
        skipped: "no zero-fee fills in the window",
      });
      continue;
    }

    const link = resolvePortfolioBrokerLink({
      broker: (p["broker"] as string | null) ?? null,
      broker_account_id: (p["broker_account_id"] as string | null) ?? null,
    });
    const tradesLive = mode === "live_sim" || mode === "live_prod";
    if (!link.linked || !tradesLive) {
      out.push({
        portfolioId,
        name,
        mode,
        zeroFeeBefore: beforeRows.length,
        zeroFeeAfter: beforeRows.length,
        updated: 0,
        chargedTotal: 0,
        currency: "GBP",
        skipped: link.linked ? "portfolio does not trade through the broker" : link.reason,
      });
      continue;
    }

    let charged = 0;
    let currency = "GBP";
    let skipped: string | null = null;
    try {
      const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
      const adapter = await buildSaxoAdapter({
        userId: args.userId,
        portfolioId,
        envOverride: mode === "live_prod" ? "live" : "sim",
        accountKey: link.accountKey,
      });
      const res = await ingestBrokerCostsForPortfolio({
        portfolioId,
        userId: args.userId,
        adapter,
        lookbackDays,
        now,
      });
      charged = res.chargedTotal;
      currency = res.currency;
      if (!res.supported) skipped = res.reason ?? "broker publishes no cost report";
    } catch (e) {
      skipped = e instanceof Error ? e.message : String(e);
      log.warn("zero-fee resync failed", { portfolioId, error: skipped });
    }

    const ids = beforeRows.map((r) => String(r["id"]));
    const afterRes = await supabaseAdmin.from("live_fills").select(FILL_COLUMNS).in("id", ids);
    const afterById = new Map<string, FillRow>();
    for (const r of (afterRes.data ?? []) as FillRow[]) afterById.set(String(r["id"]), r);

    let updated = 0;
    let zeroAfter = 0;
    for (const b of beforeRows) {
      const change = toChange(b, afterById.get(String(b["id"])), name);
      if (moved(change)) {
        updated += 1;
        updatedFills.push(change);
      } else {
        unchangedFills.push(change);
      }
      if (!(change.feeAfter > 0)) zeroAfter += 1;
    }

    totalCharged += charged;
    out.push({
      portfolioId,
      name,
      mode,
      zeroFeeBefore: beforeRows.length,
      zeroFeeAfter: zeroAfter,
      updated,
      chargedTotal: charged,
      currency,
      skipped,
    });
  }

  const result: ZeroFeeResyncResult = {
    ranAt: now.toISOString(),
    lookbackDays,
    portfolios: out,
    updatedFills,
    unchangedFills,
    zeroFeeBefore: out.reduce((a, p) => a + p.zeroFeeBefore, 0),
    zeroFeeAfter: out.reduce((a, p) => a + p.zeroFeeAfter, 0),
    totalCharged,
  };

  // Structured server log, one line per repaired fill, so the change is
  // traceable even if the caller closes the page.
  for (const c of updatedFills) {
    log.info("fee resynced", {
      fillId: c.fillId,
      symbol: c.symbol,
      filledAt: c.filledAt,
      feeBefore: c.feeBefore,
      feeAfter: c.feeAfter,
      source: c.feeSourceAfter,
      status: c.syncStatusAfter,
    });
  }

  // Durable audit trail alongside every other broker interaction.
  try {
    await supabaseAdmin.from("live_broker_log").insert({
      user_id: args.userId,
      portfolio_id: args.portfolioId ?? null,
      broker: "saxo",
      env: "admin",
      method: "SYNC",
      path: "/admin/zero-fee-resync",
      status: 200,
      request: { lookbackDays, portfolioId: args.portfolioId ?? null },
      response: {
        zeroFeeBefore: result.zeroFeeBefore,
        zeroFeeAfter: result.zeroFeeAfter,
        updated: updatedFills.length,
        totalCharged,
        fills: updatedFills.map((c) => ({
          id: c.fillId,
          symbol: c.symbol,
          filledAt: c.filledAt,
          feeBefore: c.feeBefore,
          feeAfter: c.feeAfter,
          source: c.feeSourceAfter,
        })),
      },
    });
  } catch (e) {
    log.warn("failed to write resync audit row", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  return result;
}
