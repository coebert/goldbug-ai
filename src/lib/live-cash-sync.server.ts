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

// Canonical location for the "which client + whose rows" pair. Re-exported
// here so existing sidecar imports (`live-holdings-sync`, `live-reconcile`)
// keep working without churn.
export type { ScopedDbClient, OwnedDbClient } from "@/lib/_server/owned-client";
import type { OwnedDbClient } from "@/lib/_server/owned-client";
import { asJson } from "@/lib/_server/db-json";

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
  owned: OwnedDbClient,
): Promise<LiveCashSyncResult> {
  // Standardised "which client + whose rows" pair. On the authenticated
  // branch (`isAdmin === false`), every read/write below is enforced by
  // RLS as the caller. On the admin branch (cron paths), RLS is bypassed
  // and we add `.eq("user_id", userId)` on every top-level portfolio read
  // as defence-in-depth. Downstream `.eq("portfolio_id", …)` calls are
  // safe on both branches once ownership of the portfolio has been proven.
  const { db, userId, isAdmin } = owned;

  const portfolioQuery = db
    .from("portfolios")
    .select("id, user_id, mode, current_cash, starting_cash, live_paused, currency")
    .eq("id", portfolioId);
  const { data: p, error } = await (isAdmin
    ? portfolioQuery.eq("user_id", userId)
    : portfolioQuery
  ).maybeSingle();
  if (error || !p) return { skipped: true, reason: "portfolio not found" };
  if (p.user_id !== userId) {
    return { skipped: true, reason: "portfolio not owned by caller" };
  }
  if (p.mode !== "live_sim" && p.mode !== "live_prod") {
    return { skipped: true, reason: "not a live portfolio" };
  }
  const env = p.mode === "live_prod" ? "live" : "sim";

  let brokerCash: number;
  let brokerTotalValue: number | null = null;
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
    brokerTotalValue = Number.isFinite(Number(bal.totalValue)) && Number(bal.totalValue) > 0
      ? Number(bal.totalValue)
      : null;
    currency = bal.currency;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from("live_broker_log").insert({
      portfolio_id: portfolioId, user_id: p.user_id,
      broker: "saxo", env,
      method: "CASH_SYNC", path: "/sync/cash",
      status: 502,
      request: asJson({}), response: null,
      error: `broker read failed: ${msg}`,
    });
    return { skipped: true, reason: `broker read failed: ${msg}` };
  }

  // ---------------------------------------------------------------------------
  // Preflight: portfolio accounting currency MUST match the broker account
  // currency before we touch current_cash. Writing an EUR broker balance into
  // a GBP portfolio silently produces bogus P&L / % change and — because the
  // downstream mismatch guard then locks that portfolio's P&L card — leaves
  // the user with no way to see performance. Detect the mismatch here, log a
  // structured entry so it shows up in the trade-error dashboard, and skip
  // the CASH_SYNC write entirely so nothing downstream is corrupted.
  // ---------------------------------------------------------------------------
  const portfolioCurrency =
    typeof (p as { currency?: string }).currency === "string"
      ? String((p as { currency?: string }).currency).toUpperCase()
      : null;
  const brokerCurrency =
    typeof currency === "string" && currency ? currency.toUpperCase() : null;

  if (!portfolioCurrency || !brokerCurrency || portfolioCurrency !== brokerCurrency) {
    const reason = !portfolioCurrency
      ? "portfolio has no accounting currency configured"
      : !brokerCurrency
        ? "broker did not return a currency"
        : `currency mismatch: portfolio=${portfolioCurrency} broker=${brokerCurrency}`;

    // Idempotency: preflight failures are sticky — until the user changes
    // the portfolio currency (or the broker account changes), every rerun
    // produces exactly the same mismatch. We MUST NOT touch current_cash
    // on any rerun (the early return below guarantees that), and we also
    // suppress duplicate log rows so the trade-error dashboard doesn't
    // fill up with identical 409s on every hourly tick. We only append a
    // new PREFLIGHT log when the observed state actually changes
    // (portfolio ccy, broker ccy, or the reason string).
    const { data: lastPreflight } = await db
      .from("live_broker_log")
      .select("id, request, response, error")
      .eq("portfolio_id", portfolioId)
      .eq("method", "CASH_SYNC_PREFLIGHT")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const prev = lastPreflight ?? null;
    const prevReq = (prev?.request ?? {}) as {
      portfolioCurrency?: string | null;
    };
    const prevRes = (prev?.response ?? {}) as {
      brokerCurrency?: string | null;
      blocked?: boolean;
    };
    const alreadyLogged =
      prev != null &&
      prevRes.blocked === true &&
      (prevReq.portfolioCurrency ?? null) === portfolioCurrency &&
      (prevRes.brokerCurrency ?? null) === brokerCurrency &&
      (prev.error ?? null) === reason;

    if (!alreadyLogged) {
      await db.from("live_broker_log").insert({
        portfolio_id: portfolioId, user_id: p.user_id,
        broker: "saxo", env,
        method: "CASH_SYNC_PREFLIGHT", path: "/sync/cash/preflight",
        status: 409,
        request: asJson({
          portfolioCurrency, mode: p.mode,
          previousCash: Number(p.current_cash ?? 0),
        }),
        response: asJson({ brokerCurrency, brokerCash, blocked: true }),
        error: reason,
      });
    }

    // Deterministic skipped result — identical across reruns while the
    // mismatch persists. current_cash / starting_cash are guaranteed
    // untouched because we return before the update path below.
    return { skipped: true, reason };
  }


  const prevCash = Number(p.current_cash ?? 0);
  const prevStarting = Number(p.starting_cash ?? 0);
  const delta = brokerCash - prevCash;

  if (!Number.isFinite(brokerCash)) {
    return { skipped: true, reason: "broker cash not finite" };
  }

  // Even when the portfolio's current_cash already matches the broker (no
  // material drift), today's equity_snapshot can still be stale — e.g. an
  // earlier HOLDINGS_SYNC / CASH_SYNC wrote a snapshot before a fill and
  // the newer authoritative TotalValue has since changed. The "stale data"
  // banner is driven by comparing broker cash vs today's snapshot.cash, so
  // if we early-return here without refreshing the snapshot the mismatch
  // sticks forever. Always reconcile today's snapshot against the freshly
  // fetched broker values before deciding whether to skip.
  const todayIso = new Date().toISOString().slice(0, 10);
  if (Math.abs(delta) < DRIFT_EPSILON) {
    const { data: todaySnap } = await db
      .from("equity_snapshots")
      .select("cash, holdings_value, total_value")
      .eq("portfolio_id", portfolioId)
      .eq("snapshot_date", todayIso)
      .maybeSingle();
    let holdingsValueForSnapshot: number;
    if (brokerTotalValue != null && brokerTotalValue > 0) {
      holdingsValueForSnapshot = Math.max(0, brokerTotalValue - brokerCash);
    } else {
      holdingsValueForSnapshot = Number(todaySnap?.holdings_value ?? 0);
    }
    const snapCash = Number(todaySnap?.cash ?? Number.NaN);
    const snapHoldings = Number(todaySnap?.holdings_value ?? Number.NaN);
    const snapNeedsRewrite =
      !todaySnap ||
      !Number.isFinite(snapCash) ||
      Math.abs(snapCash - brokerCash) >= DRIFT_EPSILON ||
      (Number.isFinite(snapHoldings) &&
        Math.abs(snapHoldings - holdingsValueForSnapshot) >= DRIFT_EPSILON);
    if (snapNeedsRewrite) {
      await writeCashSyncSnapshot(db as unknown as CashSyncSnapshotClient, {
        portfolioId,
        snapshotDate: todayIso,
        cash: brokerCash,
        holdingsValue: holdingsValueForSnapshot,
      });
      await db.from("live_broker_log").insert({
        portfolio_id: portfolioId, user_id: p.user_id,
        broker: "saxo", env,
        method: "CASH_SYNC", path: "/sync/cash",
        status: 200,
        request: asJson({
          previousCash: prevCash, hasLocalHoldings: null, mode: p.mode,
          reason: "snapshot-refresh-only",
        }),
        response: asJson({
          brokerCash, brokerTotalValue, delta,
          snapshotRewritten: true, holdingsValueForSnapshot, currency,
        }),
        error: null,
      });
    }
    return { skipped: true, reason: "no material drift" };
  }


  const { data: existingHoldings } = await db
    .from("holdings")
    .select("id")
    .eq("portfolio_id", portfolioId)
    .limit(1);
  const hasLocalHoldings = (existingHoldings ?? []).length > 0;

  // Cash can legitimately move when live orders fill, settle, or fees are
  // booked. To decide whether a drift is an external deposit/withdrawal vs
  // a trading fill we look at what actually happened at the broker in the
  // recent past: if no fills explain the cash change, it must be external
  // money movement and starting_cash must move with it so PnL/% aren't
  // corrupted. Only applies on real brokers (live_prod) — SIM broker
  // balances (Saxo Demo) don't reflect our simulated trades.
  //   * Broker currency vs portfolio currency is enforced upstream by the
  //     preflight check above.
  let canTreatDriftAsDeposit = false;
  if (p.mode === "live_prod") {
    if (!hasLocalHoldings) {
      canTreatDriftAsDeposit = true;
    } else {
      const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const recentFills = await db
        .from("live_fills")
        .select("side, quantity, fill_price, fee")
        .eq("portfolio_id", portfolioId)
        .gte("filled_at", sinceIso);
      const explainedCashDelta = (recentFills.data ?? []).reduce((sum, f) => {
        const notional = Number(f.quantity) * Number(f.fill_price);
        const fee = Number(f.fee ?? 0);
        // buys reduce cash, sells increase cash; both incur fees
        return sum + (f.side === "sell" ? notional - fee : -notional - fee);
      }, 0);
      const unexplained = delta - explainedCashDelta;
      // Any material unexplained cash move (in either direction) is treated
      // as an external deposit/withdrawal against the starting pot.
      if (Math.abs(unexplained) >= DRIFT_EPSILON) {
        canTreatDriftAsDeposit = true;
      }
    }
  }

  // starting_cash is monotonic in the deposit direction — once the user has
  // put money in, we never let a subsequent fill or fee silently reduce the
  // recorded baseline. Withdrawals still subtract from it.
  const newStarting = canTreatDriftAsDeposit
    ? Math.max(0, prevStarting + delta)
    : prevStarting;
  const upd = await db.from("portfolios")
    .update({ current_cash: brokerCash, starting_cash: newStarting })
    .eq("id", portfolioId);

  // Prefer the broker's authoritative TotalValue for today's equity snapshot
  // so the headline matches what the user sees in the Saxo app. Falling back
  // to (cash + latest snapshot's holdings_value) means a CASH_SYNC that
  // happens between a fill and the next HOLDINGS_SYNC leaves holdings stale
  // and understates total equity (see 2026-07-27 08:00 CASH_SYNC incident).
  const today = new Date().toISOString().slice(0, 10);
  let holdingsValueForSnapshot: number;
  if (brokerTotalValue != null && brokerTotalValue > 0) {
    holdingsValueForSnapshot = Math.max(0, brokerTotalValue - brokerCash);
  } else {
    const latestSnapshot = await db
      .from("equity_snapshots")
      .select("holdings_value")
      .eq("portfolio_id", portfolioId)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    holdingsValueForSnapshot = Number(latestSnapshot.data?.holdings_value ?? 0);
  }
  await writeCashSyncSnapshot(db as unknown as CashSyncSnapshotClient, {
    portfolioId,
    snapshotDate: today,
    cash: brokerCash,
    holdingsValue: holdingsValueForSnapshot,
  });

  await db.from("live_broker_log").insert({
    portfolio_id: portfolioId, user_id: p.user_id,
    broker: "saxo", env,
    method: "CASH_SYNC", path: "/sync/cash",
    status: upd.error ? 500 : 200,
    request: asJson({
      previousCash: prevCash, previousStarting: prevStarting,
      hasLocalHoldings, mode: p.mode,
      portfolioCurrency: (p as { currency?: string }).currency ?? null,
    }),
    response: asJson({
      brokerCash,
      brokerTotalValue,
      delta,
      newCash: brokerCash,
      newStarting,
      startingCashAdjusted: canTreatDriftAsDeposit,
      currency,
    }),
    error: upd.error?.message ?? null,
  });

  if (upd.error) return { skipped: true, reason: upd.error.message };

  return {
    skipped: false, delta, brokerCash, currency,
    previousCash: prevCash, newCash: brokerCash, newStartingCash: newStarting,
  };
}

