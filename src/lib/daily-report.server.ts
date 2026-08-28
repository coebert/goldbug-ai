// Daily AI report — for a given run date, roll up every asset the engine
// considered for each of the caller's portfolios, split into what it bought,
// what it sold, what it held and what it passed on (with the reason), and
// wrap the whole thing in a short plain-English narrative.
//
// Reads run under the caller's own RLS-scoped client.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { generateText } from "ai";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";
import { labelBlock } from "./decision-summary.helpers";
import { holdingNativeValue, isFxLegHolding } from "./fx-leg-value";
import { ukDayKey } from "./uk-time";


export type DailyReportItem = {
  symbol: string;
  action: "buy" | "sell" | "hold" | null;
  outcome: string | null;
  /** Why the AI wanted to act (its own rationale), when recorded. */
  rationale: string | null;
  /** Why it did NOT act — guardrail / broker / engine reason. */
  passedReason: string | null;
  notional: number | null;
  price: number | null;
  conviction: number | null;
  decidedAt: string | null;
};

/**
 * An open FX spot funding leg (e.g. a short GBPUSD the engine opened to fund a
 * USD buy). Its notional already sits in the cash wallet, so only the
 * unrealised P&L is economically live — the report says so explicitly.
 */
export type DailyReportFxLeg = {
  symbol: string;
  direction: "long" | "short";
  quantity: number;
  entryRate: number;
  currentRate: number | null;
  quoteCcy: string;
  /** quantity x (current − entry), in the quote currency. Null without a rate. */
  unrealisedPnl: number | null;
  /** |quantity| x rate — shown for context only; it is not extra equity. */
  notional: number | null;
};

export type DailyReportPortfolio = {
  portfolioId: string;
  name: string;
  mode: string | null;
  currency: string;
  narrative: string;
  narrativeModel: string | null;
  runExplanation: string | null;
  considered: number;
  bought: DailyReportItem[];
  sold: DailyReportItem[];
  held: DailyReportItem[];
  passed: DailyReportItem[];
  passReasonCounts: Array<{ reason: string; count: number }>;
  fxLegs: DailyReportFxLeg[];
};

export type DailyReport = {
  date: string;
  generatedAt: string;
  portfolios: DailyReportPortfolio[];
};

