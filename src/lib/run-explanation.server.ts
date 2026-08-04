// Server-only helper: after every runDailyTick, generate a short plain-language
// explanation of the run — what was bought/sold, or why cash sat idle. Stored
// on the decision row inside `raw.plain_explanation` so the portfolio decisions
// UI can render it without an extra fetch.
//
// Uses Lovable AI Gateway (Gemini) for wording, with a deterministic fallback
// so a gateway failure never blocks the run.

import { generateText } from "ai";
import { createLovableAiGatewayProvider } from "./ai-gateway.server";

export interface RunExplanationInput {
  portfolioName: string | null;
  currency: string;
  totalValue: number;
  workingCash: number;
  cashFloor: number;
  // AI-proposed orders (pre-execution).
  proposedOrders: Array<{ symbol: string; side: "buy" | "sell"; quantity?: number }>;
  // Executed rows from the engine (post gates/broker).
  executed: Array<{
    symbol: string;
    side: "buy" | "sell";
    quantity: number;
    value?: number;
    rejected?: string | null;
    reason?: string | null;
  }>;
  // Portfolio-level halt/skips (drawdown, daily loss, market closed, etc).
  halts?: Array<{ code: string; reason?: string }>;
  // Filter reasons for symbols we could not fund.
  droppedForCash?: string[];
  brokerBlocked?: string[];
  budgetNotes?: string[];
}

export interface RunExplanation {
  text: string;
  model: string | null; // null when the deterministic fallback fired
  category: "traded" | "held_cash" | "halted" | "no_signal";
}

function classify(input: RunExplanationInput): RunExplanation["category"] {
  const filled = input.executed.filter((e) => !e.rejected && e.quantity > 0);
  if ((input.halts?.length ?? 0) > 0 && filled.length === 0) return "halted";
  if (filled.length > 0) return "traded";
  if ((input.proposedOrders?.length ?? 0) > 0) return "held_cash";
  return "no_signal";
}

function fmtMoney(n: number, ccy: string): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: ccy,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${Math.round(n)} ${ccy}`;
  }
}

function buildDeterministic(input: RunExplanationInput, category: RunExplanation["category"]): string {
  const ccy = input.currency || "GBP";
  const cashStr = fmtMoney(input.workingCash, ccy);
  const filled = input.executed.filter((e) => !e.rejected && e.quantity > 0);
  const rejected = input.executed.filter((e) => e.rejected);
  const buys = filled.filter((e) => e.side === "buy");
  const sells = filled.filter((e) => e.side === "sell");

  if (category === "halted") {
    const reason = input.halts?.[0]?.reason || input.halts?.[0]?.code || "safety rule";
    return `No trades this run — a safety check paused activity (${reason}). Cash of ${cashStr} is being held until conditions clear.`;
  }

  if (category === "traded") {
    const parts: string[] = [];
    if (buys.length) {
      const names = buys.slice(0, 3).map((b) => b.symbol).join(", ");
      const more = buys.length > 3 ? ` and ${buys.length - 3} more` : "";
      parts.push(`Bought ${names}${more}`);
    }
    if (sells.length) {
      const names = sells.slice(0, 3).map((s) => s.symbol).join(", ");
      const more = sells.length > 3 ? ` and ${sells.length - 3} more` : "";
      parts.push(`sold ${names}${more}`);
    }
    const rej = rejected.length ? ` ${rejected.length} order(s) were blocked by safety limits.` : "";
    return `${parts.join(" and ")}. Remaining cash: ${cashStr}.${rej}`;
  }

  if (category === "held_cash") {
    const reasons: string[] = [];
    if (rejected.length) {
      const uniq = Array.from(new Set(rejected.map((r) => r.rejected || "safety limit").filter(Boolean))).slice(0, 2);
      reasons.push(`safety limits blocked the proposed orders (${uniq.join("; ")})`);
    }
    if (input.droppedForCash?.length) {
      reasons.push(`not enough affordable positions given the per-symbol budget from ${cashStr} cash`);
    }
    if (input.brokerBlocked?.length) {
      reasons.push(`the broker rejected some symbols as un-tradeable`);
    }
    if (!reasons.length) reasons.push("no trade cleared the risk and cost checks this run");
    return `No new trades — ${reasons.join("; ")}. Cash of ${cashStr} stays on the sidelines until a better setup appears.`;
  }

  // no_signal
  return `The AI didn't find a strong enough signal to act on this run. Cash of ${cashStr} was left alone; the safest choice when nothing meets the strategy's criteria.`;
}

function buildPrompt(input: RunExplanationInput, category: RunExplanation["category"], fallback: string): string {
  const ccy = input.currency || "GBP";
  const filled = input.executed.filter((e) => !e.rejected && e.quantity > 0);
  const rejected = input.executed.filter((e) => e.rejected);
  const summary = {
    portfolio: input.portfolioName ?? "this portfolio",
    currency: ccy,
    total_value: Math.round(input.totalValue),
    cash: Math.round(input.workingCash),
    cash_floor: Math.round(input.cashFloor),
    category,
    proposed: input.proposedOrders.slice(0, 8).map((o) => ({ symbol: o.symbol, side: o.side })),
    filled: filled.slice(0, 8).map((e) => ({
      symbol: e.symbol,
      side: e.side,
      value: Math.round(Number(e.value ?? 0)),
      reason: (e.reason || "").slice(0, 120) || null,
    })),
    rejected: rejected.slice(0, 8).map((e) => ({
      symbol: e.symbol,
      side: e.side,
      rejected: (e.rejected || "").slice(0, 120),
    })),
    halts: (input.halts ?? []).slice(0, 4).map((h) => ({ code: h.code, reason: h.reason?.slice(0, 120) ?? null })),
    dropped_for_cash: (input.droppedForCash ?? []).slice(0, 8),
    broker_blocked: (input.brokerBlocked ?? []).slice(0, 8),
    budget_notes: (input.budgetNotes ?? []).slice(0, 4),
  };

  return `You are explaining an automated trading run to a non-technical investor.

