import { describe, it, expect } from "vitest";
import {
  classifyHeadline,
  extractMarketEvents,
  symbolEventFeatures,
  macroEventFeatures,
  eventTilt,
  formatMarketEventsBlock,
  MAX_EVENT_TILT,
  type ScoredHeadline,
} from "@/lib/market-events";

const ASOF = "2026-08-01";

function h(partial: Partial<ScoredHeadline> & { headline: string }): ScoredHeadline {
  return {
    source: "reuters.com",
    sentiment: null,
    entities: [],
    source_weight: 1,
    date: ASOF,
    ...partial,
  };
}

describe("classifyHeadline", () => {
  it("types company catalysts", () => {
    expect(classifyHeadline("Apple beats earnings estimates")).toContain("earnings_beat");
    expect(classifyHeadline("Tesco cuts full-year guidance")).toContain("guidance_cut");
    expect(classifyHeadline("Shell to buy stake in rival")).toContain("mna");
    expect(classifyHeadline("HSBC scraps dividend")).toContain("dividend_cut");
  });

  it("types macro catalysts", () => {
    expect(classifyHeadline("Fed cuts interest rates by 25bp")).toContain("rate_cut");
    expect(classifyHeadline("US inflation accelerates above forecast")).toContain("inflation_hot");
    expect(classifyHeadline("White House announces new tariffs on imports")).toContain("tariffs");
  });

  it("returns nothing for chatter", () => {
    expect(classifyHeadline("Markets drift ahead of the weekend")).toEqual([]);
    expect(classifyHeadline("")).toEqual([]);
  });
});

describe("extractMarketEvents", () => {
  it("blends the event prior with observed sentiment", () => {
    const [ev] = extractMarketEvents(
      [h({ headline: "Acme misses revenue estimates", sentiment: -0.8, entities: ["ACME"] })],
      ASOF,
    );
    expect(ev.kind).toBe("earnings_miss");
    expect(ev.scope).toBe("company");
    expect(ev.polarity).toBeLessThan(-0.5);
    expect(ev.hardCatalyst).toBe(true);
  });

  it("takes direction from sentiment for neutral-prior kinds", () => {
    const [ev] = extractMarketEvents(
      [h({ headline: "US payrolls report lands", sentiment: 0.6 })],
      ASOF,
    );
    expect(ev.kind).toBe("jobs_data");
    expect(ev.polarity).toBeCloseTo(0.6, 3);
  });

  it("decays older headlines", () => {
    const fresh = extractMarketEvents([h({ headline: "Fed cuts rates" })], ASOF)[0];
    const stale = extractMarketEvents(
      [h({ headline: "Fed cuts rates", date: "2026-07-25" })],
      ASOF,
    )[0];
    expect(stale.weight).toBeLessThan(fresh.weight);
  });

  it("weights low-reputation sources less", () => {
    const tier1 = extractMarketEvents([h({ headline: "Fed cuts rates", source_weight: 1 })], ASOF)[0];
    const blog = extractMarketEvents([h({ headline: "Fed cuts rates", source_weight: 0.4 })], ASOF)[0];
    expect(blog.weight).toBeLessThan(tier1.weight);
  });
});

describe("symbolEventFeatures", () => {
  const events = extractMarketEvents(
    [
      h({ headline: "Apple beats earnings estimates", sentiment: 0.7, entities: ["AAPL"] }),
      h({ headline: "Tesco cuts full-year guidance", sentiment: -0.7, entities: ["TSCO"] }),
      h({ headline: "Fed cuts interest rates", sentiment: 0.5 }),
    ],
    ASOF,
  );

  it("attributes company events to the matching symbol only", () => {
    const aapl = symbolEventFeatures("AAPL", "Apple Inc", events);
    expect(aapl.event_count).toBe(1);
    expect(aapl.event_score).toBeGreaterThan(0);
    expect(aapl.top_kinds).toContain("earnings_beat");

    const tsco = symbolEventFeatures("TSCO.L", "Tesco PLC", events);
    expect(tsco.event_count).toBe(1);
    expect(tsco.event_score).toBeLessThan(0);
  });

  it("returns an empty feature set for unrelated symbols", () => {
    const f = symbolEventFeatures("BP.L", "BP PLC", events);
    expect(f).toEqual({
      event_score: 0,
      event_pressure: 0,
      event_count: 0,
      hard_catalyst: false,
      top_kinds: [],
    });
  });

  it("never leaks macro events into a symbol's company features", () => {
    for (const sym of ["AAPL", "TSCO.L"]) {
      const f = symbolEventFeatures(sym, "X", events);
      expect(f.event_count).toBeLessThanOrEqual(1);
    }
  });
});

