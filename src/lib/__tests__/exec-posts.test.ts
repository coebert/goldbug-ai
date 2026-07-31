import { describe, it, expect } from "vitest";
import {
  detectExecutivePost,
  detectExecutivePosts,
  computeExecPostSignals,
  execPostSentimentNudge,
  execPostFeedQuery,
  EXEC_POST_MAX_NUDGE,
  TRACKED_EXECUTIVES,
} from "@/lib/exec-posts";
import { classifyNewsTopic } from "@/lib/news-topics";
import { RSS_SOURCES, GDELT_SOURCES } from "@/lib/news-sources";

describe("detectExecutivePost", () => {
  it("detects a reported X post by Elon Musk", () => {
    const m = detectExecutivePost("Elon Musk posted on X that Tesla will cut prices");
    expect(m?.executive.id).toBe("musk");
    expect(m?.symbols).toContain("TSLA");
  });

  it("detects tweets and Truth Social posts", () => {
    expect(detectExecutivePost("Michael Saylor tweeted about buying more bitcoin")?.executive.id).toBe("saylor");
    expect(detectExecutivePost("Donald Trump on Truth Social attacks tariffs deal")?.executive.id).toBe("trump");
  });

  it("ignores ordinary coverage without a post marker", () => {
    expect(detectExecutivePost("Tesla beats delivery estimates")).toBeNull();
    expect(detectExecutivePost("Elon Musk to testify in Delaware court")).toBeNull();
  });

  it("ignores post language about untracked people", () => {
    expect(detectExecutivePost("Local mayor posted on X about traffic")).toBeNull();
  });

  it("does not match substrings inside other words", () => {
    expect(detectExecutivePost("Muskrat posted on X")).toBeNull();
  });
});

describe("computeExecPostSignals", () => {
  const asOf = "2026-07-31";

  it("aggregates sentiment per affected symbol with proximity weighting", () => {
    const sigs = computeExecPostSignals(
      [
        { headline: "Elon Musk posted on X about record output", sentiment: 0.8, date: asOf },
        { headline: "Tesla opens new plant", sentiment: -0.9, date: asOf },
      ],
      asOf,
    );
    const tsla = sigs.find((s) => s.symbol === "TSLA");
    expect(tsla?.posts).toBe(1);
    expect(tsla?.score).toBeCloseTo(0.8, 5);
    // Non-post coverage is excluded entirely.
    expect(sigs.every((s) => s.executives.includes("Elon Musk"))).toBe(true);
  });

  it("decays older posts", () => {
    const fresh = computeExecPostSignals(
      [{ headline: "Elon Musk posted on X", sentiment: 1, date: asOf }],
      asOf,
    );
    const stale = computeExecPostSignals(
      [
        { headline: "Elon Musk posted on X", sentiment: 1, date: "2026-07-26" },
        { headline: "Elon Musk tweeted again", sentiment: -1, date: asOf },
      ],
      asOf,
    );
    expect(fresh[0].score).toBeCloseTo(1, 5);
    // The recent negative post dominates the 5-day-old positive one.
    expect(stale.find((s) => s.symbol === "TSLA")!.score).toBeLessThan(0);
  });

  it("drops posts older than seven days and unscored rows", () => {
    expect(
      computeExecPostSignals([{ headline: "Elon Musk posted on X", sentiment: 1, date: "2026-06-01" }], asOf),
    ).toHaveLength(0);
    expect(
      computeExecPostSignals([{ headline: "Elon Musk posted on X", sentiment: null, date: asOf }], asOf),
    ).toHaveLength(0);
  });

  it("is deterministic and order-independent", () => {
    const rows = [
      { headline: "Tim Cook posted on X about the App Store", sentiment: 0.4, date: asOf },
      { headline: "Jensen Huang tweeted about chip demand", sentiment: 0.6, date: asOf },
    ];
    const a = computeExecPostSignals(rows, asOf);
    const b = computeExecPostSignals([...rows].reverse(), asOf);
    expect(a).toEqual(b);
  });
});

describe("execPostSentimentNudge", () => {
  const asOf = "2026-07-31";

  it("stays inside the bounded range", () => {
    const sigs = computeExecPostSignals(
      Array.from({ length: 6 }, () => ({
        headline: "Elon Musk posted on X",
        sentiment: 1,
        date: asOf,
      })),
      asOf,
    );
    const nudge = execPostSentimentNudge("TSLA", sigs);
    expect(nudge).toBeGreaterThan(0);
    expect(Math.abs(nudge)).toBeLessThanOrEqual(EXEC_POST_MAX_NUDGE);
  });

  it("returns zero for untracked symbols", () => {
    expect(execPostSentimentNudge("VOD", [])).toBe(0);
  });

  it("scales confidence with post count", () => {
    const one = computeExecPostSignals(
      [{ headline: "Elon Musk posted on X", sentiment: -1, date: asOf }],
      asOf,
    );
    const many = computeExecPostSignals(
      Array.from({ length: 3 }, () => ({ headline: "Elon Musk tweeted", sentiment: -1, date: asOf })),
      asOf,
    );
    expect(execPostSentimentNudge("TSLA", many)).toBeLessThan(execPostSentimentNudge("TSLA", one));
  });
});

describe("feed + topic wiring", () => {
  it("registers one Google News feed per tracked executive", () => {
    for (const exec of TRACKED_EXECUTIVES) {
      const feed = RSS_SOURCES.find((s) => s.id === `execpost-${exec.id}`);
      expect(feed, exec.id).toBeTruthy();
      expect(feed!.topic).toBe("exec-posts");
      expect(feed!.url).toBe(execPostFeedQuery(exec));
      expect(() => new URL(feed!.url)).not.toThrow();
    }
    expect(GDELT_SOURCES.some((s) => s.id === "gdelt-execposts")).toBe(true);
  });

  it("classifies reported posts under the CEO posts topic", () => {
    expect(classifyNewsTopic({ headline: "Elon Musk posted on X about Tesla output" })).toBe("exec-posts");
  });
});

describe("detectExecutivePosts", () => {
  it("filters a mixed batch down to tracked posts", () => {
    const out = detectExecutivePosts([
      { headline: "Elon Musk posted on X about Optimus" },
      { headline: "Fed holds rates steady" },
      { headline: "Jamie Dimon posted on LinkedIn about credit" },
    ]);
    expect(out.map((o) => o.executive_id)).toEqual(["musk", "dimon"]);
    expect(out[0].symbols[0]).toBe("TSLA");
  });
});
