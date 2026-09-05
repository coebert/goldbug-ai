/**
 * The trading playbook — the AI's own read of this account's history.
 *
 * This replaces the ridge fit as the thing the live decision call leans on.
 * The fit could only ever produce a linear score, and on ~60 days of history
 * that score failed its out-of-sample test, so it stood aside and the account
 * got nothing from its own record. Here the same history is turned into
 * evidence (history-brief.server.ts) and handed to the model with one job:
 * write down the rules this book's results actually support, with the
 * evidence attached and an honest confidence on each.
 *
 * The result is stored and injected into every live decision prompt, so when
 * the gateway is up the model picks stocks against rules derived from this
 * portfolio rather than from a generic prior.
 */

import { streamText, Output } from "ai";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { buildHistoryBrief, type HistoryBrief } from "./history-brief.server";

const PRIMARY_MODEL = process.env["AI_DECISION_MODEL"] || "google/gemini-3.6-flash";
const BACKUP_MODEL = "google/gemini-2.5-flash";

const RuleSchema = z.object({
  rule: z.string().describe("One imperative rule, specific enough to act on today."),
  evidence: z.string().describe("The number from the brief that supports it."),
  confidence: z.enum(["high", "medium", "low"]),
});

export const PlaybookSchema = z.object({
  summary: z.string().describe("What this account's history says about how it makes and loses money, in 3-5 sentences."),
  entry_rules: z.array(RuleSchema).min(1).max(8),
  exit_rules: z.array(RuleSchema).min(1).max(6),
  sizing: z.string().describe("How large positions should be given the measured payoff and cost drag."),
  favour: z.array(z.string()).max(10).describe("Setups or instruments the record supports."),
  avoid: z.array(z.string()).max(10).describe("Setups or instruments the record argues against."),
  cost_discipline: z.string().describe("What the measured dealing cost means for trade frequency and minimum edge."),
  unknowns: z.array(z.string()).max(6).describe("What the history genuinely cannot answer yet."),
  overall_confidence: z.enum(["high", "medium", "low"]),
});

export type Playbook = z.infer<typeof PlaybookSchema>;

export type StoredPlaybook = {
  id: string;
  created_at: string;
  model: string;
  horizon_days: number;
  coverage: HistoryBrief["coverage"];
  brief: string;
  playbook: Playbook;
};

const SYSTEM = `You are the head of research for a single small real-money equity account.
You are given a deterministic evidence table built from that account's OWN recorded decisions and realised, cost-adjusted outcomes. Nothing else.

Write the trading playbook this evidence supports. Rules:
- Every rule must trace to a number in the brief. Quote it in the evidence field.
- Small samples are the norm here. Where a signal's t-statistic is below 1.5, say so and mark the rule low confidence, or leave it out entirely — do NOT dress noise up as an edge.
- The account's dealing cost is stated. A rule whose measured edge is smaller than the round-trip cost is not a rule; call it out under cost_discipline instead.
- Prefer few strong rules to many weak ones. An honest "the history cannot tell us" belongs in unknowns.
- Never invent instruments, dates, or statistics that are not in the brief.`;

async function callModel(model: string, brief: string, apiKey: string): Promise<Playbook> {
  const gateway = createLovableAiGatewayProvider(apiKey, { structuredOutputs: true });
  // No client-side timeout: this prompt routinely runs 30-90s and an abort
  // throws the work away while still being billed.
  const result = streamText({
    model: gateway(model),
    maxRetries: 0,
    maxOutputTokens: 16_000,
    system: SYSTEM,
    prompt: brief,
    output: Output.object({ schema: PlaybookSchema }),
  });
  return (await result.output) as Playbook;
}

/**
 * Rebuild the brief, ask the model for a playbook, store it.
 * Terminal gateway errors (400/401/402/403) are surfaced, not retried.
 */
