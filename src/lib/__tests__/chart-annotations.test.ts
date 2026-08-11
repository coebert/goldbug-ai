import { describe, expect, it } from "vitest";

import {
  buildAnnotationPrompt,
  detectChartEvents,
  mergeAnnotations,
  newsNearEvent,
  parseAnnotationReply,
} from "../chart-annotations";
import type { HistoryPoint } from "../market-symbol-history";

function pt(date: string, close: number, sma50: number | null = null, sma200: number | null = null): HistoryPoint {
  return { date, close, indexed: 100, sma20: null, sma50, sma100: null, sma200 };
}

function series(closes: number[], start = "2026-01-01"): HistoryPoint[] {
  const t0 = Date.parse(`${start}T00:00:00Z`);
  return closes.map((c, i) =>
    pt(new Date(t0 + i * 86_400_000).toISOString().slice(0, 10), c),
  );
}

describe("detectChartEvents", () => {
  it("returns nothing for a too-short series", () => {
    expect(detectChartEvents(series([100, 101, 102]))).toEqual([]);
  });

  it("flags an outsized single-day drop", () => {
    const closes = [100, 100.2, 100.1, 100.4, 100.3, 100.5, 88, 88.4, 88.2, 88.6];
    const events = detectChartEvents(series(closes), "S&P 500");
    const spike = events.find((e) => e.kind === "spike_down");
    expect(spike).toBeTruthy();
    expect(spike?.magnitudePct).toBeLessThan(-10);
    expect(spike?.fallbackNote).toContain("S&P 500");
  });

  it("detects a golden cross and a death cross", () => {
    const pts: HistoryPoint[] = [
      pt("2026-01-01", 100, 98, 100),
      pt("2026-01-02", 101, 101, 100), // golden
      pt("2026-01-03", 102, 102, 100),
      pt("2026-01-04", 103, 101, 100),
      pt("2026-01-05", 104, 99, 100), // death
      pt("2026-01-06", 105, 98, 100),
    ];
    const kinds = detectChartEvents(pts).map((e) => e.kind);
    expect(kinds).toContain("golden_cross");
    expect(kinds).toContain("death_cross");
  });

  it("marks the drawdown trough when the fall exceeds 5%", () => {
    const events = detectChartEvents(series([100, 102, 101, 95, 90, 92, 96, 99]));
    const trough = events.find((e) => e.kind === "drawdown_trough");
    expect(trough?.date).toBe("2026-01-05");
    expect(trough?.magnitudePct).toBeLessThan(-10);
  });

  it("keeps events chronological, unique by date and capped at six", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 8 + (i > 60 ? -30 : 0));
    const events = detectChartEvents(series(closes));
    expect(events.length).toBeLessThanOrEqual(6);
    expect(new Set(events.map((e) => e.date)).size).toBe(events.length);
    const idxs = events.map((e) => e.index);
    expect([...idxs].sort((a, b) => a - b)).toEqual(idxs);
  });

  it("always includes the window high and low when nothing else fires", () => {
    const events = detectChartEvents(series([100, 101, 102, 103, 102, 101]));
    expect(events.map((e) => e.kind).sort()).toEqual(["range_high", "range_low"]);
  });
});

describe("newsNearEvent", () => {
  const news = [
    { date: "2026-01-04", headline: "Rate cut hopes" },
    { date: "2026-01-09", headline: "Far away story" },
  ];

  it("keeps only headlines inside the window", () => {
    expect(newsNearEvent(news, "2026-01-05").map((n) => n.headline)).toEqual(["Rate cut hopes"]);
  });

  it("ignores invalid dates", () => {
    expect(newsNearEvent(news, "not-a-date")).toEqual([]);
  });
});

describe("parseAnnotationReply", () => {
  it("parses fenced JSON", () => {
    const out = parseAnnotationReply('```json\n{"notes":[{"id":"spike_up:2026-01-02","note":"Jumped."}]}\n```');
    expect(out["spike_up:2026-01-02"]).toBe("Jumped.");
  });

  it("returns an empty map on garbage", () => {
    expect(parseAnnotationReply("sorry, no")).toEqual({});
    expect(parseAnnotationReply("")).toEqual({});
  });
});

describe("mergeAnnotations", () => {
  const events = detectChartEvents(series([100, 101, 102, 103, 102, 101]));

  it("falls back per event when the AI omits one", () => {
    const merged = mergeAnnotations(events, { [events[0].id]: "AI wording." }, "google/gemini-3.6-flash");
    expect(merged[0].note).toBe("AI wording.");
    expect(merged[0].model).toBe("google/gemini-3.6-flash");
    expect(merged[1].note).toBe(events[1].fallbackNote);
    expect(merged[1].model).toBeNull();
  });
});

describe("buildAnnotationPrompt", () => {
  it("embeds each event id and nearby headlines", () => {
    const events = detectChartEvents(series([100, 101, 102, 103, 102, 101]));
    const prompt = buildAnnotationPrompt("FTSE 100", "^FTSE", 90, events, [
      { date: events[0].date, headline: "Miners rally" },
    ]);
    expect(prompt).toContain(events[0].id);
    expect(prompt).toContain("Miners rally");
    expect(prompt).toContain("JSON only");
  });
});

describe("annotation evidence", () => {
  it("attaches the nearby headlines used for each event", () => {
    const event = {
      id: "e1",
      kind: "spike_up" as const,
      index: 3,
      date: "2026-03-10",
      close: 100,
      magnitudePct: 4.2,
      label: "Jump",
      fallbackNote: "Rose 4.2% in a day.",
    };
    const news = [
      { date: "2026-03-09", headline: "Rate cut hopes lift stocks", source: "Reuters", url: "https://x", at: "2026-03-09T08:00:00Z" },
      { date: "2026-01-01", headline: "Unrelated", source: "AP" },
    ];
    const [annotation] = mergeAnnotations([event], { e1: "Jumped on rate-cut hopes." }, "m", news);
    expect(annotation.sources).toHaveLength(1);
    expect(annotation.sources[0].headline).toBe("Rate cut hopes lift stocks");
    expect(annotation.sources[0].at).toBe("2026-03-09T08:00:00Z");
  });

  it("returns an empty source list when no headlines are near", () => {
    const event = {
      id: "e2",
      kind: "range_low" as const,
      index: 1,
      date: "2026-03-10",
      close: 90,
      magnitudePct: null,
      label: "Low",
      fallbackNote: "Lowest point in range.",
    };
    const [annotation] = mergeAnnotations([event], {}, null, []);
    expect(annotation.sources).toEqual([]);
  });
});
