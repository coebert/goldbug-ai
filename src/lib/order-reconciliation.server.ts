// Broker-order reconciliation. Server-only.
//
// For every live order that hasn't reached a terminal state locally, ask
// Saxo what actually happened: is it still working, was it filled, was it
// rejected? Then update `live_orders.status` and insert into `live_fills`
// so the dashboard reflects the true broker-side outcome.
//
// The routing loop in `live-executor.server.ts` marks orders as
// `submitted` (or `pending` on retry) but never learns about later state
// transitions (working → filled/rejected/cancelled). This reconciler is
// the missing loop.

import type { SaxoAdapter } from "./brokers/saxo.server";
import { asJson } from "@/lib/_server/db-json";
import { logReconcileEvent, type ReconcileReasonCode } from "./reconcile-event-log.server";
import { decideSimFill } from "./sim-fill-rules";
import { getMarketStatusForSymbol, inferVenue, marketHadOpenPeriod } from "./market-hours";
import { resolveFillRecord, type FillPriceCandidate } from "./fill-record";
import { modelledFillFee } from "./trade-viability-gate";
import { placeProtectiveStopAfterBuyFill } from "./protective-stop-placement.server";

export type OrderReconcileOutcome =
  | "filled"
  | "partial"
  | "rejected"
  | "cancelled"
  | "still_working"
  | "unknown"
  | "no_broker_id";

export interface OrderReconcileRow {
  orderId: string;
  brokerOrderId: string | null;
  symbol: string;
  outcome: OrderReconcileOutcome;
  previousStatus: string;
  newStatus: string;
  filledQuantity: number;
  avgFillPrice: number | null;
  reason?: string;
}

export interface OrderReconcileSummary {
  scanned: number;
  filled: number;
  partial: number;
  rejected: number;
  cancelled: number;
  stillWorking: number;
  unknown: number;
  rows: OrderReconcileRow[];
}

// Saxo may return status strings in a variety of casings across historical
// vs open endpoints. Normalise to our internal `live_orders.status` enum.
function mapSaxoStatus(status: string, filledQty: number, amount: number):
  | "filled"
  | "partial"
  | "rejected"
  | "cancelled"
  | "submitted"
  | "unknown"
{
  const s = status.toLowerCase();
  if (s.includes("fill")) {
    if (filledQty > 0 && amount > 0 && filledQty < amount) return "partial";
    return "filled";
  }
  if (s.includes("reject") || s.includes("error") || s.includes("expired") || s.includes("declin")) {
    return "rejected";
  }
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("work") || s.includes("place") || s.includes("open")) return "submitted";
  return "unknown";
}

/**
 * Extract the exchange-agnostic base ticker from either a Yahoo-style
 * ("HSBA.L", "SAP.DE") or Saxo-style ("HSBA:xlon", "SAP:xetr") symbol so we
 * can match a local `live_orders.symbol` against a Saxo `BrokerPosition.symbol`.
 */
function baseTicker(symbol: string): string {
  const upper = String(symbol ?? "").toUpperCase().trim();
  if (!upper) return "";
  const colonIdx = upper.indexOf(":");
  const stripped = colonIdx >= 0 ? upper.slice(0, colonIdx) : upper;
  const dotIdx = stripped.lastIndexOf(".");
  return dotIdx > 0 ? stripped.slice(0, dotIdx) : stripped;
}

