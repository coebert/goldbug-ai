import { describe, expect, it } from "vitest";

import {
  baseSymbol,
  blendRelevance,
  clampRelevance,
  heuristicRelevance,
  relevanceBand,
  sortByRelevance,
  type RelevanceContext,
} from "@/lib/news-relevance";

const balanced: RelevanceContext = {
  symbols: ["VOD.L", "AAPL", "SHEL.L"],
  names: [],
  assetClasses: ["equity", "commodity"],
  currencies: ["GBP", "USD"],
  riskLevel: "balanced",
};

const aggressiveCrypto: RelevanceContext = {
  ...balanced,
  assetClasses: ["equity", "crypto"],
  riskLevel: "aggressive",
};

const conservative: RelevanceContext = { ...balanced, riskLevel: "conservative" };

describe("heuristicRelevance", () => {
  it("scores a headline naming a holding far above generic macro colour", () => {
    const held = heuristicRelevance({ headline: "AAPL cuts iPhone output guidance" }, balanced);
    const generic = heuristicRelevance({ headline: "Retailers report a mixed high street month" }, balanced);
    expect(held.score).toBeGreaterThan(generic.score);
    expect(held.score).toBeGreaterThanOrEqual(50);
    expect(held.tags).toContain("holding:AAPL");
  });

  it("matches holdings regardless of exchange suffix", () => {
    expect(baseSymbol("VOD.L")).toBe("VOD");
    const hit = heuristicRelevance({ headline: "VOD agrees a network sharing deal" }, balanced);
    expect(hit.tags).toContain("holding:VOD");
  });

  it("pushes off-topic headlines below the signal floor", () => {
    const noise = heuristicRelevance(
      { headline: "Premier League club signs striker in record transfer" },
      balanced,
    );
    expect(noise.score).toBeLessThan(20);
    expect(relevanceBand(noise.score)).not.toBe("high");
  });

  it("weights rates news higher for a conservative book than an aggressive one", () => {
    const headline = { headline: "Bank of England signals a further interest rate cut on inflation data" };
    expect(heuristicRelevance(headline, conservative).score).toBeGreaterThan(
      heuristicRelevance(headline, aggressiveCrypto).score,
    );
  });

  it("only counts crypto news when crypto is in the tradable universe", () => {
    const headline = { headline: "Bitcoin surges after a spot ETF approval" };
    expect(heuristicRelevance(headline, aggressiveCrypto).score).toBeGreaterThan(
      heuristicRelevance(headline, balanced).score,
    );
    expect(heuristicRelevance(headline, balanced).tags).not.toContain("theme:crypto");
  });

  it("rewards tier-one sources over unknown aggregators for the same story", () => {
    const h = "Fed holds rates as inflation cools";
    const wire = heuristicRelevance({ headline: h, source_weight: 1 }, balanced);
    const farm = heuristicRelevance({ headline: h, source_weight: 0.2 }, balanced);
    expect(wire.score).toBeGreaterThan(farm.score);
  });

  it("stays within 0..100 and never throws on empty input", () => {
    expect(heuristicRelevance({ headline: "" }, balanced).score).toBe(0);
    const loaded = heuristicRelevance(
      { headline: "AAPL VOD SHEL crash amid inflation, war, oil and rate panic" },
      balanced,
    );
    expect(loaded.score).toBeLessThanOrEqual(100);
    expect(loaded.score).toBeGreaterThan(80);
  });
});

describe("blendRelevance", () => {
  it("falls back to the heuristic when the LLM pass is unavailable", () => {
    const h = heuristicRelevance({ headline: "Fed holds rates" }, balanced);
    expect(blendRelevance(h, null)).toEqual(h);
  });

  it("never buries a direct holding hit below the high band", () => {
    const h = heuristicRelevance({ headline: "AAPL profit warning" }, balanced);
    const blended = blendRelevance(h, { score: 5, reason: "model miss", tags: [] });
    expect(blended.score).toBeGreaterThanOrEqual(60);
  });

  it("blends model and heuristic scores for non-holding headlines", () => {
    const h = { score: 40, reason: "macro", tags: ["theme:inflation"] };
    const blended = blendRelevance(h, { score: 80, reason: "big macro driver", tags: ["rates"] });
    expect(blended.score).toBe(66);
    expect(blended.reason).toBe("big macro driver");
    expect(blended.tags).toContain("theme:inflation");
  });
});

describe("clampRelevance / sortByRelevance", () => {
  it("clamps junk values", () => {
    expect(clampRelevance(NaN)).toBe(0);
    expect(clampRelevance(-10)).toBe(0);
    expect(clampRelevance(999)).toBe(100);
    expect(clampRelevance("72")).toBe(72);
  });

  it("orders by score, newest first within a tie, unscored last", () => {
    const items = [
      { id: "a", relevance_score: 40, date: "2026-07-30", fetched_at: "2026-07-30T10:00:00Z" },
      { id: "b", relevance_score: null, date: "2026-07-30", fetched_at: "2026-07-30T12:00:00Z" },
      { id: "c", relevance_score: 90, date: "2026-07-29", fetched_at: "2026-07-29T09:00:00Z" },
      { id: "d", relevance_score: 90, date: "2026-07-30", fetched_at: "2026-07-30T09:00:00Z" },
    ];
    expect(sortByRelevance(items).map((i) => i.id)).toEqual(["d", "c", "a", "b"]);
  });
});
