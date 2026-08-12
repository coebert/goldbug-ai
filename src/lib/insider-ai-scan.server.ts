// Scheduled AI scan for insider (director / PDMR) dealing behaviour.
//
// Two stages, both idempotent:
//   1. Ingest — widen the target list beyond current holdings (watchlist +
//      universe single stocks the engine could actually buy) and pull the RNS
//      filings and news wire through the existing rule-based detector.
//   2. Review — hand every dealing the AI has not yet seen to the model, which
//      decides whether it is a genuine discretionary transaction, a mechanical
//      vesting/tax disposal, or noise, and writes a bounded `ai_nudge` back.
//
// The trading engine reads the reviewed nudge, so the scan feeds decisions
// directly rather than just populating a dashboard card.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { generateText } from "ai";
import {
  applyAiVerdict,
  buildInsiderScanPrompt,
  parseInsiderScanReply,
  type InsiderAiVerdict,
  type InsiderScanCandidate,
} from "./insider-ai-scan";
import type { InsiderTarget } from "./insider-dealings";
import { ingestInsiderDealings, insiderTargetsFromHoldings } from "./insider-dealings.server";

const MODEL = "google/gemini-3.1-flash-lite";
/** Small batches keep the prompt short enough that the model reads every item. */
const BATCH = 12;
const MAX_REVIEW = 60;
const MAX_TARGETS = 40;

/**
 * Holdings first (a sale inside a live position is what actually hurts), then
 * watchlist names, then single stocks from the tradable universe so the scan
 * can also warn the engine *off* a name before it buys.
 */
export async function insiderScanTargets(): Promise<InsiderTarget[]> {
  const held = await insiderTargetsFromHoldings(supabaseAdmin as never);
  const seen = new Set(held.map((t) => t.symbol.toUpperCase()));
  const targets = [...held];

  const { UNIVERSE } = await import("./universe.server");
  const { engineSymbolKey } = await import("./price-symbol");
  const stockBySymbol = new Map(
    UNIVERSE.filter((u) => u.asset_class === "stock").map((u) => [u.symbol.toUpperCase(), u] as const),
  );

  const push = (symbol: string) => {
    const key = engineSymbolKey(symbol).toUpperCase();
    if (!key || seen.has(key)) return;
    const meta = stockBySymbol.get(key);
    if (!meta) return;
    seen.add(key);
    targets.push({ symbol: meta.symbol, company: meta.name });
  };

  const { data: watches } = await supabaseAdmin
    .from("ticker_watches")
    .select("symbol")
    .eq("active", true)
    .limit(100);
  for (const row of watches ?? []) push(String((row as { symbol?: string }).symbol ?? ""));

  for (const meta of stockBySymbol.values()) {
    if (targets.length >= MAX_TARGETS) break;
    push(meta.symbol);
  }

  return targets.slice(0, MAX_TARGETS);
}

export type InsiderAiScanResult = {
  targets: number;
  detected: number;
  stored: number;
  alerted: number;
  ai_scored: number;
  signals: number;
  mechanical: number;
  noise: number;
  model: string;
  duration_ms: number;
  error: string | null;
};