export async function trainPlaybook(args: {
  userId: string;
  horizonDays?: number;
  realMoneyOnly?: boolean;
}): Promise<StoredPlaybook> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) throw new Error("Missing LOVABLE_API_KEY");

  const brief = await buildHistoryBrief({
    userId: args.userId,
    horizonDays: args.horizonDays,
    realMoneyOnly: args.realMoneyOnly,
  });

  const ladder = [PRIMARY_MODEL, PRIMARY_MODEL, BACKUP_MODEL];
  let playbook: Playbook | null = null;
  let used = PRIMARY_MODEL;
  let lastErr: unknown = null;

  for (let i = 0; i < ladder.length; i++) {
    const model = ladder[i]!;
    try {
      playbook = await callModel(model, brief.text, apiKey);
      used = model;
      break;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (/\b(400|401|402|403)\b/.test(msg)) break;
      if (i < ladder.length - 1) await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
    }
  }

  if (!playbook) {
    throw new Error(
      `Could not train the playbook: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }

  const { data, error } = await supabaseAdmin
    .from("decision_playbooks")
    .insert({
      user_id: args.userId,
      model: used,
      horizon_days: brief.coverage.horizonDays,
      coverage: brief.coverage as unknown as Record<string, unknown>,
      brief: brief.text,
      playbook: playbook as unknown as Record<string, unknown>,
    })
    .select("id, created_at")
    .single();
  if (error) throw new Error(`could not store playbook: ${error.message}`);

  return {
    id: data!.id as string,
    created_at: data!.created_at as string,
    model: used,
    horizon_days: brief.coverage.horizonDays,
    coverage: brief.coverage,
    brief: brief.text,
    playbook,
  };
}

export async function loadLatestPlaybook(userId: string): Promise<StoredPlaybook | null> {
  const { data, error } = await supabaseAdmin
    .from("decision_playbooks")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const parsed = PlaybookSchema.safeParse(data.playbook);
  if (!parsed.success) {
    console.warn("[playbook] stored playbook failed schema check", parsed.error.message);
    return null;
  }
  return {
    id: data.id as string,
    created_at: data.created_at as string,
    model: (data.model as string) ?? "unknown",
    horizon_days: (data.horizon_days as number) ?? 5,
    coverage: data.coverage as unknown as HistoryBrief["coverage"],
    brief: (data.brief as string) ?? "",
    playbook: parsed.data,
  };
}

function rules(list: Playbook["entry_rules"]): string {
  return list.map((r) => `  - [${r.confidence}] ${r.rule} (evidence: ${r.evidence})`).join("\n");
}

/** The prompt block handed to the live decision call. */
export function formatPlaybookBlock(stored: StoredPlaybook | null): string {
  if (!stored) return "";
  const p = stored.playbook;
  const c = stored.coverage;
  return `THIS ACCOUNT'S OWN PLAYBOOK — written from its recorded results (${c.samples} observations of ${c.symbols} instruments over ${c.dates} trading days, ${c.from ?? "?"} → ${c.to ?? "?"}; last reviewed ${stored.created_at.slice(0, 10)}; overall confidence ${p.overall_confidence}).
These are not generic market maxims: each line was derived from what this book actually banked, net of the ${c.roundTripCostBps.toFixed(0)}bps round trip it pays.

${p.summary}

ENTRY RULES:
${rules(p.entry_rules)}

EXIT RULES:
${rules(p.exit_rules)}

SIZING: ${p.sizing}
COST DISCIPLINE: ${p.cost_discipline}
FAVOUR: ${p.favour.join("; ") || "n/a"}
AVOID: ${p.avoid.join("; ") || "n/a"}
NOT YET ANSWERED BY THE HISTORY: ${p.unknowns.join("; ") || "n/a"}

Apply these rules to today's candidates. A high-confidence rule may only be broken with an explicit reason in the rationale; a low-confidence rule is a tie-breaker, not a reason on its own.`;
}