const TRADED = new Set(["filled", "partial", "placed", "pending"]);

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function money(n: number | null, ccy: string): string {
  if (n == null) return "—";
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: ccy || "GBP",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${Math.round(n)} ${ccy}`;
  }
}

export function buildDeterministicNarrative(p: {
  name: string;
  currency: string;
  considered: number;
  bought: DailyReportItem[];
  sold: DailyReportItem[];
  held: DailyReportItem[];
  passed: DailyReportItem[];
  passReasonCounts: Array<{ reason: string; count: number }>;
  fxLegs?: DailyReportFxLeg[];
}): string {
  if (p.considered === 0) {
    return `No AI decisions were recorded for ${p.name} on this date — the engine either did not run or found nothing in its universe to assess.`;
  }
  const bits: string[] = [
    `${p.name}: the AI looked at ${p.considered} asset${p.considered === 1 ? "" : "s"}.`,
  ];
  if (p.bought.length) {
    bits.push(
      `It bought ${p.bought
        .slice(0, 4)
        .map((b) => `${b.symbol} (${money(b.notional, p.currency)})`)
        .join(", ")}${p.bought.length > 4 ? ` and ${p.bought.length - 4} more` : ""}.`,
    );
  }
  if (p.sold.length) {
    bits.push(
      `It sold ${p.sold
        .slice(0, 4)
        .map((s) => `${s.symbol} (${money(s.notional, p.currency)})`)
        .join(", ")}${p.sold.length > 4 ? ` and ${p.sold.length - 4} more` : ""}.`,
    );
  }
  if (!p.bought.length && !p.sold.length) bits.push("It placed no orders.");
  if (p.held.length) bits.push(`It left ${p.held.length} existing position${p.held.length === 1 ? "" : "s"} alone.`);
  if (p.passed.length) {
    const top = p.passReasonCounts
      .slice(0, 3)
      .map((r) => `${r.count} × ${r.reason.toLowerCase()}`)
      .join(", ");
    bits.push(
      `It passed on ${p.passed.length} candidate${p.passed.length === 1 ? "" : "s"}${top ? ` — mostly ${top}` : ""}.`,
    );
  }
  for (const leg of p.fxLegs ?? []) {
    const pnl =
      leg.unrealisedPnl == null
        ? "no current rate available"
        : `${leg.unrealisedPnl >= 0 ? "up" : "down"} ${money(Math.abs(leg.unrealisedPnl), leg.quoteCcy)}`;
    bits.push(
      `It still holds a ${leg.direction} ${leg.symbol} currency funding leg entered at ${leg.entryRate.toFixed(4)}${
        leg.currentRate != null ? ` (now ${leg.currentRate.toFixed(4)})` : ""
      }, ${pnl}; its cash is already counted, so only that profit or loss moves the account.`,
    );
  }
  return bits.join(" ");
}

async function narrate(
  p: DailyReportPortfolio,
  date: string,
  fallback: string,
): Promise<{ text: string; model: string | null }> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) return { text: fallback, model: null };
  if (p.considered === 0) return { text: fallback, model: null };

  const payload = {
    date,
    portfolio: p.name,
    currency: p.currency,
    considered: p.considered,
    bought: p.bought.slice(0, 8).map((i) => ({
      symbol: i.symbol,
      notional: i.notional,
      outcome: i.outcome,
      why: i.rationale?.slice(0, 200) ?? null,
    })),
    sold: p.sold.slice(0, 8).map((i) => ({
      symbol: i.symbol,
      notional: i.notional,
      outcome: i.outcome,
      why: i.rationale?.slice(0, 200) ?? null,
    })),
    held: p.held.slice(0, 8).map((i) => ({ symbol: i.symbol, why: i.rationale?.slice(0, 160) ?? null })),
    passed: p.passed.slice(0, 12).map((i) => ({
      symbol: i.symbol,
      wanted: i.action,
      why_not: i.passedReason?.slice(0, 160) ?? null,
      conviction: i.conviction,
    })),
    pass_reason_counts: p.passReasonCounts.slice(0, 6),
    fx_funding_legs: p.fxLegs.map((l) => ({
      pair: l.symbol,
      direction: l.direction,
      entry_rate: l.entryRate,
      current_rate: l.currentRate,
      unrealised_pnl: l.unrealisedPnl,
      quote_currency: l.quoteCcy,
      note: "notional already sits in cash; only the unrealised P&L changes the account value",
    })),
    engine_run_note: p.runExplanation?.slice(0, 400) ?? null,
  };

  const prompt = `You are writing the end-of-day report for a non-technical private investor who owns this automated trading account.

Write 3-5 short sentences of plain English. No markdown, no bullet points, no headings, no financial advice or predictions.

Cover, in this order:
1. What the AI considered today, in scale terms.
2. Each buy and sell it made and the actual reason given.
3. Any open currency (FX) funding leg: its direction, the rate it was entered at versus now, and whether it is currently up or down. Say plainly that its cash is already counted so only that profit or loss matters.
4. The most notable things it deliberately passed on and why (guardrails, costs, weak signal, broker refusal).
5. One sentence on what that means for the money sitting in the account.

Only use the facts below. If a reason is missing, say the reason was not recorded rather than inventing one.

Data (JSON):
${JSON.stringify(payload)}

Deterministic fallback to rewrite more clearly (keep every fact accurate):
"${fallback}"`;

  try {
    const gateway = createLovableAiGatewayProvider(key);
    const model = "google/gemini-3.6-flash";
    const { text } = await generateText({ model: gateway(model), prompt });
    const cleaned = (text ?? "").replace(/^[\s>*_-]+|\s+$/g, "").slice(0, 1400);
    if (!cleaned) return { text: fallback, model: null };
    return { text: cleaned, model };
  } catch (err) {
    console.warn("daily-report: narrative fell back to deterministic", err);
    return { text: fallback, model: null };
  }
}

export async function buildDailyReport(params: {
  db: SupabaseClient<Database>;
  userId: string;
  date: string;
  portfolioId?: string;
}): Promise<DailyReport> {
  const { db, userId, date } = params;

  let pfq = db
    .from("portfolios")
    .select("id, name, currency, mode")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (params.portfolioId) pfq = pfq.eq("id", params.portfolioId);
  const pf = await pfq;
  if (pf.error) throw new Error(pf.error.message);
  const portfolios = pf.data ?? [];
  if (portfolios.length === 0) {
    return { date, generatedAt: new Date().toISOString(), portfolios: [] };
  }
  const ids = portfolios.map((p) => p.id as string);

  const [auditRes, cfRes, decRes, fxRes] = await Promise.all([
    db
      .from("ai_decision_audit")
      .select(
        "portfolio_id, symbol, action, outcome, outcome_detail, rationale, decided_at, notional, price",
      )
      .in("portfolio_id", ids)
      .eq("run_date", date)
      .order("decided_at", { ascending: true })
      .limit(2000),
    db
      .from("counterfactuals")
      .select("portfolio_id, symbol, side, block_reason, block_category, conviction, hypothetical_spend, created_at")
      .in("portfolio_id", ids)
      .eq("as_of", date)
      .order("created_at", { ascending: true })
      .limit(2000),
    db
      .from("decisions")
      .select("portfolio_id, raw, created_at")
      .in("portfolio_id", ids)
      .eq("run_date", date)
      .order("created_at", { ascending: false })
      .limit(100),
    db
      .from("holdings")
      .select("portfolio_id, symbol, quantity, avg_cost, asset_class, instrument_ccy")
      .in("portfolio_id", ids)
      .limit(500),
  ]);
  if (auditRes.error) throw new Error(auditRes.error.message);
  if (cfRes.error) throw new Error(cfRes.error.message);

  // Open FX funding legs, valued at the live rate. These are a snapshot of
  // positions held RIGHT NOW, and we have no historical as-of store for them,
  // so they may only be reported on today's report — a back-dated report must
  // not claim a leg (or a rate/P&L) that did not exist on that date.
  const fxByP = new Map<string, DailyReportFxLeg[]>();
  if (date === ukDayKey(new Date())) {
    const fxRows = (fxRes.data ?? []).filter((h) =>
      isFxLegHolding({ asset_class: (h as { asset_class?: string | null }).asset_class ?? null }),
    );
    const rateCache = new Map<string, number | null>();
    const { getFxRate } = await import("./fx.server");

    for (const h of fxRows) {
      const symbol = String((h as { symbol: string }).symbol).toUpperCase();
      const qty = num((h as { quantity: unknown }).quantity) ?? 0;
      const entry = num((h as { avg_cost: unknown }).avg_cost) ?? 0;
      if (!qty || !(entry > 0)) continue;
      const baseCcy = symbol.slice(0, 3);
      const quoteCcy =
        String((h as { instrument_ccy?: string | null }).instrument_ccy || symbol.slice(3, 6) || "USD").toUpperCase();
      if (!rateCache.has(symbol)) {
        try {
          const r = await getFxRate(baseCcy, quoteCcy);
          rateCache.set(symbol, Number.isFinite(r.rate) && r.rate > 0 ? r.rate : null);
        } catch {
          rateCache.set(symbol, null);
        }
      }
      const rate = rateCache.get(symbol) ?? null;
      const leg: DailyReportFxLeg = {
        symbol,
        direction: qty < 0 ? "short" : "long",
        quantity: qty,
        entryRate: entry,
        currentRate: rate,
        quoteCcy,
        unrealisedPnl:
          rate == null
            ? null
            : holdingNativeValue({ assetClass: "fx", quantity: qty, price: rate, avgCost: entry }),
        notional: Math.abs(qty) * (rate ?? entry),
      };
      const pid = String((h as { portfolio_id: string }).portfolio_id);
      fxByP.set(pid, [...(fxByP.get(pid) ?? []), leg]);
    }
  }

  const runNoteByP = new Map<string, string>();
  for (const d of decRes.data ?? []) {
    const pid = d.portfolio_id as string;
    if (runNoteByP.has(pid)) continue;
    const raw = (d.raw ?? {}) as { plain_explanation?: unknown };
    const note =
      typeof raw.plain_explanation === "string"
        ? raw.plain_explanation
        : typeof (raw.plain_explanation as { text?: string } | undefined)?.text === "string"
          ? (raw.plain_explanation as { text: string }).text
          : null;
    if (note) runNoteByP.set(pid, note);
  }

  const out: DailyReportPortfolio[] = [];

  for (const p of portfolios) {
    const pid = p.id as string;
    const currency = (p.currency as string) || "GBP";
    const bought: DailyReportItem[] = [];
    const sold: DailyReportItem[] = [];
    const held: DailyReportItem[] = [];
    const passed: DailyReportItem[] = [];
    const seen = new Set<string>();

    for (const r of (auditRes.data ?? []).filter((r) => r.portfolio_id === pid)) {
      const symbol = String(r.symbol);
      seen.add(symbol);
      const action = (r.action as DailyReportItem["action"]) ?? null;
      const outcome = (r.outcome as string | null) ?? null;
      const item: DailyReportItem = {
        symbol,
        action,
        outcome,
        rationale: (r.rationale as string | null) ?? null,
        passedReason: null,
        notional: num(r.notional),
        price: num(r.price),
        conviction: null,
        decidedAt: (r.decided_at as string | null) ?? null,
      };
      if (action === "hold" || outcome === "hold") {
        held.push(item);
      } else if (outcome && TRADED.has(outcome)) {
        (action === "sell" ? sold : bought).push(item);
      } else {
        item.passedReason =
          (r.outcome_detail as string | null) ?? (outcome ? `Order ${outcome}` : "Not recorded");
        passed.push(item);
      }
    }

    for (const c of (cfRes.data ?? []).filter((r) => r.portfolio_id === pid)) {
      const symbol = String(c.symbol);
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      const cat = (c.block_category as string | null) ?? "other";
      passed.push({
        symbol,
        action: (String(c.side ?? "buy").toLowerCase() === "sell" ? "sell" : "buy") as "buy" | "sell",
        outcome: "blocked",
        rationale: null,
        passedReason: `${labelBlock(cat)}${c.block_reason ? ` — ${String(c.block_reason)}` : ""}`,
        notional: num(c.hypothetical_spend),
        price: null,
        conviction: num(c.conviction),
        decidedAt: (c.created_at as string | null) ?? null,
      });
    }

    const counts = new Map<string, number>();
    for (const item of passed) {
      const key = (item.passedReason ?? "Not recorded").split(" — ")[0];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const passReasonCounts = Array.from(counts, ([reason, count]) => ({ reason, count })).sort(
      (a, b) => b.count - a.count,
    );

    const entry: DailyReportPortfolio = {
      portfolioId: pid,
      name: (p.name as string) ?? "Portfolio",
      mode: (p.mode as string | null) ?? null,
      currency,
      narrative: "",
      narrativeModel: null,
      runExplanation: runNoteByP.get(pid) ?? null,
      considered: seen.size,
      bought,
      sold,
      held,
      passed,
      passReasonCounts,
      fxLegs: fxByP.get(pid) ?? [],
    };
    entry.narrative = buildDeterministicNarrative(entry);
    out.push(entry);
  }

  const narrated = await Promise.all(
    out.map(async (p) => {
      const { text, model } = await narrate(p, date, p.narrative);
      return { ...p, narrative: text, narrativeModel: model };
    }),
  );

  // Real-cash portfolio first — that is the one the owner reads first every
  // morning; sims follow in creation order.
  const modeRank = (m: string | null) =>
    m === "live_prod" ? 0 : m === "live_sim" ? 1 : 2;
  const ordered = narrated
    .map((p, i) => ({ p, i }))
    .sort((a, b) => modeRank(a.p.mode) - modeRank(b.p.mode) || a.i - b.i)
    .map(({ p }) => p);

  return { date, generatedAt: new Date().toISOString(), portfolios: ordered };

}
