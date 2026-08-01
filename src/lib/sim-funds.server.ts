// Server-only handler for adding simulated funds. Kept as a pure function
// (not a createServerFn) so unit tests can invoke it with a hand-rolled
// Supabase mock. See src/lib/__tests__/add-sim-funds.test.ts.

import { writeEquitySnapshot } from "./valuation/write-snapshot.server";

export async function addSimFundsHandler(
  data: { id: string; amount: number },
  // Supabase client typing is intentionally loose here so tests can pass a
  // hand-rolled builder mock; the runtime call sites use the fully-typed
  // context.supabase from requireSupabaseAuth.
  supabase: {
    from: (table: string) => {
      select: (cols: string) => {
        eq: (col: string, val: string) => {
          single: () => Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
          order?: (col: string, opts: { ascending: boolean }) => {
            limit: (n: number) => {
              maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
            };
          };
        };
      };
      update: (patch: Record<string, unknown>) => {
        eq: (col: string, val: string) => {
          select: (cols: string) => {
            single: () => Promise<{ data: { id: string; starting_cash: number; current_cash: number; currency: string } | null; error: { message: string } | null }>;
          };
        };
      };
      insert: (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
      upsert: (row: Record<string, unknown>, opts: { onConflict: string }) => Promise<{ error: { message: string } | null }>;
    };
  },
  userId: string,
) {
  const { data: p, error: readErr } = await supabase
    .from("portfolios")
    .select("id, mode, currency, starting_cash, current_cash")
    .eq("id", data.id)
    .single();
  if (readErr) throw new Error(readErr.message);
  if (!p) throw new Error("Portfolio not found");
  if (p.mode === "live_prod") {
    throw new Error("Real-money portfolios are funded via your broker account, not from here.");
  }
  const newStarting = Number(p.starting_cash) + data.amount;
  const newCurrent = Number(p.current_cash) + data.amount;
  const { data: updated, error } = await supabase
    .from("portfolios")
    .update({ starting_cash: newStarting, current_cash: newCurrent })
    .eq("id", data.id)
    .select("id, starting_cash, current_cash, currency")
    .single();
  if (error) throw new Error(error.message);
  await supabase.from("sim_fund_events").insert({
    portfolio_id: data.id,
    user_id: userId,
    amount: data.amount,
    currency: p.currency,
    balance_after: newCurrent,
  });

  // Keep the equity snapshot for today in sync so the dashboard's
  // "Simulated equity" summary (derived from equity_snapshots) reflects
  // the top-up immediately, not after the next hourly run.
  const today = new Date().toISOString().slice(0, 10);
  const latestQ = supabase
    .from("equity_snapshots")
    .select("snapshot_date, cash, holdings_value, total_value")
    .eq("portfolio_id", data.id);
  const latestOrder = latestQ.order?.("snapshot_date", { ascending: false });
  const latest = latestOrder
    ? (await latestOrder.limit(1).maybeSingle()).data
    : null;
  const holdingsValue = Number(latest?.holdings_value ?? 0);
  const snapshotCash =
    latest && latest.snapshot_date === today
      ? Number(latest.cash) + data.amount
      : newCurrent;
  const snapshotTotal = snapshotCash + holdingsValue;
  await writeEquitySnapshot(supabase as never, {
    portfolioId: data.id,
    snapshotDate: today,
    cash: snapshotCash,
    holdingsValue,
    totalValue: snapshotTotal,
    currency: String(p.currency ?? "GBP"),
    source: "fund_event",
  });

  return { ok: true, portfolio: updated };
}
