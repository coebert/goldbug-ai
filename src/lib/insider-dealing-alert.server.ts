// Immediate alert when a director / PDMR *disposal* is reported for a ticker
// the book actually holds.
//
// A sale by an insider in a concentrated position is the kind of thing that
// should reach the owner within minutes, not on the next dashboard visit, so
// this writes an in-app notification (category `insider_dealing`) plus a web
// push the moment the ingester stores a new sell event.
//
// De-duplication is per user per event (symbol + date + headline), so a
// re-ingest, a manual refresh and the hourly run cannot triple-notify.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendPushToUser } from "@/lib/push.server";
import { engineSymbolKey } from "@/lib/price-symbol";
import {
  insiderEventKey,
  insiderAlertSeverity,
  insiderAlertText,
  type InsiderDealingEvent,
} from "@/lib/insider-dealings";

type Sb = { from: (table: string) => any };

/** Owners (user ids) that currently hold the given engine symbol. */
export async function holdersOfSymbol(supabase: Sb, symbol: string): Promise<string[]> {
  const key = engineSymbolKey(symbol).toUpperCase();
  const { data } = await supabase
    .from("holdings")
    .select("symbol, quantity, portfolio_id, portfolios(user_id)")
    .limit(1000);

  const users = new Set<string>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const qty = Number(row["quantity"]);
    if (!Number.isFinite(qty) || qty === 0) continue;
    if (engineSymbolKey(String(row["symbol"] ?? "")).toUpperCase() !== key) continue;
    const rel = row["portfolios"] as { user_id?: string } | Array<{ user_id?: string }> | null;
    const uid = Array.isArray(rel) ? rel[0]?.user_id : rel?.user_id;
    if (uid) users.add(uid);
  }
  return [...users];
}

export type InsiderAlertResult = { considered: number; sent: number };

/**
 * Fires alerts for newly detected disposals. Only sell-side events reach the
 * owner: an insider *buy* is good news and never urgent.
 */
export async function alertInsiderDisposals(
  events: InsiderDealingEvent[],
  opts: { supabase?: Sb } = {},
): Promise<InsiderAlertResult> {
  const supabase = opts.supabase ?? (supabaseAdmin as unknown as Sb);
  const disposals = events.filter((e) => e.direction === "sell");
  if (disposals.length === 0) return { considered: 0, sent: 0 };

  let sent = 0;
  for (const event of disposals) {
    try {
      const holders = await holdersOfSymbol(supabase, event.symbol);
      if (holders.length === 0) continue;

      const eventKey = insiderEventKey(event);
      const severity = insiderAlertSeverity(event);
      const { title, body } = insiderAlertText(event);
      const url = `/market/${encodeURIComponent(event.symbol)}`;

      for (const userId of holders) {
        const { data: existing } = await supabase
          .from("notifications")
          .select("id")
          .eq("user_id", userId)
          .eq("category", "insider_dealing")
          .contains("details", { event_key: eventKey })
          .limit(1);
        if ((existing ?? []).length > 0) continue;

        await supabase.from("notifications").insert({
          user_id: userId,
          category: "insider_dealing",
          severity,
          title,
          body,
          details: {
            event_key: eventKey,
            symbol: event.symbol,
            company: event.company,
            event_date: event.event_date,
            direction: event.direction,
            flavour: event.flavour,
            person: event.person,
            role: event.role,
            shares: event.shares,
            value: event.value,
            source: event.source,
            headline: event.headline,
            link: event.url,
            sentiment_nudge: event.sentiment_nudge,
            url,
          },
        });

        await sendPushToUser(userId, {
          title,
          body,
          url,
          tag: `insider-${eventKey}`,
        });
        sent += 1;
      }
    } catch (err) {
      console.error("alertInsiderDisposals failed", err);
    }
  }

  return { considered: disposals.length, sent };
}
