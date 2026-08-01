import { describe, expect, it } from "vitest";
import {
  buildExecPostEvents,
  summariseExecPostEvents,
  summariseStudy,
  type PriceBar,
} from "../exec-post-study";
import {
  defaultCoefficient,
  deriveCoefficient,
  learnedExecPostNudge,
  learnedHalfLifeHours,
  mergeCoefficientAdjustments,
  type ExecPostCoefficient,
} from "../exec-post-learning";
import { computeExecPostSignals, EXEC_POST_MAX_NUDGE, type ExecPostRow } from "../exec-posts";
import type { DetectedExecPost } from "../exec-posts";

function bars(start: number, closes: number[]): PriceBar[] {
  return closes.map((close, i) => ({
    date: `2026-06-${String(start + i).padStart(2, "0")}`,
    close,
  }));
}

function post(overrides: Partial<DetectedExecPost> = {}): DetectedExecPost {
  return {
    headline: "Elon Musk posts on X about production",
    summary: null,
    source: "reuters.com",
    url: null,
    date: "2026-06-10",
    sentiment: 0.6,
    executive_id: "musk",
    executive_name: "Elon Musk",
    handle: "@elonmusk",
    org: "Tesla",
    symbols: ["TSLA"],
    ...overrides,
  };
}

describe("buildExecPostEvents", () => {
  const prices = new Map<string, PriceBar[]>([
    ["TSLA", bars(8, [100, 100, 104, 103, 106, 108, 102])], // 08..14
  ]);

  it("measures forward returns from the last bar on or before the post", () => {
    const [ev] = buildExecPostEvents([post()], prices);
    expect(ev).toBeDefined();
    // base = 10 Jun close 104; +1d = 11 Jun 103
    expect(ev!.base_price).toBe(104);
    expect(ev!.ret_1d).toBeCloseTo(-0.9615, 3);
    expect(ev!.ret_3d).toBeCloseTo(3.8462, 3);
  });

  it("reports the worst move against a positive post as a positive excursion", () => {
    const [ev] = buildExecPostEvents([post()], prices);
    expect(ev!.max_adverse_pct).toBeCloseTo(1.9231, 3);
  });

  it("flips the adverse direction for a negative post", () => {
    const [ev] = buildExecPostEvents([post({ sentiment: -0.7 })], prices);
    // Price rose after a bearish post, so the adverse excursion is the rally.
    expect(ev!.max_adverse_pct).toBeCloseTo(3.8462, 3);
  });

  it("skips posts with no sentiment and symbols with no price history", () => {
    expect(buildExecPostEvents([post({ sentiment: null })], prices)).toHaveLength(0);
    expect(buildExecPostEvents([post({ symbols: ["NOPE"] })], prices)).toHaveLength(0);
  });

  it("emits one event per mapped symbol", () => {
    const multi = new Map(prices);
    multi.set("BTC-USD", bars(8, [50, 51, 52, 53, 54, 55, 56]));
    const events = buildExecPostEvents([post({ symbols: ["TSLA", "BTC-USD"] })], multi);
    expect(events.map((e) => e.symbol).sort()).toEqual(["BTC-USD", "TSLA"]);
  });

  it("leaves forward returns null when the window runs past the data", () => {
    const short = new Map<string, PriceBar[]>([["TSLA", bars(8, [100, 100, 104])]]);
    const [ev] = buildExecPostEvents([post()], short);
    expect(ev!.ret_1d).toBeNull();
    expect(ev!.ret_5d).toBeNull();
  });
});

describe("summariseExecPostEvents", () => {
  const rising = new Map<string, PriceBar[]>([
    ["TSLA", bars(8, [100, 100, 100, 103, 105, 107, 110])],
  ]);
  const falling = new Map<string, PriceBar[]>([
    ["TSLA", bars(8, [100, 100, 100, 97, 95, 93, 90])],
  ]);

  it("scores a post that led the move as a hit", () => {
    const [stat] = summariseExecPostEvents(buildExecPostEvents([post()], rising));
    expect(stat!.hit_rate_1d).toBe(1);
    expect(stat!.mean_signed_1d).toBeGreaterThan(0);
    expect(stat!.persistence).toBeGreaterThan(0);
  });

  it("scores a post that led the wrong way as a miss", () => {
    const [stat] = summariseExecPostEvents(buildExecPostEvents([post()], falling));
    expect(stat!.hit_rate_1d).toBe(0);
    expect(stat!.mean_signed_1d).toBeLessThan(0);
  });

  it("counts a same-week round-trip as a reversal", () => {
    const roundTrip = new Map<string, PriceBar[]>([
      ["TSLA", bars(8, [100, 100, 100, 105, 104, 101, 96])],
    ]);
    const [stat] = summariseExecPostEvents(buildExecPostEvents([post()], roundTrip));
    expect(stat!.hit_rate_1d).toBe(1);
    expect(stat!.reversal_rate).toBe(1);
    expect(stat!.persistence).toBeLessThan(0);
  });

  it("summarises the whole study", () => {
    const summary = summariseStudy(buildExecPostEvents([post()], rising), 90);
    expect(summary.window_days).toBe(90);
    expect(summary.events).toBe(1);
    expect(summary.overall_hit_rate_1d).toBe(1);
    expect(summary.by_executive[0]!.executive_id).toBe("musk");
  });

  it("returns an empty, non-throwing summary with no events", () => {
    const summary = summariseStudy([], 90);
    expect(summary.events).toBe(0);
    expect(summary.overall_hit_rate_1d).toBe(0);
    expect(summary.by_executive).toEqual([]);
  });
});