export async function reconcileOrderStatusesForPortfolio(params: {
  portfolioId: string;
  userId: string;
  adapter: SaxoAdapter;
  lookbackHours?: number;
  statuses?: string[];
  /** Tagged onto every emitted reconcile event so backfills are distinguishable from the hourly loop. */
  source?: string;
}): Promise<OrderReconcileSummary> {
  const { portfolioId, userId, adapter } = params;
  const lookbackHours = params.lookbackHours ?? 72;
  const statuses = params.statuses ?? ["pending", "submitted", "working", "partial"];
  const source = params.source ?? "reconciler";
  const sinceIso = new Date(Date.now() - lookbackHours * 3600_000).toISOString();

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // `instrument_ccy` and `limit_price` are what stop a fill being booked
  // as "0 GBP": the order already knows its currency and the price it was
  // sized against, so neither has to be guessed at reconcile time.
  const openOrders = await supabaseAdmin
    .from("live_orders")
    .select(
      "id, symbol, side, quantity, order_type, status, broker_order_id, submitted_at, created_at, instrument_ccy, limit_price",
    )
    .eq("portfolio_id", portfolioId)
    .in("status", statuses)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true });

  if (openOrders.error) throw new Error(`load live_orders failed: ${openOrders.error.message}`);
  const rows = openOrders.data ?? [];

  // Portfolio base currency — last-resort fallback for the fill currency.
  const portfolioRow = await supabaseAdmin
    .from("portfolios")
    .select("currency")
    .eq("id", portfolioId)
    .maybeSingle();
  const portfolioCurrency = (portfolioRow.data?.currency as string | null) ?? "GBP";


  // Fetch the whole working-order list once — cheaper than one call per order.
  let working: Awaited<ReturnType<SaxoAdapter["listWorkingOrders"]>> = [];
  let workingListError: string | null = null;
  try {
    working = await adapter.listWorkingOrders();
  } catch (e) {
    workingListError = e instanceof Error ? e.message : String(e);
    // If we can't reach the endpoint, log once and treat everything as unknown
    await supabaseAdmin.from("live_broker_log").insert({
      portfolio_id: portfolioId,
      user_id: userId,
      broker: "saxo",
      env: adapter.env,
      method: "ORDER_RECON_LIST_FAILED",
      path: "/port/v1/orders/me",
      status: null,
      error: workingListError,
    });
  }
  const workingById = new Map(working.map((w) => [w.brokerOrderId, w]));

  // Lazy broker-position lookup. On Saxo LIVE tenants where `/hist/v3/orders`
  // returns 404 (`HIST_ORDERS_UNSUPPORTED`) we can't confirm fills from
  // history, so a BUY that leaves the working list would otherwise sit at
  // `submitted` forever until sim-style presumption kicks in. Instead, ask
  // the authoritative `/port/v1/netpositions/me` endpoint: if the position
  // is really there at the broker, the order filled — use the broker's
  // AverageOpenPrice rather than a guessed close.
  let positionsByBase: Map<string, Awaited<ReturnType<SaxoAdapter["getPositions"]>>[number]> | null = null;
  let positionsLoadError: string | null = null;
  const getPositionsByBase = async () => {
    if (positionsByBase || positionsLoadError) return positionsByBase;
    try {
      const list = await adapter.getPositions();
      positionsByBase = new Map();
      for (const p of list) {
        const key = baseTicker(p.symbol);
        if (key) positionsByBase.set(key, p);
      }
    } catch (e) {
      positionsLoadError = e instanceof Error ? e.message : String(e);
    }
    return positionsByBase;
  };

  const summary: OrderReconcileSummary = {
    scanned: rows.length, filled: 0, partial: 0, rejected: 0, cancelled: 0,
    stillWorking: 0, unknown: 0, rows: [],
  };

  for (const row of rows) {
    const brokerOrderId = row.broker_order_id ? String(row.broker_order_id) : null;
    const submittedAtIso = (row.submitted_at as string | null) ?? (row.created_at as string | null);
    const commonEvent = {
      orderId: row.id as string,
      portfolioId,
      userId,
      env: adapter.env,
      brokerOrderId,
      symbol: row.symbol as string,
      side: (row.side as string | null) ?? null,
      orderType: (row.order_type as string | null) ?? null,
      previousStatus: row.status as string,
      submittedAt: submittedAtIso,
      source,
    } as const;

    if (!brokerOrderId) {
      summary.rows.push({
        orderId: row.id as string,
        brokerOrderId: null,
        symbol: row.symbol as string,
        outcome: "no_broker_id",
        previousStatus: row.status as string,
        newStatus: row.status as string,
        filledQuantity: 0,
        avgFillPrice: null,
        reason: "order never received a broker id",
      });
      await logReconcileEvent({
        ...commonEvent,
        newStatus: row.status as string,
        outcome: "no_broker_id",
        reasonCode: "no_broker_id",
        reason: "order has no broker_order_id — never routed to Saxo",
      });
      continue;
    }

    const w = workingById.get(brokerOrderId);
    if (w) {
      // Still open. Two things to reflect:
      //   1. Partial-fill progress → local status "partial".
      //   2. Saxo's own status string ("Working", "Placed", "Parked",
      //      "NotWorking", "PreCheck", …) → sync onto our local status so
      //      the UI stops showing "submitted" indefinitely for orders that
      //      the broker has actually acknowledged as working or queued.
      const saxoStatusLc = String(w.status ?? "").toLowerCase();
      const previousStatusLc = String(row.status ?? "").toLowerCase();
      const isPartialProgress = w.filledAmount > 0 && w.filledAmount < w.amount;
      // Map the raw Saxo Status onto our internal `live_orders.status` enum.
      // Anything that isn't clearly rejected/cancelled/filled is treated as
      // "working" — including "NotWorking"/"Parked" (queued for next open
      // session), which is exactly what the user sees on the weekend.
      const mappedFromSaxo: string = isPartialProgress
        ? "partial"
        : saxoStatusLc.includes("fill")
          ? "filled"
          : saxoStatusLc.includes("reject") || saxoStatusLc.includes("error")
            ? "rejected"
            : saxoStatusLc.includes("cancel")
              ? "cancelled"
              : "working";

      if (mappedFromSaxo !== previousStatusLc) {
        const patch =
          mappedFromSaxo === "rejected"
            ? { status: mappedFromSaxo, reject_reason: "rejected by broker" }
            : { status: mappedFromSaxo };
        const upd = await supabaseAdmin
          .from("live_orders")
          .update(patch)
          .eq("id", row.id as string);
        if (upd.error) {
          await logReconcileEvent({
            ...commonEvent,
            newStatus: row.status as string,
            outcome: "error",
            reasonCode: "status_update_failed",
            reason: `failed to sync status ${previousStatusLc}→${mappedFromSaxo}: ${upd.error.message}`,
            filledQuantity: w.filledAmount,
            saxoStatus: w.status,
            saxoResponse: w,
          });
        }
      }

      if (isPartialProgress) {
        summary.partial++;
        summary.rows.push({
          orderId: row.id as string, brokerOrderId, symbol: row.symbol as string,
          outcome: "partial", previousStatus: row.status as string, newStatus: "partial",
          filledQuantity: w.filledAmount, avgFillPrice: null,
        });
        await logReconcileEvent({
          ...commonEvent,
          newStatus: "partial",
          outcome: "partial",
          reasonCode: "broker_open_partial_progress",
          reason: `order still open on Saxo with ${w.filledAmount}/${w.amount} filled`,
          filledQuantity: w.filledAmount,
          saxoStatus: w.status,
          saxoResponse: w,
        });
      } else {
        summary.stillWorking++;
        summary.rows.push({
          orderId: row.id as string, brokerOrderId, symbol: row.symbol as string,
          outcome: "still_working", previousStatus: row.status as string, newStatus: mappedFromSaxo,
          filledQuantity: w.filledAmount, avgFillPrice: null,
        });
        const queued = saxoStatusLc.includes("notworking") || saxoStatusLc.includes("park");
        await logReconcileEvent({
          ...commonEvent,
          newStatus: mappedFromSaxo,
          outcome: "still_working",
          reasonCode: "broker_open_working",
          reason: queued
            ? `order queued at Saxo ("${w.status}") — awaiting next session open`
            : `order is in Saxo's open-orders list ("${w.status}"); awaiting fill`,
          filledQuantity: w.filledAmount,
          saxoStatus: w.status,
          saxoResponse: w,
        });
      }
      continue;
    }

    // Not in working list → ask history what happened.
    let hist: Awaited<ReturnType<SaxoAdapter["getHistoricalOrder"]>> = null;
    let histError: string | null = null;
    try {
      hist = await adapter.getHistoricalOrder(brokerOrderId, sinceIso);
    } catch (e) {
      histError = e instanceof Error ? e.message : String(e);
    }

    if (histError) {
      await logReconcileEvent({
        ...commonEvent,
        newStatus: row.status as string,
        outcome: "error",
        reasonCode: "history_fetch_failed",
        reason: `Saxo /hist call threw: ${histError}`,
      });
    }

    // ---- Position-based fallback (LIVE tenants with /hist unsupported) ----
    // When history is silent (either 404 for LIVE tenants where Saxo has not
    // enabled the hist endpoint for this client, or genuinely absent), a BUY
    // that has left the working list has almost certainly filled — the
    // authoritative signal is `/port/v1/netpositions/me`. If Saxo really
    // shows the position, mark the order filled at the broker's own
    // AverageOpenPrice instead of guessing via the sim presumption path.
    // This runs before decideSimFill so LIVE never falls back to a
    // heuristic when the broker can give us the truth directly.
    if (!hist && (row.side as string) === "buy") {
      const qty = Number(row.quantity ?? 0);
      if (qty > 0) {
        const positions = await getPositionsByBase();
        const key = baseTicker(row.symbol as string);
        const pos = positions?.get(key) ?? null;
        if (pos && Math.abs(pos.quantity) >= qty - 1e-6 && pos.avgPrice > 0) {
          const resolved = resolveFillRecord({
            symbol: row.symbol as string,
            orderCcy: row.instrument_ccy as string | null,
            brokerCcy: pos.currency ?? null,
            portfolioCurrency,
            candidates: [
              { source: "saxo_position_avg_price", value: pos.avgPrice, raw: false },
              { source: "order_limit_price", value: row.limit_price as number | null, raw: false },
            ],
          });
          const fillPrice = resolved?.fillPrice ?? pos.avgPrice;
          const fillCurrency = resolved?.currency ?? portfolioCurrency;
          const upd = await supabaseAdmin
            .from("live_orders")
            .update({ status: "filled" })
            .eq("id", row.id as string);
          let fillInsertError: string | null = null;
          const ins = await supabaseAdmin.from("live_fills").insert({
            order_id: row.id as string,
            portfolio_id: portfolioId,
            user_id: userId,
            symbol: row.symbol as string,
            side: row.side as string,
            quantity: qty,
            fill_price: fillPrice,
            fee: modelledFillFee({
              symbol: row.symbol as string,
              side: (row.side as string) === "sell" ? "sell" : "buy",
              quantity: qty,
              price: fillPrice,
            }),
            currency: fillCurrency,
            broker_fill_id: brokerOrderId,
            filled_at: new Date().toISOString(),
          });
          if (ins.error && ins.error.code !== "23505") {
            fillInsertError = ins.error.message;
            await supabaseAdmin.from("live_broker_log").insert({
              portfolio_id: portfolioId, user_id: userId, broker: "saxo",
              env: adapter.env, method: "ORDER_RECON_POSITION_FILL_INSERT_FAILED",
              path: "live_fills", status: null,
              request: asJson({ orderId: row.id, brokerOrderId }),
              error: ins.error.message,
            });
          }
          if (!ins.error || ins.error.code === "23505") {
            const { notifyTradeFilled } = await import("./trade-fill-notify.server");
            notifyTradeFilled({
              userId, portfolioId, orderId: row.id as string,
              symbol: row.symbol as string, side: row.side as string,
              quantity: qty, fillPrice: fillPrice,
              currency: fillCurrency,
              source: "reconciler:position",
            });
          }
          if (!ins.error) {
            await placeProtectiveStopAfterBuyFill({
              adapter, portfolioId, userId, orderId: row.id as string,
              symbol: row.symbol as string, side: row.side as string,
              quantity: qty, fillPrice, source: "reconciler:position",
            });
          }
          summary.filled++;
          summary.rows.push({
            orderId: row.id as string, brokerOrderId, symbol: row.symbol as string,
            outcome: "filled", previousStatus: row.status as string, newStatus: "filled",
            filledQuantity: qty, avgFillPrice: fillPrice,
            reason: "confirmed via /port/v1/netpositions/me (hist unavailable)",
          });
          await logReconcileEvent({
            ...commonEvent,
            source: `${source}:position_fill`,
            newStatus: "filled",
            outcome: "filled",
            reasonCode: "broker_history_filled",
            reason: `broker position confirms fill of ${qty} @ ${fillPrice} (hist endpoint unavailable)`,
            filledQuantity: qty,
            avgFillPrice: fillPrice,
            saxoStatus: "position_confirmed",
            saxoReason: upd.error
              ? `status update failed: ${upd.error.message}`
              : fillInsertError
                ? `live_fills insert failed: ${fillInsertError}`
                : null,
            saxoResponse: {
              histError, positionsLoadError,
              position: {
                symbol: pos.symbol, quantity: pos.quantity,
                avgPrice: pos.avgPrice, currency: pos.currency,
              },
            },
          });
          continue;
        }
      }
    }

    // ---- Sell-side position fallback (hist unsupported) ----
    // Mirror image of the buy case: a SELL that has left the working list and
    // whose symbol is no longer in `/port/v1/netpositions/me` has completed —
    // the broker closed the position. Without this, the row sat at
    // `submitted` for a full day until the sim presumption rule fired, and
    // the engine refused to trade that symbol in the meantime.
    if (!hist && (row.side as string) === "sell") {
      const qty = Number(row.quantity ?? 0);
      const positions = await getPositionsByBase();
      const key = baseTicker(row.symbol as string);
      const pos = positions?.get(key) ?? null;
      const positionGone = positions != null && (!pos || Math.abs(Number(pos.quantity ?? 0)) < 1e-6);
      if (qty > 0 && positionGone) {
        const priceRow = await supabaseAdmin
          .from("price_cache")
          .select("close")
          .eq("symbol", row.symbol as string)
          .order("price_date", { ascending: false })
          .limit(1)
          .maybeSingle();
        const resolved = resolveFillRecord({
          symbol: row.symbol as string,
          orderCcy: row.instrument_ccy as string | null,
          portfolioCurrency,
          candidates: [
            { source: "order_limit_price", value: row.limit_price as number | null, raw: false },
            { source: "price_cache_close", value: priceRow.data?.close ?? null, raw: true },
          ],
        });
        const upd = await supabaseAdmin
          .from("live_orders")
          .update({ status: "filled" })
          .eq("id", row.id as string);

        let fillInsertError: string | null = null;
        if (resolved) {
          const ins = await supabaseAdmin.from("live_fills").insert({
            order_id: row.id as string,
            portfolio_id: portfolioId,
            user_id: userId,
            symbol: row.symbol as string,
            side: "sell",
            quantity: qty,
            fill_price: resolved.fillPrice,
            fee: modelledFillFee({
              symbol: row.symbol as string,
              side: "sell",
              quantity: qty,
              price: resolved.fillPrice,
            }),
            currency: resolved.currency,
            broker_fill_id: brokerOrderId,
            filled_at: new Date().toISOString(),
          });
          if (ins.error && ins.error.code !== "23505") {
            fillInsertError = ins.error.message;
            await supabaseAdmin.from("live_broker_log").insert({
              portfolio_id: portfolioId, user_id: userId, broker: "saxo",
              env: adapter.env, method: "ORDER_RECON_POSITION_SELL_INSERT_FAILED",
              path: "live_fills", status: null,
              request: asJson({ orderId: row.id, brokerOrderId }),
              error: ins.error.message,
            });
          }
          if (!ins.error || ins.error.code === "23505") {
            const { notifyTradeFilled } = await import("./trade-fill-notify.server");
            notifyTradeFilled({
              userId, portfolioId, orderId: row.id as string,
              symbol: row.symbol as string, side: "sell",
              quantity: qty, fillPrice: resolved.fillPrice,
              currency: resolved.currency,
              source: "reconciler:position",
            });
          }
        } else {
          fillInsertError = "fill_price_unavailable";
        }

        summary.filled++;
        summary.rows.push({
          orderId: row.id as string, brokerOrderId, symbol: row.symbol as string,
          outcome: "filled", previousStatus: row.status as string, newStatus: "filled",
          filledQuantity: qty, avgFillPrice: resolved?.fillPrice ?? null,
          reason: "position closed at broker (hist unavailable)",
        });
        await logReconcileEvent({
          ...commonEvent,
          source: `${source}:position_sell`,
          newStatus: "filled",
          outcome: "filled",
          reasonCode: "broker_history_filled",
          reason: `broker no longer holds ${row.symbol as string}; sell of ${qty} treated as complete (hist endpoint unavailable)`,
          filledQuantity: qty,
          avgFillPrice: resolved?.fillPrice ?? null,
          saxoStatus: "position_absent",
          saxoReason:
            (upd.error ? `status update failed: ${upd.error.message}` : null) ??
            (fillInsertError ? `live_fills: ${fillInsertError}` : null),
          saxoResponse: { histError, positionsLoadError },
        });
        continue;
      }
    }

    if (!hist) {

      // Saxo `/hist/v3/orders` is unavailable (SIM tenants + some LIVE
      // configurations). Delegate to the shared, unit-tested `decideSimFill`
      // rule so the reconciler and the manual backfill agree on when a
      // silent order can be presumed filled, presumed rejected, or must be
      // left alone. This is the SINGLE place presumption logic lives — do
      // not reintroduce inline age/type checks here.
      const orderType = String(row.order_type ?? "market").toLowerCase();
      const qty = Number(row.quantity ?? 0);
      // Market-hours context. If the venue has not been open at all since
      // the order was submitted, we defer any presumption — the reconciler
      // physically cannot infer a fill from a session that never happened.
      const marketStatus = getMarketStatusForSymbol(row.symbol as string);
      const submittedIso = (row.submitted_at as string | null) ?? (row.created_at as string | null);
      const submittedMs = submittedIso ? new Date(submittedIso).getTime() : null;
      const hadOpen = submittedMs != null
        ? marketHadOpenPeriod(inferVenue(row.symbol as string), submittedMs, Date.now())
        : true; // if we can't age the order, don't block on market hours
      const decision = decideSimFill({
        orderType,
        status: row.status as string,
        submittedAt: (row.submitted_at as string | null) ?? null,
        createdAt: (row.created_at as string | null) ?? null,
        quantity: qty,
        hasBrokerOrderId: true,
        marketHadOpenPeriod: hadOpen,
        venueLabel: marketStatus.venue,
        nextOpenIso: marketStatus.nextOpenIso,
      });

      if (decision.kind === "presumed_filled") {
        // Best-effort fill price for display only. Broker-side cash truth
        // still comes from the /port/v1/positions reconcile. The order's
        // own limit_price is the price the decision was sized against, so
        // it beats a possibly-stale cache close; the cache is the backstop.
        const priceRow = await supabaseAdmin
          .from("price_cache")
          .select("close")
          .eq("symbol", row.symbol as string)
          .order("price_date", { ascending: false })
          .limit(1)
          .maybeSingle();
        const candidates: FillPriceCandidate[] = [
          { source: "order_limit_price", value: row.limit_price as number | null, raw: false },
          { source: "price_cache_close", value: priceRow.data?.close ?? null, raw: true },
        ];
        const resolved = resolveFillRecord({
          symbol: row.symbol as string,
          orderCcy: row.instrument_ccy as string | null,
          portfolioCurrency,
          candidates,
        });
        const fillPrice = resolved?.fillPrice ?? null;

        const upd = await supabaseAdmin
          .from("live_orders")
          .update({ status: "filled" })
          .eq("id", row.id as string);

        let fillInsertError: string | null = null;
        if (qty > 0 && !resolved) {
          // No usable price anywhere. Booking `0` here is what produced the
          // phantom "free trade" rows — skip the insert and log instead, so
          // the next reconcile pass can write a real one.
          fillInsertError = "fill_price_unavailable";
          await supabaseAdmin.from("live_broker_log").insert({
            portfolio_id: portfolioId, user_id: userId, broker: "saxo",
            env: adapter.env, method: "ORDER_RECON_FILL_PRICE_UNAVAILABLE",
            path: "live_fills", status: null,
            request: asJson({
              orderId: row.id, brokerOrderId, symbol: row.symbol,
              tried: candidates.map((c) => c.source),
            }),
            error: "no positive fill price from limit_price or price_cache; fill row skipped",
          });
        } else if (qty > 0 && resolved) {
          const ins = await supabaseAdmin.from("live_fills").insert({
            order_id: row.id as string,
            portfolio_id: portfolioId,
            user_id: userId,
            symbol: row.symbol as string,
            side: row.side as string,
            quantity: qty,
            fill_price: resolved.fillPrice,
            fee: modelledFillFee({
              symbol: row.symbol as string,
              side: (row.side as string) === "sell" ? "sell" : "buy",
              quantity: qty,
              price: resolved.fillPrice,
            }),
            currency: resolved.currency,
            broker_fill_id: brokerOrderId,
            filled_at: new Date().toISOString(),
          });
          if (ins.error && ins.error.code !== "23505") {
            fillInsertError = ins.error.message;
            await supabaseAdmin.from("live_broker_log").insert({
              portfolio_id: portfolioId, user_id: userId, broker: "saxo",
              env: adapter.env, method: "ORDER_RECON_PRESUMED_FILL_INSERT_FAILED",
              path: "live_fills", status: null,
              request: asJson({ orderId: row.id, brokerOrderId }),
              error: ins.error.message,
            });
          }
          if (!ins.error) {
            await placeProtectiveStopAfterBuyFill({
              adapter, portfolioId, userId, orderId: row.id as string,
              symbol: row.symbol as string, side: row.side as string,
              quantity: qty, fillPrice: resolved.fillPrice, source: "reconciler:presumed",
            });
          }
        }

        if (qty > 0 && resolved) {
          const { notifyTradeFilled } = await import("./trade-fill-notify.server");
          notifyTradeFilled({
            userId, portfolioId, orderId: row.id as string,
            symbol: row.symbol as string, side: row.side as string,
            quantity: qty, fillPrice: resolved.fillPrice,
            currency: resolved.currency, source: "reconciler:presumed",
          });
        }

        summary.filled++;
        summary.rows.push({
          orderId: row.id as string, brokerOrderId, symbol: row.symbol as string,
          outcome: "filled", previousStatus: row.status as string, newStatus: "filled",
          filledQuantity: qty, avgFillPrice: fillPrice || null,
          reason: `presumed filled — ${decision.reason}`,
        });
        await logReconcileEvent({
          ...commonEvent,
          source: `${source}:presumed_fill`,
          newStatus: "filled",
          outcome: "filled",
          reasonCode:
            (row.status as string).toLowerCase() === "partial"
              ? "sim_presumed_filled_partial"
              : "sim_presumed_filled_market",
          reason: `${decision.reason} (age ${Math.round(decision.ageMs / 1000)}s)`,
          filledQuantity: qty,
          avgFillPrice: fillPrice || null,
          saxoStatus: workingListError ? "open_list_unavailable" : "absent_from_open_list",
          saxoReason:
            (upd.error ? `status update failed: ${upd.error.message}` : null) ??
            (fillInsertError ? `live_fills insert failed: ${fillInsertError}` : null),
          saxoResponse: { workingListError, histError, priceUsed: fillPrice, decision },
        });
        continue;
      }

      if (decision.kind === "presumed_rejected") {
        await supabaseAdmin
          .from("live_orders")
          .update({ status: "rejected", reject_reason: decision.reason })
          .eq("id", row.id as string);

        summary.rejected++;
        summary.rows.push({
          orderId: row.id as string, brokerOrderId, symbol: row.symbol as string,
          outcome: "rejected", previousStatus: row.status as string, newStatus: "rejected",
          filledQuantity: 0, avgFillPrice: null,
          reason: `presumed rejected — ${decision.reason}`,
        });
        await logReconcileEvent({
          ...commonEvent,
          source: `${source}:presumed_reject`,
          newStatus: "rejected",
          outcome: "rejected",
          reasonCode:
            orderType === "market"
              ? "sim_presumed_rejected_stale"
              : "sim_presumed_cancelled_limit_stale",
          reason: `${decision.reason} (age ${Math.round(decision.ageMs / 1000)}s)`,
          saxoStatus: workingListError ? "open_list_unavailable" : "absent_from_open_list",
          saxoResponse: { workingListError, histError, decision },
        });
        continue;
      }

      // decision.kind === "keep"
      const keptForClosedMarket = !hadOpen && orderType === "market";
      const keptForClosedMarketLimit = !hadOpen && orderType !== "market";
      summary.unknown++;
      summary.rows.push({
        orderId: row.id as string, brokerOrderId, symbol: row.symbol as string,
        outcome: "unknown", previousStatus: row.status as string, newStatus: row.status as string,
        filledQuantity: 0, avgFillPrice: null,
        reason: decision.reason,
      });
      await logReconcileEvent({
        ...commonEvent,
        source,
        newStatus: row.status as string,
        outcome: "unknown",
        reasonCode: keptForClosedMarketLimit
          ? "sim_defer_stale_market_closed"
          : keptForClosedMarket
            ? "sim_keep_market_closed"
            : "sim_keep_awaiting_broker",
        reason: decision.reason,
        saxoStatus: "absent_from_open_list",
        saxoResponse: {
          workingListError, histError, decision,
          marketStatus: {
            venue: marketStatus.venue,
            phase: marketStatus.phase,
            isOpen: marketStatus.isOpen,
            nextOpenIso: marketStatus.nextOpenIso,
            marketHadOpenPeriodSinceSubmit: hadOpen,
          },
        },
      });
      continue;
    }


    const mapped = mapSaxoStatus(hist.status, hist.filledAmount, hist.amount);
    if (mapped === "unknown") {
      summary.unknown++;
      summary.rows.push({
        orderId: row.id as string, brokerOrderId, symbol: row.symbol as string,
        outcome: "unknown", previousStatus: row.status as string, newStatus: row.status as string,
        filledQuantity: hist.filledAmount, avgFillPrice: hist.avgPrice,
        reason: `unrecognised Saxo status "${hist.status}"`,
      });
      await logReconcileEvent({
        ...commonEvent,
        newStatus: row.status as string,
        outcome: "unknown",
        reasonCode: "broker_history_unknown_status",
        reason: `Saxo returned unrecognised status "${hist.status}"`,
        filledQuantity: hist.filledAmount,
        avgFillPrice: hist.avgPrice,
        saxoStatus: hist.status,
        saxoReason: hist.reason ?? null,
        saxoFilledAt: hist.filledAt ?? null,
        saxoResponse: hist,
      });
      continue;
    }

    const upd = await supabaseAdmin
      .from("live_orders")
      .update({
        status: mapped,
        reject_reason: mapped === "rejected" ? (hist.reason ?? "rejected by broker") : null,
      })
      .eq("id", row.id as string);
    if (upd.error) {
      await logReconcileEvent({
        ...commonEvent,
        newStatus: row.status as string,
        outcome: "error",
        reasonCode: "status_update_failed",
        reason: `failed to update live_orders.status to ${mapped}: ${upd.error.message}`,
        saxoStatus: hist.status,
        saxoResponse: hist,
      });
    }

    let fillInsertError: string | null = null;
    // Resolved once so the insert, the notification and the summary row
    // all quote the same price and currency.
    const histCandidates: FillPriceCandidate[] = [
      { source: "saxo_hist_avg_price", value: hist?.avgPrice ?? null, raw: false },
      { source: "order_limit_price", value: row.limit_price as number | null, raw: false },
    ];
    const histFill =
      hist && (mapped === "filled" || mapped === "partial") && hist.filledAmount > 0
        ? resolveFillRecord({
            symbol: row.symbol as string,
            orderCcy: row.instrument_ccy as string | null,
            portfolioCurrency,
            candidates: histCandidates,
          })
        : null;

    if (hist && (mapped === "filled" || mapped === "partial") && hist.filledAmount > 0) {
      if (!histFill) {
        // Saxo returned no average price and the order carried no limit
        // price. Writing `0` here is what created the phantom zero-cost
        // fills — skip and log so a later pass can book the real number.
        fillInsertError = "fill_price_unavailable";
        await supabaseAdmin.from("live_broker_log").insert({
          portfolio_id: portfolioId, user_id: userId, broker: "saxo",
          env: adapter.env, method: "ORDER_RECON_FILL_PRICE_UNAVAILABLE",
          path: "live_fills", status: null,
          request: asJson({
            orderId: row.id, brokerOrderId, symbol: row.symbol,
            tried: histCandidates.map((c) => c.source),
          }),
          error: "no positive fill price from Saxo /hist or order limit_price; fill row skipped",
        });
        await logReconcileEvent({
          ...commonEvent,
          newStatus: mapped,
          outcome: "error",
          reasonCode: "fill_insert_failed",
          reason: "live_fills insert skipped: no usable fill price",
          filledQuantity: hist.filledAmount,
          avgFillPrice: null,
          saxoStatus: hist.status,
          saxoResponse: hist,
        });
      } else {
        // Insert (idempotent-ish): broker_fill_id = brokerOrderId means one row
        // per broker order. If the row already exists we skip on unique-violation.
        const ins = await supabaseAdmin.from("live_fills").insert({
          order_id: row.id as string,
          portfolio_id: portfolioId,
          user_id: userId,
          symbol: row.symbol as string,
          side: row.side as string,
          quantity: hist.filledAmount,
          fill_price: histFill.fillPrice,
          fee: modelledFillFee({
            symbol: row.symbol as string,
            side: (row.side as string) === "sell" ? "sell" : "buy",
            quantity: hist.filledAmount,
            price: histFill.fillPrice,
          }),
          currency: histFill.currency,
          broker_fill_id: brokerOrderId,
          filled_at: hist.filledAt ?? new Date().toISOString(),
        });
        if (ins.error && ins.error.code !== "23505") {
          fillInsertError = ins.error.message;
          // Non-duplicate insert failures should surface in the log but not fail
          // the whole reconcile pass.
          await supabaseAdmin.from("live_broker_log").insert({
            portfolio_id: portfolioId, user_id: userId, broker: "saxo",
            env: adapter.env, method: "ORDER_RECON_FILL_INSERT_FAILED",
            path: "live_fills", status: null,
            request: asJson({ orderId: row.id, brokerOrderId }),
            error: ins.error.message,
          });
          await logReconcileEvent({
            ...commonEvent,
            newStatus: mapped,
            outcome: "error",
            reasonCode: "fill_insert_failed",
            reason: `live_fills insert failed: ${ins.error.message}`,
            filledQuantity: hist.filledAmount,
            avgFillPrice: histFill.fillPrice,
            saxoStatus: hist.status,
            saxoResponse: hist,
          });
        }
        if (!ins.error) {
          await placeProtectiveStopAfterBuyFill({
            adapter, portfolioId, userId, orderId: row.id as string,
            symbol: row.symbol as string, side: row.side as string,
            quantity: hist.filledAmount, fillPrice: histFill.fillPrice,
            source: "reconciler:history",
          });
        }
      }
    }

    if (histFill && hist && hist.filledAmount > 0 && !fillInsertError) {
      const { notifyTradeFilled } = await import("./trade-fill-notify.server");
      notifyTradeFilled({
        userId, portfolioId, orderId: row.id as string,
        symbol: row.symbol as string, side: row.side as string,
        quantity: hist.filledAmount, fillPrice: histFill.fillPrice,
        currency: histFill.currency, source: "reconciler:history",
      });
    }


    if (mapped === "filled") summary.filled++;
    else if (mapped === "partial") summary.partial++;
    else if (mapped === "rejected") summary.rejected++;
    else if (mapped === "cancelled") summary.cancelled++;

    summary.rows.push({
      orderId: row.id as string,
      brokerOrderId,
      symbol: row.symbol as string,
      outcome: mapped === "submitted" ? "still_working" : mapped,
      previousStatus: row.status as string,
      newStatus: mapped,
      filledQuantity: hist.filledAmount,
      avgFillPrice: hist.avgPrice,
      reason: mapped === "rejected" ? hist.reason : undefined,
    });

    const reasonCode: ReconcileReasonCode =
      mapped === "filled" ? "broker_history_filled"
      : mapped === "partial" ? "broker_history_partial"
      : mapped === "rejected" ? "broker_history_rejected"
      : mapped === "cancelled" ? "broker_history_cancelled"
      : "broker_open_working";
    await logReconcileEvent({
      ...commonEvent,
      newStatus: mapped,
      outcome: mapped === "submitted" ? "still_working" : mapped,
      reasonCode,
      reason:
        mapped === "rejected"
          ? `broker rejected order: ${hist.reason ?? "no reason provided"}`
          : mapped === "cancelled"
            ? `broker cancelled order${hist.reason ? `: ${hist.reason}` : ""}`
            : mapped === "filled"
              ? `broker confirmed full fill of ${hist.filledAmount} @ ${hist.avgPrice ?? "n/a"}`
              : mapped === "partial"
                ? `broker confirmed partial fill of ${hist.filledAmount}/${hist.amount} @ ${hist.avgPrice ?? "n/a"}`
                : `broker still working ${hist.filledAmount}/${hist.amount}`,
      filledQuantity: hist.filledAmount,
      avgFillPrice: hist.avgPrice,
      saxoStatus: hist.status,
      saxoReason: hist.reason ?? null,
      saxoFilledAt: hist.filledAt ?? null,
      saxoResponse: fillInsertError ? { ...hist, fillInsertError } : hist,
    });
  }

  await supabaseAdmin.from("live_broker_log").insert({
    portfolio_id: portfolioId, user_id: userId, broker: "saxo",
    env: adapter.env, method: "ORDER_RECON",
    path: "/reconcile/orders", status: 200,
    request: asJson({ lookbackHours, scanned: summary.scanned }),
    response: asJson({
      filled: summary.filled, partial: summary.partial, rejected: summary.rejected,
      cancelled: summary.cancelled, stillWorking: summary.stillWorking, unknown: summary.unknown,
    }),
  });

  // A fill/partial/cancel means the broker's positions or cash just moved.
  // Re-value immediately rather than letting the app sit stale until the
  // next hourly tick.
  if (summary.filled > 0 || summary.partial > 0 || summary.cancelled > 0) {
    const { triggerLiveValuationRefresh } = await import(
      "@/lib/live-valuation-trigger.server"
    );
    triggerLiveValuationRefresh({
      portfolioId,
      userId,
      reason: `order-recon:${source}`,
    });
  }

  return summary;
}