describe("macroEventFeatures", () => {
  it("scores risk-off tapes negative and risk-on positive", () => {
    const off = macroEventFeatures(
      extractMarketEvents(
        [
          h({ headline: "New tariffs imposed on imports", sentiment: -0.6 }),
          h({ headline: "US inflation jumps above expectations", sentiment: -0.7 }),
        ],
        ASOF,
      ),
    );
    expect(off.macro_score).toBeLessThan(0);
    expect(off.macro_intensity).toBeGreaterThan(0);
    expect(off.drivers.length).toBe(2);

    const on = macroEventFeatures(
      extractMarketEvents([h({ headline: "Fed cuts rates", sentiment: 0.7 })], ASOF),
    );
    expect(on.macro_score).toBeGreaterThan(0);
  });

  it("is neutral with no macro events", () => {
    expect(macroEventFeatures([])).toEqual({ macro_score: 0, macro_intensity: 0, drivers: [] });
  });
});

describe("eventTilt", () => {
  it("stays inside the bounded range even for extreme inputs", () => {
    const extreme = eventTilt(
      { event_score: -1, event_pressure: 1, event_count: 9, hard_catalyst: true, top_kinds: [] },
      { macro_score: -1, macro_intensity: 1, drivers: [] },
    );
    expect(extreme).toBeGreaterThanOrEqual(-MAX_EVENT_TILT);
    expect(Math.abs(extreme)).toBeLessThanOrEqual(MAX_EVENT_TILT);
  });

  it("is zero without events", () => {
    expect(
      eventTilt({ event_score: 0, event_pressure: 0, event_count: 0, hard_catalyst: false, top_kinds: [] }, null),
    ).toBe(0);
  });

  it("points the same way as the event flow", () => {
    const bull = eventTilt(
      { event_score: 0.8, event_pressure: 0.6, event_count: 2, hard_catalyst: true, top_kinds: [] },
      null,
    );
    const bear = eventTilt(
      { event_score: -0.8, event_pressure: 0.6, event_count: 2, hard_catalyst: true, top_kinds: [] },
      null,
    );
    expect(bull).toBeGreaterThan(0);
    expect(bear).toBeLessThan(0);
  });
});

describe("formatMarketEventsBlock", () => {
  it("renders macro drivers and per-symbol catalysts", () => {
    const events = extractMarketEvents(
      [
        h({ headline: "Fed cuts interest rates", sentiment: 0.6 }),
        h({ headline: "Apple beats earnings estimates", sentiment: 0.7, entities: ["AAPL"] }),
      ],
      ASOF,
    );
    const block = formatMarketEventsBlock(macroEventFeatures(events), [
      { symbol: "AAPL", features: symbolEventFeatures("AAPL", "Apple Inc", events) },
    ]);
    expect(block).toContain("MARKET-EVENT FEED");
    expect(block).toContain("rate_cut");
    expect(block).toContain("AAPL");
    expect(block).toContain("HARD CATALYST");
  });

  it("degrades gracefully with no events", () => {
    const block = formatMarketEventsBlock({ macro_score: 0, macro_intensity: 0, drivers: [] }, []);
    expect(block).toContain("no typed macro events");
    expect(block).toContain("No company-specific events");
  });
});
