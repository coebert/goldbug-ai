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
    engine_run_note: p.runExplanation?.slice(0, 400) ?? null,
  };

  const prompt = `You are writing the end-of-day report for a non-technical private investor who owns this automated trading account.

Write 3-5 short sentences of plain English. No markdown, no bullet points, no headings, no financial advice or predictions.

Cover, in this order:
1. What the AI considered today, in scale terms.
2. Each buy and sell it made and the actual reason given.
3. The most notable things it deliberately passed on and why (guardrails, costs, weak signal, broker refusal).
4. One sentence on what that means for the money sitting in the account.

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

  const [auditRes, cfRes, decRes] = await Promise.all([
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
  ]);
  if (auditRes.error) throw new Error(auditRes.error.message);
  if (cfRes.error) throw new Error(cfRes.error.message);

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

  return { date, generatedAt: new Date().toISOString(), portfolios: narrated };
}
