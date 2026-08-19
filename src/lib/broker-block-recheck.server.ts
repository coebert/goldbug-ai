// Server side of "Re-check Saxo blocks": probe each learned block with a
// broker-side order precheck (a dry run — no order is ever submitted) and lift
// the blocks the broker no longer refuses.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  decideRecheck,
  summariseRecheck,
  type RecheckDecision,
  type RecheckSymbolResult,
} from "@/lib/broker-block-recheck";
import {
  clearBrokerBlock,
  loadActiveBrokerBlocks,
} from "@/lib/broker-instrument-blocks.server";
import { resolvePortfolioBrokerLink } from "@/lib/brokers/portfolio-broker-link.server";

/** Prefer a real-money Saxo-linked portfolio, else any Saxo-linked one. */
async function resolveProbeAccount(userId: string): Promise<
  { portfolioId: string; accountKey: string; env: "sim" | "live" } | null
> {
  const { data } = await supabaseAdmin
    .from("portfolios")
    .select("id, mode, broker, broker_account_id")
    .eq("user_id", userId)
    .eq("broker", "saxo");

  const rows = data ?? [];
  const ordered = [...rows].sort((a, b) =>
    (a.mode === "live_prod" ? 0 : 1) - (b.mode === "live_prod" ? 0 : 1),
  );
  for (const row of ordered) {
    const link = resolvePortfolioBrokerLink(row);
    if (link.linked) {
      return {
        portfolioId: row.id as string,
        accountKey: link.accountKey,
        env: row.mode === "live_prod" ? "live" : "sim",
      };
    }
  }
  return null;
}

export async function recheckBrokerBlocks(args: {
  userId: string;
  broker?: string;
}): Promise<{
  checked: number;
  cleared: number;
  stillBlocked: number;
  unknown: number;
  message: string;
  results: RecheckSymbolResult[];
}> {
  const broker = args.broker ?? "saxo";
  const blocks = await loadActiveBrokerBlocks(args.userId, broker);
  if (blocks.length === 0) {
    return { ...summariseRecheck([]), results: [] };
  }

  const account = await resolveProbeAccount(args.userId);
  if (!account) {
    const results: RecheckSymbolResult[] = blocks.map((b) => ({
      symbol: b.symbol,
      symbolKey: b.symbolKey,
      outcome: "unknown",
      note: "No Saxo-linked portfolio available to run the check.",
    }));
    return { ...summariseRecheck(results), results };
  }

  const { buildSaxoAdapter } = await import("@/lib/brokers/saxo.server");
  let adapter: Awaited<ReturnType<typeof buildSaxoAdapter>>;
  try {
    adapter = await buildSaxoAdapter({
      userId: args.userId,
      portfolioId: account.portfolioId,
      envOverride: account.env,
      accountKey: account.accountKey,
    });
  } catch {
    const results: RecheckSymbolResult[] = blocks.map((b) => ({
      symbol: b.symbol,
      symbolKey: b.symbolKey,
      outcome: "unknown",
      note: "Saxo connection unavailable — reconnect the broker and try again.",
    }));
    return { ...summariseRecheck(results), results };
  }

  const results: RecheckSymbolResult[] = [];
  for (const block of blocks) {
    let decision: RecheckDecision;
    try {
      const probe = await adapter.precheckSymbol(block.symbol, { quantity: 1 });
      decision = decideRecheck(probe);
    } catch {
      decision = decideRecheck({ ok: false, failed: true });
    }

    if (decision.outcome === "cleared") {
      const cleared = await clearBrokerBlock({
        userId: args.userId,
        symbolKey: block.symbolKey,
        broker,
      });
      if (cleared === 0) {
        decision = { outcome: "unknown", note: "Block could not be cleared — try again." };
      }
    }

    results.push({ ...decision, symbol: block.symbol, symbolKey: block.symbolKey });
  }

  return { ...summariseRecheck(results), results };
}