describe("deriveCoefficient", () => {
  const stat = (over: Partial<ReturnType<typeof baseStat>> = {}) => ({ ...baseStat(), ...over });
  function baseStat() {
    return {
      executive_id: "musk",
      executive_name: "Elon Musk",
      samples: 12,
      hit_rate_1d: 0.7,
      mean_signed_1d: 1.2,
      mean_signed_3d: 1.0,
      mean_signed_5d: 0.8,
      mean_abs_1d: 2.1,
      reversal_rate: 0.2,
      mean_max_adverse: 1.5,
      persistence: 0.6,
      symbols: ["TSLA"],
    };
  }

  it("follows and strengthens a person with a winning record", () => {
    const c = deriveCoefficient(stat());
    expect(c.stance).toBe("follow");
    expect(c.weight).toBeGreaterThan(0.9);
    expect(c.confidence).toBeGreaterThan(0.5);
  });

  it("fades a person whose posts lead price the wrong way", () => {
    const c = deriveCoefficient(stat({ hit_rate_1d: 0.25, mean_signed_1d: -1.4 }));
    expect(c.stance).toBe("fade");
    expect(c.note).toMatch(/contrarian/i);
  });

  it("ignores a person whose posts barely move the tape", () => {
    const c = deriveCoefficient(stat({ hit_rate_1d: 0.52, mean_abs_1d: 0.2, mean_signed_1d: 0.02 }));
    expect(c.stance).toBe("ignore");
    expect(c.weight).toBe(0);
    expect(c.max_nudge).toBe(0);
  });

  it("never exceeds the hard nudge cap", () => {
    const c = deriveCoefficient(stat({ hit_rate_1d: 1, mean_signed_1d: 12, reversal_rate: 0 }));
    expect(c.max_nudge).toBeLessThanOrEqual(EXEC_POST_MAX_NUDGE);
    expect(c.weight).toBeLessThanOrEqual(1);
  });

  it("shortens the half-life when moves round-trip", () => {
    const fast = deriveCoefficient(stat({ persistence: -1 }));
    const slow = deriveCoefficient(stat({ persistence: 1 }));
    expect(fast.half_life_hours).toBeLessThan(slow.half_life_hours);
    expect(fast.half_life_hours).toBeGreaterThanOrEqual(6);
    expect(slow.half_life_hours).toBeLessThanOrEqual(96);
  });

  it("keeps a thin sample close to the catalogued prior", () => {
    const c = deriveCoefficient(stat({ samples: 1, hit_rate_1d: 1 }));
    expect(c.confidence).toBeLessThan(0.2);
    expect(c.weight).toBeCloseTo(defaultCoefficient("musk").weight, 1);
  });
});