Write 2-3 short sentences in plain English. No jargon, no bullet points, no markdown, no headings. Do not give financial advice or predict outcomes.

Focus:
- If trades happened: name a couple of the symbols and say briefly WHY (from the reasons/signals given), and mention the leftover cash.
- If no trades happened: explain clearly why the AI chose to sit on the cash (safety rule, no strong signal, not enough affordable positions, broker blocked, etc). The user specifically wants to understand why available cash wasn't used.
- If a safety halt paused the run, say that in plain terms.

Run data (JSON):
${JSON.stringify(summary)}

Deterministic fallback (rewrite this in warmer, clearer language, keeping every fact accurate):
"${fallback}"`;
}

/**
 * True when the run had literally nothing to narrate: no proposed orders, no
 * executions or rejections, no halts, and nothing dropped or blocked. The
 * deterministic sentence already says everything an LLM could, so paying for
 * a model call here buys nothing — and these runs are the majority overnight.
 */
export function isNoOpRun(input: RunExplanationInput): boolean {
  return (
    (input.proposedOrders?.length ?? 0) === 0 &&
    (input.executed?.length ?? 0) === 0 &&
    (input.halts?.length ?? 0) === 0 &&
    (input.droppedForCash?.length ?? 0) === 0 &&
    (input.brokerBlocked?.length ?? 0) === 0
  );
}

export async function generateRunExplanation(input: RunExplanationInput): Promise<RunExplanation> {
  const category = classify(input);
  const fallback = buildDeterministic(input, category);

  const key = process.env.LOVABLE_API_KEY;
  if (!key) return { text: fallback, model: null, category };
  if (isNoOpRun(input)) return { text: fallback, model: null, category };


  try {
    const gateway = createLovableAiGatewayProvider(key);
    const model = "google/gemini-3.6-flash";
    const { text } = await generateText({
      model: gateway(model),
      prompt: buildPrompt(input, category, fallback),
    });
    const cleaned = (text ?? "").replace(/^[\s>*_-]+|[\s]+$/g, "").slice(0, 600);
    if (!cleaned) return { text: fallback, model: null, category };
    return { text: cleaned, model, category };
  } catch (err) {
    console.warn("generateRunExplanation: falling back to deterministic", err);
    return { text: fallback, model: null, category };
  }
}