// ---------------------------------------------------------------------------
// Snapshot write path — extracted so it can be integration-tested without a
// live database and, crucially, without depending on the
// (portfolio_id, snapshot_date) UNIQUE constraint existing. Older environments
// were seen without the constraint, which silently turned upserts into
// duplicate inserts. This implementation does an explicit read-then-
// update-or-insert so behaviour is identical either way.
// ---------------------------------------------------------------------------

export type CashSyncSnapshotInput = {
  portfolioId: string;
  snapshotDate: string; // YYYY-MM-DD
  cash: number;
  holdingsValue: number;
};

export type CashSyncSnapshotWriteResult =
  | { action: "inserted"; totalValue: number }
  | { action: "updated"; totalValue: number; previousTotalValue: number }
  | { action: "error"; message: string };

// Minimal structural type of the Supabase client surface we use, so tests can
// hand in a lightweight fake without pulling in the real client.
export type CashSyncSnapshotClient = {
  from: (table: "equity_snapshots") => {
    select: (cols: string) => {
      eq: (col: "portfolio_id", val: string) => {
        eq: (col: "snapshot_date", val: string) => {
          maybeSingle: () => Promise<{
            data: { id: string; total_value: number | null } | null;
            error: { message: string } | null;
          }>;
        };
      };
    };
    update: (patch: { cash: number; holdings_value: number; total_value: number }) => {
      eq: (col: "id", val: string) => Promise<{ error: { message: string } | null }>;
    };
    insert: (row: {
      portfolio_id: string;
      snapshot_date: string;
      cash: number;
      holdings_value: number;
      total_value: number;
    }) => Promise<{ error: { message: string } | null }>;
  };
};

