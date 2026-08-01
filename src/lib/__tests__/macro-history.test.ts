// Locks the 20-year macro study and the playbook it produces.
//
// Two properties matter most and are asserted directly:
//   1. The study is deterministic — the same bars always give the same
//      episodes, buckets and forward statistics.
//   2. No AI-proposed adjustment can widen risk past the engine's hard bounds.

import { describe, it, expect } from "vitest";
import {
  MACRO_EPISODES,
  analyseIndexHistory,
  findDrawdownEpisodes,
  measureKindResponses,
  episodesByKind,
  type IndexBar,
} from "@/lib/macro-history";
import {
  MACRO_HALF_LIFE_MAX,
  MACRO_HALF_LIFE_MIN,
  MACRO_TILT_MULTIPLIER_MAX,
  defaultPlaybookEntry,
  derivePlaybook,
  derivePlaybookEntry,
  deriveDrawdownRules,
  drawdownSizeScale,
  deRiskKinds,
  formatMacroPlaybookBlock,
  mergeDrawdownRuleAdjustments,
  mergePlaybookAdjustments,
  playbookAdjustedTilt,
  playbookKinds,
  playbookTiltMultiplier,
  requiresConfirmation,
  type MacroLessonSet,
} from "@/lib/macro-playbook";
import { MAX_EVENT_TILT } from "@/lib/market-events";

/** Deterministic synthetic index: rise, -30% crash, full recovery, drift. */
function syntheticBars(): IndexBar[] {
  const bars: IndexBar[] = [];
  let close = 100;
  const start = Date.UTC(2010, 0, 4);
  const push = (i: number, c: number) => {
    const d = new Date(start + i * 86_400_000);
    bars.push({ date: d.toISOString().slice(0, 10), close: Number(c.toFixed(4)) });
  };
  let i = 0;
  for (let k = 0; k < 260; k++, i++) push(i, (close *= 1.0015)); // steady bull
  for (let k = 0; k < 60; k++, i++) push(i, (close *= 0.9941)); // ~-30% crash
  for (let k = 0; k < 400; k++, i++) push(i, (close *= 1.0012)); // recovery
  for (let k = 0; k < 300; k++, i++) push(i, (close *= 1.0004)); // drift
  return bars;
}

function macroStudy() {
  return {
    generated_at: "2026-01-01T00:00:00.000Z",
    index: analyseIndexHistory("SPY", syntheticBars()),
    secondary: null,
    kind_responses: [],
    episodes: MACRO_EPISODES,
    news_window_days: 365,
    news_events: 0,
  };
}

describe("macro episode catalogue", () => {
  it("covers two decades and every episode carries a lesson", () => {
    const years = MACRO_EPISODES.map((e) => Number(e.start.slice(0, 4)));
    expect(Math.min(...years)).toBeLessThanOrEqual(2007);
    expect(Math.max(...years)).toBeGreaterThanOrEqual(2020);
    for (const e of MACRO_EPISODES) {
      expect(e.lesson.length).toBeGreaterThan(10);
      expect(e.label.length).toBeGreaterThan(2);
    }
  });

  it("indexes episodes by kind", () => {
    const kind = MACRO_EPISODES[0]!.kind;
    expect(episodesByKind(String(kind)).length).toBeGreaterThan(0);
    expect(episodesByKind("not_a_real_kind")).toEqual([]);
  });
});

