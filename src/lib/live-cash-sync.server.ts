// Sync a live portfolio's cash balance from Saxo. Called at the start of every
// trading tick (and by manual "Sync balance" actions) so external deposits or
// withdrawals into the Saxo account are picked up automatically without the
// user having to re-activate the portfolio.
//
// Rules:
//  * Only touches live_sim / live_prod portfolios.
//  * The delta (broker cash − local cash) is applied to BOTH current_cash and
//    starting_cash so PnL/return calculations don't spike as a fake gain/loss
//    when the user deposits or withdraws money at the broker.
//  * Small drifts (<0.5 in account currency) are ignored — they usually come
//    from FX rounding, fees, or in-flight fills already accounted for locally.
//  * Never throws upward: a broker read failure is logged and the tick
//    proceeds with the last-known local cash so trading isn't blocked by a
//    transient Saxo outage.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const DRIFT_EPSILON = 0.5;

export type LiveCashSyncResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      delta: number;
      brokerCash: number;
      previousCash: number;
      newCash: number;
      newStartingCash: number;
      currency: string;
    };

export async function syncLiveCashFromBroker(
  portfolioId: string,
): Promise<LiveCashSyncResult> {
  const { data: p, error } = await supabaseAdmin
    .from("portfolios")
    .select("id, user_id, mode, current_cash, starting_cash, live_paused")
    .eq("id", portfolioId)
    .maybeSingle();
  if (error || !p) return { skipped: true, reason: "portfolio not found" };
  if (p.mode !== "live_sim" && p.mode !== "live_prod") {
    return { skipped: true, reason: "not a live portfolio" };
  }
  const env = p.mode === "live_prod" ? "live" : "sim";

  let brokerCash: number;
  let currency: string;
  try {
    const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
    const adapter = await buildSaxoAdapter({
      userId: p.user_id, portfolioId, envOverride: env,
    });
    const bal = await adapter.getBalance();
    // cashAvailable already accounts for pending deposits (TransactionsNotBooked)
    // and SpendingPower — that's what the AI should be allowed to trade with.
    brokerCash = Number(bal.cashAvailable ?? bal.cash);
    currency = bal.currency;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolioId, user_id: p.user_id,
      broker: "saxo", env,
      method: "CASH_SYNC", path: "/sync/cash",
      status: 502,
      request: {} as never, response: null,
      error: `broker read failed: ${msg}`,
    });
    return { skipped: true, reason: `broker read failed: ${msg}` };
  }

  const prevCash = Number(p.current_cash ?? 0);
  const prevStarting = Number(p.starting_cash ?? 0);
  const delta = brokerCash - prevCash;

  if (!Number.isFinite(brokerCash) || Math.abs(delta) < DRIFT_EPSILON) {
    return { skipped: true, reason: "no material drift" };
  }

  const { data: existingHoldings } = await supabaseAdmin
    .from("holdings")
    .select("id")
    .eq("portfolio_id", portfolioId)
    .limit(1);
  const hasLocalHoldings = (existingHoldings ?? []).length > 0;

  // Cash can legitimately move when live orders fill, settle, or fees are
  // booked. Only treat a cash drift as an external deposit/withdrawal while
  // the portfolio is still cash-only; once assets exist, keep the funding
  // baseline stable and let holdings reconciliation own total equity.
  const newStarting = hasLocalHoldings ? prevStarting : Math.max(0, prevStarting + delta);
  const upd = await supabaseAdmin.from("portfolios")
    .update({ current_cash: brokerCash, starting_cash: newStarting })
    .eq("id", portfolioId);

  const latestSnapshotQuery = supabaseAdmin
    .from("equity_snapshots")
    .select("holdings_value")
    .eq("portfolio_id", portfolioId)
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const latestSnapshot = await latestSnapshotQuery;
  const holdingsValue = Number(latestSnapshot.data?.holdings_value ?? 0);
  const today = new Date().toISOString().slice(0, 10);
  await writeCashSyncSnapshot(supabaseAdmin, {
    portfolioId,
    snapshotDate: today,
    cash: brokerCash,
    holdingsValue,
  });


  await supabaseAdmin.from("live_broker_log").insert({
    portfolio_id: portfolioId, user_id: p.user_id,
    broker: "saxo", env,
    method: "CASH_SYNC", path: "/sync/cash",
    status: upd.error ? 500 : 200,
    request: { previousCash: prevCash, previousStarting: prevStarting, hasLocalHoldings } as never,
    response: {
      brokerCash,
      delta,
      newCash: brokerCash,
      newStarting,
      startingCashAdjusted: !hasLocalHoldings,
      currency,
    } as never,
    error: upd.error?.message ?? null,
  });

  if (upd.error) return { skipped: true, reason: upd.error.message };

  return {
    skipped: false, delta, brokerCash, currency,
    previousCash: prevCash, newCash: brokerCash, newStartingCash: newStarting,
  };
}
