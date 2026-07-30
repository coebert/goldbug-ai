// Integration test: deterministic (heuristic) relevance scoring vs the Gemini
// pass, on code-switched headlines (Latin + Cyrillic / CJK in one title).
//
// What it locks down — "stable take-over behaviour":
//   1. With Gemini healthy, the LLM judgement takes over the final score via
//      `blendRelevance` (0.65 LLM / 0.35 heuristic), for every script.
//   2. The heuristic is a FLOOR, never a casualty: a headline naming a holding
//      can't be buried below 60 even when Gemini scores it near zero.
//   3. When Gemini fails, returns empty, or replies with junk, the pipeline
//      falls back to *exactly* the deterministic score — same value the pure
//      module produces offline — and the telemetry says why.
//   4. Take-over is stable across runs: identical input ⇒ identical persisted
//      scores, and the healthy/failed paths differ only where the LLM speaks.
//
// The Supabase admin client and the AI SDK are stubbed; no network, no DB.

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  blendRelevance,
  heuristicRelevance,
  type RelevanceContext,
} from "@/lib/news-relevance";

// ---------------------------------------------------------------------------
// Fixtures: one code-switched headline per script family.
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  headline: string;
  summary: string | null;
  source: string | null;
  source_weight: number | null;
  relevance_score: number | null;
};

const ROWS: Row[] = [
  {
    // Cyrillic + Latin, names a holding (SBER).
    id: "r1",
    headline: "Банк России holds rate — Сбербанк SBER earnings beat expectations",
    summary: null,
    source: "Reuters",
    source_weight: 0.9,
    relevance_score: null,
  },
  {
    // CJK + Latin, macro only (no holding token).
    id: "r2",
    headline: "日本銀行 BOJ signals rate hike as inflation runs hot",
    summary: null,
    source: "Nikkei",
    source_weight: 0.8,
    relevance_score: null,
  },
  {
    // Mixed script, off-topic noise.
    id: "r3",
    headline: "Спортивная драма: 東京 marathon winner celebrates with fans",
    summary: null,
    source: "Local Wire",
    source_weight: 0.3,
    relevance_score: null,
  },
];

const CTX: RelevanceContext = {
  symbols: ["SBER", "VOD.L", "AAPL"],
  names: [],
  assetClasses: ["equity", "fx"],
  currencies: ["GBP", "USD"],
  riskLevel: "balanced",
};

// Gemini's verdicts, deliberately disagreeing with the heuristic:
// it *underrates* the holding row and *overrates* the macro row.
const LLM_REPLY = JSON.stringify({
  scores: [
    { i: 0, score: 5, reason: "Model thinks the Sberbank line is stale.", tags: ["equity"] },
    { i: 1, score: 88, reason: "BOJ hike reprices FX and rates exposure.", tags: ["rates"] },
    { i: 2, score: 2, reason: "Sports story, no market link.", tags: [] },
  ],
});

// ---------------------------------------------------------------------------
// Stubs.
// ---------------------------------------------------------------------------

type Update = { id: string; relevance_score: number; relevance_reason: string; relevance_tags: string[] };
const updates: Update[] = [];
const telemetryInserts: Record<string, unknown>[] = [];

function newsCacheBuilder() {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit", "is"]) {
    builder[m] = () => builder;
  }
  builder.then = (resolve: (v: { data: Row[]; error: null }) => unknown) =>
    resolve({ data: ROWS.map((r) => ({ ...r })), error: null });
  return builder;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "news_relevance_runs") {
        return {
          insert: async (payload: Record<string, unknown>) => {
            telemetryInserts.push(payload);
            return { error: null };
          },
        };
      }
      return {
        ...newsCacheBuilder(),
        update: (patch: Omit<Update, "id">) => ({
          eq: async (_col: string, id: string) => {
            updates.push({ id, ...patch });
            return { error: null };
          },
        }),
      };
    },
  },
}));

vi.mock("@/lib/ai-gateway.server", () => ({
  createLovableAiGatewayProvider: () => () => ({ id: "google/gemini-3.1-flash-lite" }),
}));

const generateText = vi.fn();
vi.mock("ai", () => ({ generateText: (...args: unknown[]) => generateText(...args) }));

const { ensureRelevanceScored } = await import("@/lib/news-relevance.server");

const DATE = "2026-07-30";

async function run() {
  updates.length = 0;
  telemetryInserts.length = 0;
  const result = await ensureRelevanceScored(DATE, { ctx: CTX, trigger: "test" });
  const byId = new Map(updates.map((u) => [u.id, u]));
  return { result, byId, telemetry: telemetryInserts[0] };
}

// Deterministic baseline computed straight from the pure module.
const HEURISTIC = ROWS.map((r) =>
  heuristicRelevance(
    { headline: r.headline, summary: r.summary, source: r.source, source_weight: r.source_weight },
    CTX,
  ),
);

