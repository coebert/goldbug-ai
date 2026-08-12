// AI review layer for reported director / PDMR share dealings.
//
// `insider-dealings.ts` is a keyword classifier: it is fast, deterministic and
// runs on every hourly pass, but it cannot tell a genuine discretionary sale
// ("CEO sells £4m of stock ahead of trading update") from the mechanical or
// the merely mis-parsed ("company buys back shares", "director of research
// sells rating"). Those false positives are the expensive kind — they push a
// negative nudge onto a name for no reason.
//
// So a scheduled AI pass re-reads every newly detected dealing, decides
// whether it is a real insider transaction and how much it should count, and
// writes a bounded `ai_nudge` back. The engine prefers that value when it is
// present. Everything here is pure so the prompt, the parser and the merge
// rules are unit-testable without a model call.

import {
  INSIDER_NUDGE_CEILING,
  INSIDER_NUDGE_FLOOR,
  type InsiderDealingEvent,
} from "./insider-dealings";

/**
 * - `signal`: a real, discretionary insider transaction that carries a view.
 * - `mechanical`: real, but driven by vesting/tax/plan mechanics — near-zero.
 * - `noise`: not an insider dealing at all (buyback, analyst, mis-match).
 */
export type InsiderAiVerdictKind = "signal" | "mechanical" | "noise";

export type InsiderAiVerdict = {
  index: number;
  verdict: InsiderAiVerdictKind;
  /** 0..1 — how sure the model is about the verdict. */
  confidence: number;
  rationale: string;
};

export type InsiderScanCandidate = {
  index: number;
  symbol: string;
  company: string;
  headline: string;
  summary?: string | null;
  source?: string | null;
  event_date?: string | null;
  direction: InsiderDealingEvent["direction"];
  flavour: InsiderDealingEvent["flavour"];
  person?: string | null;
  role?: string | null;
  value?: number | null;
};

/** How much of the rule-based nudge each verdict is allowed to keep. */
export const AI_VERDICT_WEIGHT: Record<InsiderAiVerdictKind, { base: number; span: number }> = {
  // A confident "signal" may amplify the rule nudge slightly (up to 1.4x) —
  // still inside the hard floor/ceiling, so a single filing can never dominate.
  signal: { base: 0.6, span: 0.8 },
  mechanical: { base: 0.15, span: 0 },
  noise: { base: 0, span: 0 },
};

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/** Turns a model verdict into the bounded nudge the engine will apply. */
export function applyAiVerdict(
  event: Pick<InsiderDealingEvent, "sentiment_nudge">,
  verdict: Pick<InsiderAiVerdict, "verdict" | "confidence" | "rationale">,
): { ai_verdict: InsiderAiVerdictKind; ai_confidence: number; ai_rationale: string; ai_nudge: number } {
  const confidence = clamp01(verdict.confidence);
  const { base, span } = AI_VERDICT_WEIGHT[verdict.verdict] ?? AI_VERDICT_WEIGHT.noise;
  const multiplier = base + span * confidence;
  const raw = Number(event.sentiment_nudge ?? 0) * multiplier;
  const nudge = Math.max(INSIDER_NUDGE_FLOOR, Math.min(INSIDER_NUDGE_CEILING, raw));
  return {
    ai_verdict: verdict.verdict,
    ai_confidence: Number(confidence.toFixed(3)),
    ai_rationale: String(verdict.rationale ?? "").slice(0, 400),
    ai_nudge: Number(nudge.toFixed(4)),
  };
}

/** The prompt block for one batch of detected dealings. */
export function buildInsiderScanPrompt(candidates: InsiderScanCandidate[]): string {
  const lines = candidates.map((c) => {
    const bits = [
      `${c.index}. ${c.symbol} (${c.company})`,
      c.event_date ? `date=${c.event_date}` : null,
      `rule_direction=${c.direction}`,
      `rule_flavour=${c.flavour}`,
      c.person ? `person=${c.person}` : null,
      c.role ? `role=${c.role}` : null,
      c.value ? `value≈${Math.round(c.value).toLocaleString("en-GB")}` : null,
      `source=${c.source ?? "unknown"}`,
    ]
      .filter(Boolean)
      .join(" | ");
    return `${bits}\n   headline: ${c.headline}${c.summary ? `\n   summary: ${c.summary.slice(0, 240)}` : ""}`;
  });

  return `You audit reported director / PDMR ("insider") share dealings for a UK-based trading book.

For each item decide what it really is:
- "signal": a genuine transaction in the company's own shares by an insider (director, PDMR, C-suite, founder, board member, or a person closely associated with them) made at their own discretion. This is the case that carries information.
- "mechanical": a genuine insider transaction whose timing was not chosen — vesting, share awards, option exercise, sharesave maturity, or shares sold purely to settle a tax/withholding liability.
- "noise": not an insider transaction in that company's shares at all. Examples: company share buybacks, institutional or fund holdings, an analyst/broker rating change, an executive of a *different* company, index changes, a headline matched to the wrong company, or a story that only speculates about future selling.

Judgement notes:
- A named executive selling a large slice of a personal holding shortly before or after results is the strongest bearish case.
- Insider *buys* are weaker evidence than sells, but a cluster of open-market buys by several insiders is meaningful.
- Do not trust the rule_direction / rule_flavour fields; they come from a keyword matcher and are often wrong. Correct them with your own read of the headline.
- Be strict: if the headline does not clearly describe an insider dealing in that company's shares, return "noise".

Confidence is 0.0-1.0 in your verdict. Rationale is one short sentence, plain English, no jargon.

Reply ONLY as JSON:
{"verdicts":[{"i":0,"verdict":"signal","confidence":0.8,"rationale":"CEO sold 400k shares on the open market, not a vesting sale."}]}

Items:
${lines.join("\n")}`;
}

