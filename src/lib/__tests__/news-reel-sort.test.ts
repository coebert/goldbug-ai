import { describe, expect, it } from "vitest";
import {
  isSortedLatestFirst,
  newsItemTimestamp,
  sortNewsLatestFirst,
  type SortableNewsItem,
} from "@/lib/news-reel-sort";

type Item = SortableNewsItem & { id: string };

const item = (id: string, fetched_at: string | null, date: string, decisions_count = 0): Item => ({
  id,
  fetched_at,
  date,
  decisions_count,
});

describe("news reel latest-first ordering", () => {
  it("orders by ingestion timestamp, newest first", () => {
    const rows = [
      item("b", "2026-07-30T09:00:00Z", "2026-07-30"),
      item("c", "2026-07-29T23:59:00Z", "2026-07-29"),
      item("a", "2026-07-30T18:30:00Z", "2026-07-30"),
    ];
    expect(sortNewsLatestFirst(rows).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("never lets cited headlines float above newer uncited ones", () => {
    const rows = [
      item("old-but-cited", "2026-07-20T08:00:00Z", "2026-07-20", 12),
      item("fresh-uncited", "2026-07-30T08:00:00Z", "2026-07-30", 0),
    ];
    expect(sortNewsLatestFirst(rows)[0].id).toBe("fresh-uncited");
  });

  it("uses citation count only as a tie-breaker at the same instant", () => {
    const stamp = "2026-07-30T08:00:00Z";
    const rows = [item("quiet", stamp, "2026-07-30", 0), item("cited", stamp, "2026-07-30", 3)];
    expect(sortNewsLatestFirst(rows).map((r) => r.id)).toEqual(["cited", "quiet"]);
  });

  it("falls back to the news date when fetched_at is missing", () => {
    const rows = [
      item("older", null, "2026-07-28"),
      item("newer", null, "2026-07-30"),
      item("middle", null, "2026-07-29"),
    ];
    expect(sortNewsLatestFirst(rows).map((r) => r.id)).toEqual(["newer", "middle", "older"]);
  });

  it("ranks a precise timestamp above a same-day date-only row", () => {
    const rows = [
      item("dateonly", null, "2026-07-30"),
      item("stamped", "2026-07-30T14:00:00Z", "2026-07-30"),
    ];
    expect(sortNewsLatestFirst(rows).map((r) => r.id)).toEqual(["stamped", "dateonly"]);
  });

  it("treats unparseable timestamps as oldest rather than throwing", () => {
    const rows = [item("bad", "not-a-date", "also-not-a-date"), item("good", null, "2026-07-01")];
    expect(() => sortNewsLatestFirst(rows)).not.toThrow();
    expect(sortNewsLatestFirst(rows).map((r) => r.id)).toEqual(["good", "bad"]);
    expect(newsItemTimestamp(rows[0])).toBe(0);
  });

  it("is stable and idempotent across repeated sorts", () => {
    const rows = [
      item("a", "2026-07-30T10:00:00Z", "2026-07-30"),
      item("b", "2026-07-30T09:00:00Z", "2026-07-30"),
      item("c", "2026-07-29T10:00:00Z", "2026-07-29"),
    ];
    const once = sortNewsLatestFirst(rows);
    const twice = sortNewsLatestFirst(once);
    expect(twice.map((r) => r.id)).toEqual(once.map((r) => r.id));
  });

  it("does not mutate the input array", () => {
    const rows = [
      item("b", "2026-07-29T10:00:00Z", "2026-07-29"),
      item("a", "2026-07-30T10:00:00Z", "2026-07-30"),
    ];
    const snapshot = rows.map((r) => r.id);
    sortNewsLatestFirst(rows);
    expect(rows.map((r) => r.id)).toEqual(snapshot);
  });

  it("stays newest-first after successive refreshes inject newer headlines", () => {
    // Simulates the reel refetching: each refresh returns the prior rows plus
    // newly-ingested headlines, in arbitrary server order.
    let rows: Item[] = [
      item("seed-1", "2026-07-30T06:00:00Z", "2026-07-30", 4),
      item("seed-2", "2026-07-29T06:00:00Z", "2026-07-29", 9),
    ];
    for (let refresh = 1; refresh <= 5; refresh++) {
      const arrival = `2026-07-30T${String(6 + refresh).padStart(2, "0")}:00:00Z`;
      // Newly-arrived rows appended at the end (worst case for ordering).
      rows = [...rows, item(`fresh-${refresh}`, arrival, "2026-07-30", 0)];
      const sorted = sortNewsLatestFirst(rows);
      expect(sorted[0].id).toBe(`fresh-${refresh}`);
      expect(isSortedLatestFirst(sorted)).toBe(true);
      rows = sorted;
    }
  });

  it("keeps ordering intact when a refresh returns rows in reverse order", () => {
    const rows = [
      item("a", "2026-07-30T12:00:00Z", "2026-07-30"),
      item("b", "2026-07-30T11:00:00Z", "2026-07-30"),
      item("c", "2026-07-30T10:00:00Z", "2026-07-30"),
    ];
    const reversedFromServer = [...rows].reverse();
    expect(sortNewsLatestFirst(reversedFromServer).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(isSortedLatestFirst(sortNewsLatestFirst(reversedFromServer))).toBe(true);
  });

  it("isSortedLatestFirst detects an out-of-order list", () => {
    const bad = [
      item("old", "2026-07-28T10:00:00Z", "2026-07-28"),
      item("new", "2026-07-30T10:00:00Z", "2026-07-30"),
    ];
    expect(isSortedLatestFirst(bad)).toBe(false);
    expect(isSortedLatestFirst([])).toBe(true);
    expect(isSortedLatestFirst([bad[0]])).toBe(true);
  });
});