beforeEach(() => {
  generateText.mockReset();
  process.env.LOVABLE_API_KEY = "test-key";
});

describe("relevance: deterministic vs Gemini on code-switched headlines", () => {
  it("scores every mixed-script headline deterministically, with the holding on top", () => {
    const [sber, boj, sport] = HEURISTIC;
    // Cyrillic wrapping doesn't hide the Latin ticker token.
    expect(sber.tags).toContain("holding:SBER");
    expect(sber.score).toBeGreaterThan(boj.score);
    // CJK + Latin macro still matches the English theme regexes.
    expect(boj.tags).toEqual(expect.arrayContaining(["theme:central-bank", "theme:inflation"]));
    // Mixed-script sports copy stays under the signal floor.
    expect(sport.score).toBeLessThan(20);
  });

  it("hands over to Gemini when it answers, blending 0.65 LLM / 0.35 heuristic", async () => {
    generateText.mockResolvedValue({ text: LLM_REPLY });
    const { result, byId } = await run();

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result.scored).toBe(3);

    // Macro row: the model's 88 pulls the score up above the heuristic.
    const boj = byId.get("r2")!;
    expect(boj.relevance_score).toBe(
      blendRelevance(HEURISTIC[1], { score: 88, reason: "", tags: ["rates"] }).score,
    );
    expect(boj.relevance_score).toBeGreaterThan(HEURISTIC[1].score);
    expect(boj.relevance_reason).toBe("BOJ hike reprices FX and rates exposure.");
    // Tags union across both scorers.
    expect(boj.relevance_tags).toEqual(expect.arrayContaining(["theme:central-bank", "rates"]));
  });

  it("never lets Gemini bury a code-switched headline that names a holding", async () => {
    generateText.mockResolvedValue({ text: LLM_REPLY });
    const { byId } = await run();

    // Gemini said 5; the direct-holding floor keeps it at >= 60.
    const sber = byId.get("r1")!;
    expect(sber.relevance_score).toBeGreaterThanOrEqual(60);
    expect(sber.relevance_tags).toContain("holding:SBER");
  });

  it.each([
    ["throws", () => generateText.mockRejectedValue(new Error("gateway 503")), "unknown"],
    ["returns empty text", () => generateText.mockResolvedValue({ text: "   " }), "empty_reply"],
    ["returns junk", () => generateText.mockResolvedValue({ text: "not json at all" }), "unparseable_reply"],
  ])("falls back to the exact deterministic score when Gemini %s", async (_label, arrange) => {
    arrange();
    const { result, byId } = await run();

    expect(result.scored).toBe(3);
    for (const [i, row] of ROWS.entries()) {
      const got = byId.get(row.id)!;
      expect(got.relevance_score).toBe(HEURISTIC[i].score);
      expect(got.relevance_reason).toBe(HEURISTIC[i].reason);
      expect(got.relevance_tags).toEqual(HEURISTIC[i].tags);
    }
  });

  it("records the fallback in telemetry so the take-over is observable", async () => {
    generateText.mockRejectedValue(new Error("gateway 503"));
    const { telemetry } = await run();
    expect(telemetry.llm_scored).toBe(0);
    expect(telemetry.fallback_items).toBe(3);
    expect(telemetry.batch_failures).toBe(1);

    generateText.mockResolvedValue({ text: LLM_REPLY });
    const healthy = await run();
    expect(healthy.telemetry.llm_scored).toBe(3);
    expect(healthy.telemetry.fallback_items).toBe(0);
    expect(healthy.telemetry.batch_failures).toBe(0);
  });

  it("is stable across repeated runs — identical input, identical scores", async () => {
    generateText.mockResolvedValue({ text: LLM_REPLY });
    const a = await run();
    const b = await run();
    const flatten = (m: Map<string, Update>) =>
      [...m.entries()].sort().map(([id, u]) => [id, u.relevance_score, u.relevance_tags]);
    expect(flatten(b.byId)).toEqual(flatten(a.byId));

    // And the failed path is stable too — it collapses onto the heuristic.
    generateText.mockRejectedValue(new Error("gateway 503"));
    const c = await run();
    const d = await run();
    expect(flatten(d.byId)).toEqual(flatten(c.byId));
  });

  it("skips the LLM entirely (pure deterministic) when no API key is configured", async () => {
    delete process.env.LOVABLE_API_KEY;
    const { byId, telemetry } = await run();
    expect(generateText).not.toHaveBeenCalled();
    for (const [i, row] of ROWS.entries()) {
      expect(byId.get(row.id)!.relevance_score).toBe(HEURISTIC[i].score);
    }
    expect(telemetry.failure_reasons).toMatchObject({ missing_api_key: 1 });
  });
});