const VERDICTS: InsiderAiVerdictKind[] = ["signal", "mechanical", "noise"];

/** Tolerant parser: models wrap JSON in prose or fences often enough to matter. */
export function parseInsiderScanReply(text: string): Map<number, InsiderAiVerdict> {
  const out = new Map<number, InsiderAiVerdict>();
  const raw = String(text ?? "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return out;

  let payload: unknown;
  try {
    payload = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return out;
  }
  const list = (payload as { verdicts?: unknown })?.verdicts;
  if (!Array.isArray(list)) return out;

  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const index = Number(rec["i"] ?? rec["index"]);
    if (!Number.isInteger(index) || index < 0) continue;
    const verdictRaw = String(rec["verdict"] ?? "").toLowerCase().trim();
    const verdict = (VERDICTS as string[]).includes(verdictRaw)
      ? (verdictRaw as InsiderAiVerdictKind)
      : null;
    if (!verdict) continue;
    out.set(index, {
      index,
      verdict,
      confidence: clamp01(Number(rec["confidence"])),
      rationale: String(rec["rationale"] ?? "").slice(0, 400),
    });
  }
  return out;
}

export type InsiderSignalRow = InsiderDealingEvent & {
  ai_verdict?: InsiderAiVerdictKind | null;
  ai_confidence?: number | null;
  ai_nudge?: number | null;
  ai_rationale?: string | null;
};

/** The nudge to actually use: the AI-reviewed one when the scan has seen it. */
export function effectiveInsiderNudge(row: InsiderSignalRow): number {
  const ai = row.ai_nudge;
  if (ai != null && Number.isFinite(Number(ai))) return Number(ai);
  return Number(row.sentiment_nudge ?? 0);
}

export type InsiderSymbolSignal = {
  symbol: string;
  nudge: number;
  events: number;
  /** Distinct named insiders dealing the same way inside the window. */
  cluster: number;
  clusterDirection: InsiderDealingEvent["direction"] | null;
  reviewed: number;
  worst: InsiderSignalRow;
  rationale: string | null;
};

/** Several insiders acting the same way is stronger than one — bounded at 1.3x. */
export function clusterFactor(distinctPeople: number): number {
  if (distinctPeople >= 4) return 1.3;
  if (distinctPeople === 3) return 1.2;
  if (distinctPeople === 2) return 1.1;
  return 1;
}

/**
 * Per-symbol signal using AI-reviewed nudges, with a small cluster premium
 * when multiple distinct insiders dealt the same way. Still clamped to the
 * same hard floor/ceiling as the rule-only path.
 */
export function insiderSignalsWithAi(rows: InsiderSignalRow[]): InsiderSymbolSignal[] {
  const grouped = new Map<string, InsiderSignalRow[]>();
  for (const r of rows) {
    const key = String(r.symbol ?? "").toUpperCase();
    if (!key) continue;
    const list = grouped.get(key) ?? [];
    list.push(r);
    grouped.set(key, list);
  }

  const out: InsiderSymbolSignal[] = [];
  for (const [symbol, list] of grouped) {
    // "noise" events are excluded outright — the model says they are not
    // insider dealings, so they must not colour the name at all.
    const kept = list.filter((r) => r.ai_verdict !== "noise");
    const sum = kept.reduce((acc, r) => acc + effectiveInsiderNudge(r), 0);

    const dirCounts = new Map<string, Set<string>>();
    for (const r of kept) {
      if (r.direction !== "buy" && r.direction !== "sell") continue;
      const who = (r.person ?? r.role ?? r.headline).toLowerCase().trim();
      const set = dirCounts.get(r.direction) ?? new Set<string>();
      set.add(who);
      dirCounts.set(r.direction, set);
    }
    let cluster = 1;
    let clusterDirection: InsiderDealingEvent["direction"] | null = null;
    for (const [dir, people] of dirCounts) {
      if (people.size > cluster) {
        cluster = people.size;
        clusterDirection = dir as InsiderDealingEvent["direction"];
      }
    }

    const scaled = sum * clusterFactor(cluster);
    const nudge = Math.max(INSIDER_NUDGE_FLOOR, Math.min(INSIDER_NUDGE_CEILING, scaled));
    const worst = [...kept].sort(
      (a, b) => Math.abs(effectiveInsiderNudge(b)) - Math.abs(effectiveInsiderNudge(a)),
    )[0];
    if (!worst) continue;

    out.push({
      symbol,
      nudge: Number(nudge.toFixed(4)),
      events: kept.length,
      cluster,
      clusterDirection: cluster > 1 ? clusterDirection : null,
      reviewed: kept.filter((r) => r.ai_verdict != null).length,
      worst,
      rationale: worst.ai_rationale ?? null,
    });
  }

  return out.sort((a, b) => a.nudge - b.nudge);
}