describe("mergeCoefficientAdjustments", () => {
  const derived: ExecPostCoefficient[] = [defaultCoefficient("musk"), defaultCoefficient("cook")];

  it("applies a valid adjustment", () => {
    const merged = mergeCoefficientAdjustments(derived, [
      { executive_id: "cook", stance: "fade", weight: 0.4, note: "Product teases are pre-priced." },
    ]);
    const cook = merged.find((c) => c.executive_id === "cook")!;
    expect(cook.stance).toBe("fade");
    expect(cook.weight).toBe(0.4);
    expect(cook.note).toMatch(/pre-priced/);
  });

  it("clamps every out-of-range number the model returns", () => {
    const merged = mergeCoefficientAdjustments(derived, [
      { executive_id: "musk", weight: 9, max_nudge: 5, half_life_hours: 9999, min_posts: 99 },
    ]);
    const musk = merged.find((c) => c.executive_id === "musk")!;
    expect(musk.weight).toBe(1);
    expect(musk.max_nudge).toBe(EXEC_POST_MAX_NUDGE);
    expect(musk.half_life_hours).toBe(96);
    expect(musk.min_posts).toBe(5);
  });

  it("drops unknown executive ids instead of inventing authority", () => {
    const merged = mergeCoefficientAdjustments(derived, [
      { executive_id: "some_influencer", stance: "follow", weight: 1 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.some((c) => c.executive_id === "some_influencer")).toBe(false);
  });

  it("zeroes the weight and cap whenever the stance becomes ignore", () => {
    const merged = mergeCoefficientAdjustments(derived, [
      { executive_id: "musk", stance: "ignore", weight: 0.9, max_nudge: 0.15 },
    ]);
    const musk = merged.find((c) => c.executive_id === "musk")!;
    expect(musk.weight).toBe(0);
    expect(musk.max_nudge).toBe(0);
  });

  it("is a no-op with no adjustments", () => {
    expect(mergeCoefficientAdjustments(derived, [])).toBe(derived);
    expect(mergeCoefficientAdjustments(derived, null)).toBe(derived);
  });
});

describe("learnedExecPostNudge", () => {
  const rows: ExecPostRow[] = [
    {
      headline: "Elon Musk posts on X praising the new drivetrain",
      sentiment: 0.8,
      date: "2026-06-10",
      source: "reuters.com",
    },
  ];
  const signals = computeExecPostSignals(rows, "2026-06-10");

  it("exposes the contributing executive ids on the signal", () => {
    expect(signals[0]!.executive_ids).toContain("musk");
  });

  it("follows the post's direction by default", () => {
    const { nudge, stance } = learnedExecPostNudge("TSLA", signals, null);
    expect(nudge).toBeGreaterThan(0);
    expect(stance).toBe("follow");
  });

  it("inverts the sign when the lesson says fade", () => {
    const coeffs = mergeCoefficientAdjustments(
      [defaultCoefficient("musk")],
      [{ executive_id: "musk", stance: "fade" }],
    );
    const { nudge, stance } = learnedExecPostNudge("TSLA", signals, coeffs);
    expect(nudge).toBeLessThan(0);
    expect(stance).toBe("fade");
  });

  it("returns zero when the lesson says ignore", () => {
    const coeffs = mergeCoefficientAdjustments(
      [defaultCoefficient("musk")],
      [{ executive_id: "musk", stance: "ignore" }],
    );
    expect(learnedExecPostNudge("TSLA", signals, coeffs).nudge).toBe(0);
  });

  it("gates on min_posts so a single post cannot carry a high bar", () => {
    const coeffs = mergeCoefficientAdjustments(
      [defaultCoefficient("musk")],
      [{ executive_id: "musk", min_posts: 3 }],
    );
    expect(learnedExecPostNudge("TSLA", signals, coeffs).nudge).toBe(0);
  });

  it("never breaches the learned cap", () => {
    const coeffs = mergeCoefficientAdjustments(
      [defaultCoefficient("musk")],
      [{ executive_id: "musk", max_nudge: 0.05 }],
    );
    const { nudge } = learnedExecPostNudge("TSLA", signals, coeffs);
    expect(Math.abs(nudge)).toBeLessThanOrEqual(0.05);
  });

  it("returns zero for an untouched symbol", () => {
    expect(learnedExecPostNudge("AAPL", signals, null).nudge).toBe(0);
  });

  it("averages a follow and a fade rather than letting one side win outright", () => {
    const both = computeExecPostSignals(
      [
        { headline: "Elon Musk posts on X about bitcoin", sentiment: 0.8, date: "2026-06-10" },
        { headline: "Michael Saylor tweets about bitcoin", sentiment: 0.8, date: "2026-06-10" },
      ],
      "2026-06-10",
    );
    const btc = both.find((s) => s.symbol === "BTC-USD")!;
    expect(btc.executive_ids.sort()).toEqual(["musk", "saylor"]);
    const coeffs = mergeCoefficientAdjustments(
      [defaultCoefficient("musk"), defaultCoefficient("saylor")],
      [{ executive_id: "musk", stance: "fade", weight: 1 }],
    );
    const { nudge } = learnedExecPostNudge("BTC-USD", both, coeffs);
    // musk fades (-1 × 1.0) against saylor following (+1 × 0.65) => net negative but small.
    expect(nudge).toBeLessThan(0);
    expect(Math.abs(nudge)).toBeLessThan(EXEC_POST_MAX_NUDGE);
  });
});

describe("learnedHalfLifeHours", () => {
  it("defaults to 36h with no lessons", () => {
    expect(learnedHalfLifeHours([])).toBe(36);
  });

  it("averages only the active coefficients", () => {
    const coeffs: ExecPostCoefficient[] = [
      { ...defaultCoefficient("musk"), half_life_hours: 12 },
      { ...defaultCoefficient("cook"), half_life_hours: 48 },
      { ...defaultCoefficient("trump"), stance: "ignore", half_life_hours: 96 },
    ];
    expect(learnedHalfLifeHours(coeffs)).toBe(30);
  });
});
