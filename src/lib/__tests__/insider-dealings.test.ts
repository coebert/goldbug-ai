import { describe, it, expect } from "vitest";
import {
  classifyInsiderHeadline,
  companyAliases,
  detectInsiderDealings,
  extractPerson,
  insiderFeedUrl,
  insiderFeedQueries,
  insiderSignalBySymbol,
  parseDealValue,
  parseShareCount,
  scoreInsiderEvent,
  INSIDER_NUDGE_FLOOR,
  INSIDER_NUDGE_CEILING,
} from "@/lib/insider-dealings";

const MKS = { symbol: "MKS.L", company: "Marks & Spencer (LON)" };

describe("companyAliases", () => {
  it("strips the venue suffix and covers the & / and spellings", () => {
    const a = companyAliases(MKS.company);
    expect(a).toContain("marks & spencer");
    expect(a).toContain("marks and spencer");
  });
});

describe("insiderFeedUrl", () => {
  it("builds a bounded Google News query for the company", () => {
    const url = insiderFeedUrl("Marks & Spencer (LON)", 3);
    expect(url).toContain("news.google.com/rss/search");
    expect(decodeURIComponent(url)).toContain("when:3d");
    expect(decodeURIComponent(url)).toContain("Marks & Spencer");
    expect(decodeURIComponent(url)).not.toContain("(LON)");
  });
});

describe("parsers", () => {
  it("reads share counts and deal values", () => {
    expect(parseShareCount("sold 560,402 shares")).toBe(560402);
    expect(parseShareCount("disposed of 1.2 million shares")).toBe(1_200_000);
    expect(parseDealValue("worth £2.15m")).toBeCloseTo(2_150_000);
    expect(parseDealValue("$1,022,023 of stock")).toBeCloseTo(1_022_023);
    expect(parseDealValue("no money here")).toBeNull();
  });

  it("extracts the person's name before a role word", () => {
    expect(extractPerson("Stuart Machin, chief executive, sells shares")).toBe("Stuart Machin");
  });
});

describe("classifyInsiderHeadline", () => {
  it("flags a discretionary CEO sale", () => {
    const c = classifyInsiderHeadline({
      headline: "Marks & Spencer chief executive sells 500,000 shares",
    });
    expect(c).toMatchObject({ direction: "sell", flavour: "discretionary", isInsider: true });
  });

  it("marks tax-withholding disposals separately", () => {
    const c = classifyInsiderHeadline({
      headline: "Marks & Spencer CEO sold shares to settle a tax liability on vested awards",
    });
    expect(c.direction).toBe("sell");
    expect(c.flavour).toBe("tax");
  });

  it("ignores non-insider market chatter", () => {
    const c = classifyInsiderHeadline({ headline: "Marks & Spencer shares sold off after update" });
    expect(c.isInsider).toBe(false);
  });
});

describe("scoreInsiderEvent", () => {
  it("scores a large discretionary CEO sale above a tax disposal", () => {
    const discretionary = scoreInsiderEvent({
      direction: "sell",
      flavour: "discretionary",
      role: "CEO",
      value: 5_000_000,
    });
    const tax = scoreInsiderEvent({ direction: "sell", flavour: "tax", role: "CEO", value: 5_000_000 });
    expect(discretionary.severity).toBeGreaterThan(tax.severity);
    expect(discretionary.sentiment_nudge).toBeLessThan(tax.sentiment_nudge);
  });

  it("never breaches the nudge bounds", () => {
    const sell = scoreInsiderEvent({ direction: "sell", flavour: "discretionary", role: "CEO", value: 1e12 });
    const buy = scoreInsiderEvent({ direction: "buy", flavour: "discretionary", role: "CEO", value: 1e12 });
    expect(sell.sentiment_nudge).toBeGreaterThanOrEqual(INSIDER_NUDGE_FLOOR);
    expect(buy.sentiment_nudge).toBeLessThanOrEqual(INSIDER_NUDGE_CEILING);
  });
});

describe("detectInsiderDealings", () => {
  const rows = [
    {
      headline: "Marks and Spencer chief executive Stuart Machin sells 560,402 shares worth £2.15m",
      date: "2026-08-12",
      source: "hl.co.uk",
      url: "https://example.com/a",
    },
    { headline: "Tesco results beat expectations", date: "2026-08-12" },
    { headline: "M&S launches autumn range", date: "2026-08-11" },
  ];

  it("matches only insider headlines for the tracked company", () => {
    const events = detectInsiderDealings(rows, [MKS]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      symbol: "MKS.L",
      direction: "sell",
      role: "CEO",
      shares: 560402,
    });
    expect(events[0].value).toBeCloseTo(2_150_000);
    expect(events[0].sentiment_nudge).toBeLessThan(0);
  });

  it("de-duplicates repeats of the same headline", () => {
    const events = detectInsiderDealings([rows[0], { ...rows[0] }], [MKS]);
    expect(events).toHaveLength(1);
  });

  it("aggregates a clamped per-symbol nudge", () => {
    const events = detectInsiderDealings(
      [
        rows[0],
        { ...rows[0], headline: "Marks & Spencer CFO sells 900,000 shares worth £3.4m", url: "b" },
        { ...rows[0], headline: "Marks & Spencer chair sells 400,000 shares worth £1.5m", url: "c" },
      ],
      [MKS],
    );
    const [signal] = insiderSignalBySymbol(events);
    expect(signal.symbol).toBe("MKS.L");
    expect(signal.events).toBe(3);
    expect(signal.nudge).toBeGreaterThanOrEqual(INSIDER_NUDGE_FLOOR);
    expect(signal.nudge).toBeLessThan(0);
  });
});

describe("short-form company matching", () => {
  it("recognises the ampersand initialism used in headlines", () => {
    const aliases = companyAliases("Marks & Spencer (LON)");
    expect(aliases).toContain("m&s");
  });

  it("detects a discretionary sale reported only under the short form", () => {
    const events = detectInsiderDealings(
      [
        {
          headline: "Directors' Deals: M&S directors cash out as shares climb",
          summary: null,
          source: "Financial Times",
          url: null,
          date: "2026-07-31",
        },
      ],
      [{ symbol: "MKS.L", company: "Marks & Spencer (LON)" }],
    );
    expect(events).toHaveLength(1);
    expect(events[0].direction).toBe("sell");
    expect(events[0].role).toBe("Director");
    expect(events[0].sentiment_nudge).toBeLessThan(0);
  });
});

describe("insiderFeedQueries", () => {
  it("emits several short OR-free queries (Google News returns nothing for boolean clauses)", () => {
    const queries = insiderFeedQueries("Marks & Spencer (LON)", 7);
    expect(queries.length).toBeGreaterThan(1);
    for (const q of queries) {
      expect(q).toContain('"Marks & Spencer"');
      expect(q).toContain("when:7d");
      expect(q).not.toContain(" OR ");
    }
  });
});