describe("drawdown detection", () => {
  const bars = syntheticBars();

  it("finds the engineered crash and measures its depth", () => {
    const eps = findDrawdownEpisodes(bars, 8);
    expect(eps.length).toBeGreaterThan(0);
    const worst = eps.reduce((a, b) => (a.drawdown_pct > b.drawdown_pct ? a : b));
    expect(worst.drawdown_pct).toBeGreaterThan(25);
    expect(worst.drawdown_pct).toBeLessThan(40);
    expect(worst.trough_date > worst.peak_date).toBe(true);
  });

  it("is deterministic across repeated runs", () => {
    expect(findDrawdownEpisodes(bars, 8)).toEqual(findDrawdownEpisodes(bars, 8));
  });

  it("ignores shallow wobbles below the threshold", () => {
    const flat: IndexBar[] = Array.from({ length: 200 }, (_, i) => ({
      date: new Date(Date.UTC(2015, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      close: 100 + Math.sin(i / 8) * 1.5,
    }));
    expect(findDrawdownEpisodes(flat, 8)).toEqual([]);
  });

  it("returns nothing for an empty or single-bar series", () => {
    expect(findDrawdownEpisodes([], 8)).toEqual([]);
    expect(findDrawdownEpisodes([{ date: "2020-01-01", close: 100 }], 8)).toEqual([]);
  });
});

describe("index history study", () => {
  const study = analyseIndexHistory("SPY", syntheticBars());

  it("reports the covered span and bar count", () => {
    expect(study.symbol).toBe("SPY");
    expect(study.bars).toBeGreaterThan(900);
    expect(study.years).toBeGreaterThan(2);
    expect(study.from < study.to).toBe(true);
  });

  it("buckets forward returns by drawdown depth with monotonic bounds", () => {
    expect(study.buckets.length).toBeGreaterThan(2);
    for (let i = 1; i < study.buckets.length; i++) {
      expect(study.buckets[i]!.bucket_from).toBeGreaterThanOrEqual(study.buckets[i - 1]!.bucket_from);
    }
    for (const b of study.buckets) {
      expect(b.fwd_3m.samples).toBeGreaterThanOrEqual(0);
      if (b.fwd_3m.samples > 0) {
        expect(b.fwd_3m.hit_rate).toBeGreaterThanOrEqual(0);
        expect(b.fwd_3m.hit_rate).toBeLessThanOrEqual(1);
      }
    }
  });

  it("tolerates unsorted and duplicated input bars", () => {
    const bars = syntheticBars();
    const shuffled = [...bars.slice(500), ...bars.slice(0, 500), bars[10]!];
    const a = analyseIndexHistory("SPY", shuffled);
    expect(a.from).toBe(study.from);
    expect(a.to).toBe(study.to);
  });
});

describe("measureKindResponses", () => {
  const bars = syntheticBars();

  it("scores a kind that is followed by a rising tape as persisting", () => {
    // Tag days inside the recovery leg.
    const dates = bars.slice(340, 380).map((b) => b.date);
    const res = measureKindResponses(
      new Map(dates.map((d) => [d, ["rate_cut"]])),
      bars,
    );
    const rc = res.find((r) => r.kind === "rate_cut");
    expect(rc).toBeTruthy();
    expect(rc!.samples).toBeGreaterThanOrEqual(3);
    expect(rc!.mean_fwd_5d).toBeGreaterThan(0);
  });

  it("ignores event days with no usable forward window", () => {
    const res = measureKindResponses(
      new Map([[bars[bars.length - 1]!.date, ["tariffs"]]]),
      bars,
    );
    const t = res.find((r) => r.kind === "tariffs");
    expect(t == null || t.samples === 0).toBe(true);
  });

  it("returns an empty result when there are no tagged days", () => {
    expect(measureKindResponses(new Map(), bars)).toEqual([]);
  });
});

describe("playbook derivation", () => {
  it("gives every known event kind an entry inside the hard bounds", () => {
    for (const kind of playbookKinds()) {
      const e = defaultPlaybookEntry(kind);
      expect(e.tilt_multiplier).toBeGreaterThanOrEqual(0);
      expect(e.tilt_multiplier).toBeLessThanOrEqual(MACRO_TILT_MULTIPLIER_MAX);
      expect(e.half_life_hours).toBeGreaterThanOrEqual(MACRO_HALF_LIFE_MIN);
      expect(e.half_life_hours).toBeLessThanOrEqual(MACRO_HALF_LIFE_MAX);
      expect(e.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("keeps the catalogued prior when the measured sample is thin", () => {
    const base = defaultPlaybookEntry("tariffs");
    const derived = derivePlaybookEntry("tariffs", {
      kind: "tariffs",
      samples: 2,
      mean_fwd_5d: -2,
      mean_fwd_20d: -3,
      up_rate: 0.1,
      persistence: -1,
    });
    expect(derived).toEqual(base);
  });

  it("moves toward the measurement once the sample is meaningful", () => {
    const derived = derivePlaybookEntry("tariffs", {
      kind: "tariffs",
      samples: 40,
      mean_fwd_5d: 2.2,
      mean_fwd_20d: 3.4,
      up_rate: 0.7,
      persistence: 1.2,
    });
    expect(derived.response).toBe("follow");
    expect(derived.confidence).toBeGreaterThan(defaultPlaybookEntry("tariffs").confidence);
    expect(derived.note).toContain("40 event day");
  });

  it("never converts a de_risk prior into follow, however strong the sample", () => {
    const derived = derivePlaybookEntry("credit_downgrade", {
      kind: "credit_downgrade",
      samples: 200,
      mean_fwd_5d: 6,
      mean_fwd_20d: 9,
      up_rate: 0.95,
      persistence: 3,
    });
    expect(derived.response).toBe("de_risk");
  });

  it("derives a full playbook from a study", () => {
    const pb = derivePlaybook(macroStudy());
    expect(pb.length).toBe(playbookKinds().length);
    expect(new Set(pb.map((e) => String(e.kind))).size).toBe(pb.length);
  });
});

describe("drawdown sizing rules", () => {
  const rules = deriveDrawdownRules(macroStudy());

  it("keeps every size scale inside 0.3–1.5", () => {
    for (const r of rules) {
      expect(r.size_scale).toBeGreaterThanOrEqual(0.3);
      expect(r.size_scale).toBeLessThanOrEqual(1.5);
    }
  });

  it("requires a confirmed trend at depths of 20% or more", () => {
    for (const r of rules) if (r.from_pct >= 20) expect(r.require_trend).toBe(true);
  });

  it("selects the deepest matching rule for the current drawdown", () => {
    const custom = [
      { from_pct: 0, size_scale: 1, require_trend: false, note: "shallow" },
      { from_pct: 10, size_scale: 0.8, require_trend: false, note: "mid" },
      { from_pct: 20, size_scale: 0.5, require_trend: true, note: "deep" },
    ];
    expect(drawdownSizeScale(-25, custom).scale).toBe(0.5);
    expect(drawdownSizeScale(-25, custom).require_trend).toBe(true);
    expect(drawdownSizeScale(-12, custom).scale).toBe(0.8);
    expect(drawdownSizeScale(-1, custom).scale).toBe(1);
    // Sign of the input must not matter.
    expect(drawdownSizeScale(25, custom).scale).toBe(0.5);
  });

  it("is neutral with no rules or a nonsense depth", () => {
    expect(drawdownSizeScale(-30, null).scale).toBe(1);
    expect(drawdownSizeScale(-30, []).scale).toBe(1);
    // A NaN depth falls back to neutral rather than silently picking a rule.
    expect(drawdownSizeScale(Number.NaN, [
      { from_pct: 0, size_scale: 0.4, require_trend: false, note: "x" },
    ]).scale).toBe(1);
  });
});

describe("AI adjustment merging is bounded", () => {
  const derived = playbookKinds().slice(0, 5).map((k) => defaultPlaybookEntry(k));

  it("clamps an out-of-range tilt and half-life", () => {
    const merged = mergePlaybookAdjustments(derived, [
      { kind: String(derived[0]!.kind), tilt_multiplier: 99, half_life_hours: 100000 },
    ]);
    expect(merged[0]!.tilt_multiplier).toBeLessThanOrEqual(MACRO_TILT_MULTIPLIER_MAX);
    expect(merged[0]!.half_life_hours).toBeLessThanOrEqual(MACRO_HALF_LIFE_MAX);

    const low = mergePlaybookAdjustments(derived, [
      { kind: String(derived[0]!.kind), tilt_multiplier: -50, half_life_hours: 0 },
    ]);
    expect(low[0]!.tilt_multiplier).toBeGreaterThanOrEqual(0);
    expect(low[0]!.half_life_hours).toBeGreaterThanOrEqual(MACRO_HALF_LIFE_MIN);
  });

  it("drops invented kinds and invalid responses", () => {
    const merged = mergePlaybookAdjustments(derived, [
      { kind: "alien_invasion", response: "follow", tilt_multiplier: 2 },
      { kind: String(derived[1]!.kind), response: "yolo" },
    ]);
    expect(merged.length).toBe(derived.length);
    expect(merged.some((e) => String(e.kind) === "alien_invasion")).toBe(false);
    expect(merged[1]!.response).toBe(derived[1]!.response);
  });

  it("forces a confirmation session on wait and caps de_risk tilt", () => {
    const merged = mergePlaybookAdjustments(derived, [
      { kind: String(derived[0]!.kind), response: "wait", confirm_sessions: 0 },
      { kind: String(derived[1]!.kind), response: "de_risk", tilt_multiplier: 2 },
    ]);
    expect(merged[0]!.confirm_sessions).toBeGreaterThanOrEqual(1);
    expect(merged[1]!.tilt_multiplier).toBeLessThanOrEqual(1);
  });

  it("returns the derived rules untouched when there are no adjustments", () => {
    expect(mergePlaybookAdjustments(derived, null)).toBe(derived);
    expect(mergePlaybookAdjustments(derived, [])).toBe(derived);
  });

  it("clamps drawdown-rule adjustments and matches on depth", () => {
    const rules = [
      { from_pct: 0, size_scale: 1, require_trend: false, note: "a" },
      { from_pct: 20, size_scale: 0.5, require_trend: true, note: "b" },
    ];
    const merged = mergeDrawdownRuleAdjustments(rules, [
      { from_pct: 20, size_scale: 9, require_trend: false },
      { from_pct: 999, size_scale: 0.1 },
    ]);
    expect(merged[0]).toEqual(rules[0]);
    expect(merged[1]!.size_scale).toBeLessThanOrEqual(1.5);
    expect(merged[1]!.require_trend).toBe(false);
  });
});

describe("applying the playbook to a live tilt", () => {
  const pb = [
    { kind: "rate_cut", response: "follow", tilt_multiplier: 1.4, half_life_hours: 48, confirm_sessions: 0, confidence: 0.6, note: "" },
    { kind: "geopolitical_shock", response: "fade", tilt_multiplier: 1, half_life_hours: 24, confirm_sessions: 0, confidence: 0.5, note: "" },
    { kind: "tariffs", response: "wait", tilt_multiplier: 0.5, half_life_hours: 72, confirm_sessions: 2, confidence: 0.4, note: "" },
    { kind: "credit_downgrade", response: "de_risk", tilt_multiplier: 1, half_life_hours: 168, confirm_sessions: 0, confidence: 0.7, note: "" },
  ] as never as Parameters<typeof playbookTiltMultiplier>[1];

  it("amplifies a follow kind and flips the sign of a fade kind", () => {
    expect(playbookTiltMultiplier(["rate_cut"], pb)).toBeCloseTo(1.4, 3);
    expect(playbookTiltMultiplier(["geopolitical_shock"], pb)).toBeCloseTo(-1, 3);
  });

  it("averages across mixed kinds", () => {
    expect(playbookTiltMultiplier(["rate_cut", "geopolitical_shock"], pb)).toBeCloseTo(0.2, 3);
  });

  it("is neutral for unknown kinds, no kinds, or no playbook", () => {
    expect(playbookTiltMultiplier(["nope"], pb)).toBe(1);
    expect(playbookTiltMultiplier([], pb)).toBe(1);
    expect(playbookTiltMultiplier(["rate_cut"], null)).toBe(1);
  });

  it("never lets the adjusted tilt escape the engine's hard cap", () => {
    for (const raw of [-5, -0.4, 0, 0.31, 12]) {
      const t = playbookAdjustedTilt(raw, ["rate_cut"], pb);
      expect(Math.abs(t)).toBeLessThanOrEqual(MAX_EVENT_TILT + 1e-9);
    }
  });

  it("leaves the tilt unchanged when no playbook is loaded", () => {
    expect(playbookAdjustedTilt(0.12, ["rate_cut"], null)).toBeCloseTo(0.12, 3);
  });

  it("flags confirmation and de-risk kinds", () => {
    expect(requiresConfirmation(["tariffs"], pb)).toBe(true);
    expect(requiresConfirmation(["rate_cut"], pb)).toBe(false);
    expect(deRiskKinds(pb)).toEqual(["credit_downgrade"]);
    expect(deRiskKinds(null)).toEqual([]);
  });
});

describe("prompt block", () => {
  const lessons: MacroLessonSet = {
    generated_at: "2026-01-01T00:00:00.000Z",
    model: "google/gemini-2.5-pro",
    years_covered: 20,
    episodes: 12,
    narrative: "n",
    lessons: ["Do not chase geopolitical headlines."],
    playbook: [
      { kind: "geopolitical_shock", response: "fade", tilt_multiplier: 0.8, half_life_hours: 24, confirm_sessions: 0, confidence: 0.5, note: "round-trips" },
    ] as never,
    drawdown_rules: [
      { from_pct: 0, size_scale: 1, require_trend: false, note: "shallow" },
      { from_pct: 20, size_scale: 0.5, require_trend: true, note: "deep hole" },
    ],
  };

  it("returns an empty string with no lessons so the prompt is unchanged", () => {
    expect(formatMacroPlaybookBlock(null, -10, ["rate_cut"])).toBe("");
  });

  it("includes only the kinds present on today's tape", () => {
    const block = formatMacroPlaybookBlock(lessons, -25, ["geopolitical_shock"]);
    expect(block).toContain("geopolitical_shock: FADE");
    expect(block).toContain("Do not chase geopolitical headlines.");
    const other = formatMacroPlaybookBlock(lessons, -25, ["rate_cut"]);
    expect(other).not.toContain("geopolitical_shock: FADE");
  });

  it("states the drawdown sizing that applies right now", () => {
    const block = formatMacroPlaybookBlock(lessons, -25, []);
    expect(block).toContain("25.0% below its high");
    expect(block).toContain("×0.5");
    expect(block).toContain("confirmed uptrend");
  });
});
