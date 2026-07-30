import { describe, expect, it } from "vitest";
import {
  buildSeenKeySet,
  canonicalUrlKey,
  dedupeNewsItems,
  filterUnseen,
  normalizeHeadlineKey,
} from "@/lib/news-dedupe";
import { sortNewsLatestFirst } from "@/lib/news-reel-sort";

describe("canonicalUrlKey", () => {
  it("ignores scheme, www, tracking params and trailing slash", () => {
    const a = canonicalUrlKey("https://www.reuters.com/markets/fed-holds/?utm_source=x");
    const b = canonicalUrlKey("http://reuters.com/markets/fed-holds");
    expect(a).toBe(b);
  });

  it("keeps different paths distinct and tolerates junk", () => {
    expect(canonicalUrlKey("https://reuters.com/a")).not.toBe(canonicalUrlKey("https://reuters.com/b"));
    expect(canonicalUrlKey(null)).toBe("");
    expect(canonicalUrlKey("not a url")).toBe("not a url");
  });
});

describe("normalizeHeadlineKey", () => {
  it("collapses case, punctuation, accents and wire prefixes", () => {
    const base = normalizeHeadlineKey("Fed holds rates steady");
    expect(normalizeHeadlineKey("FED HOLDS RATES STEADY.")).toBe(base);
    expect(normalizeHeadlineKey("UPDATE 2-Fed holds rates steady")).toBe(base);
    expect(normalizeHeadlineKey("Féd  holds   rates steady!")).toBe(base);
  });

  it("keeps genuinely different headlines apart", () => {
    expect(normalizeHeadlineKey("Fed holds rates")).not.toBe(normalizeHeadlineKey("Fed cuts rates"));
    expect(normalizeHeadlineKey(null)).toBe("");
  });
});

describe("dedupeNewsItems", () => {
  it("drops a repeat of the same URL published under a different headline", () => {
    const rows = [
      { id: "1", headline: "Fed holds rates steady", url: "https://reuters.com/a", fetched_at: "2026-07-30T10:00:00Z", date: "2026-07-30" },
      { id: "2", headline: "Federal Reserve keeps rates unchanged", url: "https://www.reuters.com/a?utm=1", fetched_at: "2026-07-29T10:00:00Z", date: "2026-07-29" },
    ];
    const out = dedupeNewsItems(rows);
    expect(out.map((r) => r.id)).toEqual(["1"]);
  });

  it("drops a repeat of the same headline from a different source/date", () => {
    const rows = [
      { id: "1", headline: "Oil slips on demand fears", url: "https://reuters.com/x", date: "2026-07-30" },
      { id: "2", headline: "Oil slips on demand fears.", url: "https://ft.com/y", date: "2026-07-28" },
    ];
    expect(dedupeNewsItems(rows).map((r) => r.id)).toEqual(["1"]);
  });

  it("matches a translated headline against its original", () => {
    const rows = [
      { id: "1", headline: "ECB signals pause", url: "https://a.com/1", original_headline: "EZB signalisiert Pause" },
      { id: "2", headline: "EZB signalisiert Pause", url: "https://b.com/2" },
    ];
    expect(dedupeNewsItems(rows).map((r) => r.id)).toEqual(["1"]);
  });

  it("keeps distinct stories and never mutates the input", () => {
    const rows = [
      { id: "1", headline: "A happens", url: "https://a.com/1" },
      { id: "2", headline: "B happens", url: "https://b.com/2" },
    ];
    const before = rows.map((r) => r.id);
    expect(dedupeNewsItems(rows)).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it("keeps unidentifiable rows rather than silently dropping them", () => {
    const rows = [{ id: "1", headline: "", url: null }, { id: "2", headline: "", url: null }];
    expect(dedupeNewsItems(rows)).toHaveLength(2);
  });

  it("keeps the freshest copy when sorted newest-first beforehand", () => {
    const rows = [
      { id: "old", headline: "Same story", url: "https://a.com/s", fetched_at: "2026-07-28T10:00:00Z", date: "2026-07-28" },
      { id: "new", headline: "Same story", url: "https://a.com/s", fetched_at: "2026-07-30T10:00:00Z", date: "2026-07-30" },
    ];
    expect(dedupeNewsItems(sortNewsLatestFirst(rows)).map((r) => r.id)).toEqual(["new"]);
  });

  it("is idempotent", () => {
    const rows = [
      { id: "1", headline: "Same story", url: "https://a.com/s", date: "2026-07-30" },
      { id: "2", headline: "Same story", url: "https://a.com/s", date: "2026-07-29" },
      { id: "3", headline: "Other", url: "https://a.com/o", date: "2026-07-30" },
    ];
    const once = dedupeNewsItems(rows);
    expect(dedupeNewsItems(once).map((r) => r.id)).toEqual(once.map((r) => r.id));
  });
});

describe("ingestion-time dedupe across cron runs", () => {
  it("never re-inserts a story already cached in the recent window", () => {
    const cached = [
      { headline: "Fed holds rates steady", url: "https://reuters.com/a", original_headline: null },
    ];
    const seen = buildSeenKeySet(cached);
    // Cron run the next day pulls the same wire story again, plus one new one.
    const incoming = [
      { headline: "UPDATE 1-Fed holds rates steady", url: "https://www.reuters.com/a?utm=cron" },
      { headline: "Gold hits record high", url: "https://reuters.com/gold" },
    ];
    expect(filterUnseen(incoming, seen).map((r) => r.headline)).toEqual(["Gold hits record high"]);
    // A third run adds nothing further.
    expect(filterUnseen(incoming, seen)).toHaveLength(0);
  });

  it("dedupes within a single incoming batch too", () => {
    const seen = buildSeenKeySet([]);
    const incoming = [
      { headline: "Story one", url: "https://a.com/1" },
      { headline: "Story One.", url: "https://b.com/mirror" },
      { headline: "Story two", url: "https://a.com/2" },
    ];
    expect(filterUnseen(incoming, seen).map((r) => r.headline)).toEqual(["Story one", "Story two"]);
  });

  it("reel stays duplicate-free across five simulated refresh cycles", () => {
    type Row = { id: string; headline: string; url: string | null; fetched_at: string; date: string };
    let reel: Row[] = [];
    for (let run = 1; run <= 5; run++) {
      const at = `2026-07-30T${String(8 + run).padStart(2, "0")}:00:00Z`;
      const batch: Row[] = [
        // Recurring wire story, re-published each run with a wire prefix.
        { id: `dup-${run}`, headline: `UPDATE ${run}-Fed holds rates steady`, url: "https://reuters.com/a", fetched_at: at, date: "2026-07-30" },
        // One genuinely new story per run.
        { id: `new-${run}`, headline: `Fresh story ${run}`, url: `https://reuters.com/n${run}`, fetched_at: at, date: "2026-07-30" },
      ];
      reel = dedupeNewsItems(sortNewsLatestFirst([...batch, ...reel]));
    }
    const heads = reel.map((r) => normalizeHeadlineKey(r.headline));
    expect(new Set(heads).size).toBe(heads.length);
    expect(reel.filter((r) => r.id.startsWith("dup-"))).toHaveLength(1);
    expect(reel.filter((r) => r.id.startsWith("new-"))).toHaveLength(5);
    // Newest-first preserved after deduping: run-5's rows lead the reel.
    expect(reel.slice(0, 2).map((r) => r.id).sort()).toEqual(["dup-5", "new-5"]);
  });
});