/** Reviews stored dealings that have not been through the model yet. */
export async function reviewUnscannedDealings(
  opts: { max?: number } = {},
): Promise<{ scored: number; signals: number; mechanical: number; noise: number; error: string | null }> {
  const empty = { scored: 0, signals: 0, mechanical: 0, noise: 0 };
  const max = Math.max(1, Math.min(MAX_REVIEW, Math.round(opts.max ?? MAX_REVIEW)));

  const { data: rows, error } = await supabaseAdmin
    .from("insider_dealing_events")
    .select(
      "id, symbol, company, event_date, headline, summary, source, direction, flavour, person, role, value, sentiment_nudge",
    )
    .is("ai_scanned_at", null)
    .order("fetched_at", { ascending: false })
    .limit(max);
  if (error) return { ...empty, error: error.message };
  const pending = rows ?? [];
  if (pending.length === 0) return { ...empty, error: null };

  const key = process.env["LOVABLE_API_KEY"];
  if (!key) return { ...empty, error: "LOVABLE_API_KEY not configured" };
  const model = createLovableAiGatewayProvider(key)(MODEL);

  let scored = 0;
  let signals = 0;
  let mechanical = 0;
  let noise = 0;
  let lastError: string | null = null;

  for (let start = 0; start < pending.length; start += BATCH) {
    const batch = pending.slice(start, start + BATCH);
    const candidates: InsiderScanCandidate[] = batch.map((r, i) => ({
      index: i,
      symbol: String((r as Record<string, unknown>)["symbol"] ?? ""),
      company: String((r as Record<string, unknown>)["company"] ?? ""),
      headline: String((r as Record<string, unknown>)["headline"] ?? ""),
      summary: (r as Record<string, unknown>)["summary"] as string | null,
      source: (r as Record<string, unknown>)["source"] as string | null,
      event_date: (r as Record<string, unknown>)["event_date"] as string | null,
      direction: (r as Record<string, unknown>)["direction"] as InsiderScanCandidate["direction"],
      flavour: (r as Record<string, unknown>)["flavour"] as InsiderScanCandidate["flavour"],
      person: (r as Record<string, unknown>)["person"] as string | null,
      role: (r as Record<string, unknown>)["role"] as string | null,
      value: (r as Record<string, unknown>)["value"] == null ? null : Number((r as Record<string, unknown>)["value"]),
    }));

    let verdicts = new Map<number, InsiderAiVerdict>();
    try {
      const { text } = await generateText({ model, prompt: buildInsiderScanPrompt(candidates) });
      verdicts = parseInsiderScanReply(text);
      if (verdicts.size === 0) lastError = "model returned no usable verdicts";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn("insider-ai-scan: batch failed", lastError);
      // A failed batch leaves `ai_scanned_at` null, so the next run retries it
      // rather than silently keeping the unreviewed rule nudge forever.
      continue;
    }

    for (let i = 0; i < batch.length; i++) {
      const verdict = verdicts.get(i);
      if (!verdict) continue;
      const row = batch[i] as Record<string, unknown>;
      const applied = applyAiVerdict(
        { sentiment_nudge: Number(row["sentiment_nudge"] ?? 0) },
        verdict,
      );
      const { error: upErr } = await supabaseAdmin
        .from("insider_dealing_events")
        .update({ ...applied, ai_scanned_at: new Date().toISOString() })
        .eq("id", String(row["id"]));
      if (upErr) {
        lastError = upErr.message;
        continue;
      }
      scored += 1;
      if (applied.ai_verdict === "signal") signals += 1;
      else if (applied.ai_verdict === "mechanical") mechanical += 1;
      else noise += 1;
    }
  }

  return { scored, signals, mechanical, noise, error: lastError };
}

/** Full scheduled pass: ingest fresh dealings, then AI-review them. */
export async function runInsiderAiScan(
  opts: { trigger?: string; windowDays?: number; max?: number } = {},
): Promise<InsiderAiScanResult> {
  const startedAt = Date.now();
  let ingest = { targets: 0, detected: 0, stored: 0, alerted: 0 };
  let error: string | null = null;

  try {
    const targets = await insiderScanTargets();
    const res = await ingestInsiderDealings(supabaseAdmin as never, {
      targets,
      windowDays: opts.windowDays ?? 7,
      alert: true,
    });
    ingest = { targets: res.targets, detected: res.detected, stored: res.stored, alerted: res.alerted };
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error("insider-ai-scan: ingest failed", err);
  }

  const review = await reviewUnscannedDealings({ max: opts.max ?? MAX_REVIEW });
  if (review.error) error = error ? `${error}; ${review.error}` : review.error;

  const result: InsiderAiScanResult = {
    ...ingest,
    ai_scored: review.scored,
    signals: review.signals,
    mechanical: review.mechanical,
    noise: review.noise,
    model: MODEL,
    duration_ms: Date.now() - startedAt,
    error,
  };

  const { error: logErr } = await supabaseAdmin.from("insider_scan_runs").insert({
    trigger: opts.trigger ?? "manual",
    targets: result.targets,
    detected: result.detected,
    stored: result.stored,
    ai_scored: result.ai_scored,
    signals: result.signals,
    mechanical: result.mechanical,
    noise: result.noise,
    alerted: result.alerted,
    model: result.model,
    duration_ms: result.duration_ms,
    error: result.error,
  });
  if (logErr) console.warn("insider-ai-scan: run log failed", logErr.message);

  return result;
}