export async function writeCashSyncSnapshot(
  client: CashSyncSnapshotClient,
  input: CashSyncSnapshotInput,
): Promise<CashSyncSnapshotWriteResult> {
  const cash = Number(input.cash);
  const holdingsValue = Number(input.holdingsValue);
  if (!Number.isFinite(cash) || !Number.isFinite(holdingsValue)) {
    return { action: "error", message: "cash and holdingsValue must be finite" };
  }
  const totalValue = cash + holdingsValue;

  const existing = await client
    .from("equity_snapshots")
    .select("id, total_value")
    .eq("portfolio_id", input.portfolioId)
    .eq("snapshot_date", input.snapshotDate)
    .maybeSingle();

  if (existing.error) {
    return { action: "error", message: existing.error.message };
  }

  if (existing.data) {
    const upd = await client
      .from("equity_snapshots")
      .update({ cash, holdings_value: holdingsValue, total_value: totalValue })
      .eq("id", existing.data.id);
    if (upd.error) return { action: "error", message: upd.error.message };
    return {
      action: "updated",
      totalValue,
      previousTotalValue: Number(existing.data.total_value ?? 0),
    };
  }

  const ins = await client.from("equity_snapshots").insert({
    portfolio_id: input.portfolioId,
    snapshot_date: input.snapshotDate,
    cash,
    holdings_value: holdingsValue,
    total_value: totalValue,
  });
  if (ins.error) return { action: "error", message: ins.error.message };
  return { action: "inserted", totalValue };
}

