// End-to-end parity under REAL-WORLD data damage.
//
// The companion suite (policy-regime-persisted-parity.e2e.test.ts) pins the
// engine and the explainability panel together on clean runs. Production data
// is rarely clean: risk inputs go missing when a vendor feed gaps, the news
// tape arrives late so the freshest headline is days old, and older rows in
// `decisions.raw.policy_regime` were written by earlier engine versions that
// persisted fewer fields.
//
// Every case below checks the same invariant: whatever the panel reconstructs
// from the persisted blob must equal the nudge the engine would have applied
// with the SAME (possibly defaulted) regime read — never NaN, never outside
// the documented [0.5, 1.6] scaling band.

import { describe, expect, it } from "vitest";

import {
  computePolicySignals,
  explainPolicyNudge,
  policySentimentNudge,
  POLICY_MAX_NUDGE,
  type PolicyRow,
} from "@/lib/policy-makers";
import {
  detectPolicyRegime,
  policyNudgeScaleForSign,
  type RegimeRead,
  type RegimeRiskInputs,
} from "@/lib/policy-regime-scaling";

const AS_OF = "2026-08-13";
const SCALE_MIN = 0.5;
const SCALE_MAX = 1.6;

const SYMBOLS = ["ISF.L", "SPY", "TLT", "IEUR", "GLD"];

/** Headlines dated `agoDays` before the run, so decay can be exercised. */
function tapeAgedBy(agoDays: number): PolicyRow[] {
  const day = (back: number) =>
    new Date(Date.parse(`${AS_OF}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
  return [
    {
      headline: "Andrew Bailey says rate cuts are premature as inflation risk persists",
      summary: "Bank of England governor pushed back on easing bets.",
      source: "Reuters",
      url: "https://example.test/1",
      date: day(agoDays),
      sentiment: -0.25,
    },
    {
      headline: "Jerome Powell says disinflation is on track and hints at a rate cut",
      source: "Bloomberg",
      date: day(agoDays + 1),
      sentiment: 0.4,
    },
    {
      headline: "Christine Lagarde signals the ECB can ease policy further this year",
      source: "Reuters",
      date: day(agoDays + 2),
      sentiment: 0.3,
    },
  ];
}

const FRESH_ROWS = tapeAgedBy(0);

/** Engine side: exactly what trading-engine.server.ts computes per symbol. */
function engineNudge(symbol: string, regime: RegimeRead | null, rows: PolicyRow[], asOf = AS_OF) {
  const signals = computePolicySignals(rows, asOf);
  const raw = policySentimentNudge(symbol, signals);
  if (raw === 0) return { raw, nudge: 0, scale: null as number | null };
  const scale = regime ? policyNudgeScaleForSign(regime, Math.sign(raw)) : 1;
  return { raw, nudge: policySentimentNudge(symbol, signals, scale), scale };
}

type Blob = Record<string, unknown> | null;

/** Panel side: the reconstruction in policy-explain.functions.ts, verbatim. */
function panelExplain(symbol: string, persisted: Blob, rows: PolicyRow[], asOf = AS_OF) {
  const regimeScale =
    persisted && Number.isFinite(Number(persisted["scale"])) ? Number(persisted["scale"]) : 1;
  const probe = explainPolicyNudge(symbol, rows, asOf);
  if (probe.nudge === 0) return { explain: probe, scale: null as number | null };
  const scale = persisted
    ? policyNudgeScaleForSign(
        {
          posture: (persisted["posture"] as RegimeRead["posture"]) ?? "neutral",
          vol: (persisted["vol"] as RegimeRead["vol"]) ?? "normal",
          scale: regimeScale,
          confidence: 0,
          reason: (persisted["reason"] as string | undefined) ?? "",
        },
        Math.sign(probe.nudge),
      )
    : regimeScale;
  return { explain: explainPolicyNudge(symbol, rows, asOf, { regimeScale: scale }), scale };
}

/** The blob the engine writes, round-tripped through JSON like the DB does. */
function persist(read: RegimeRead): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      posture: read.posture,
      vol: read.vol,
      scale: read.scale,
      confidence: read.confidence,
      reason: read.reason,
    }),
  ) as Record<string, unknown>;
}

function assertSane(scale: number | null, nudge: number) {
  expect(Number.isFinite(nudge)).toBe(true);
  expect(Math.abs(nudge)).toBeLessThanOrEqual(POLICY_MAX_NUDGE + 1e-9);
  if (scale != null) {
    expect(Number.isFinite(scale)).toBe(true);
    expect(scale).toBeGreaterThanOrEqual(SCALE_MIN);
    expect(scale).toBeLessThanOrEqual(SCALE_MAX);
  }
}

describe("regime scale parity under real-world data issues", () => {
  // ------------------------------------------------------------- data gaps
  describe("gapped risk inputs", () => {
    // Vendor outages null out individual fields; the detector must still
    // produce a read and both sides must agree on the resulting scale.
    const GAPPED: RegimeRiskInputs[] = [
      { label: "no_vix", realisedVol20d: 0.31, drawdownPct: -15, index30dReturn: -0.1 },
      { label: "vix_only", vix: 34 },
      { label: "no_vol_anywhere", drawdownPct: -18, index30dReturn: -0.12 },
      { label: "drawdown_only", drawdownPct: -9 },
      { label: "everything_null", vix: null, realisedVol20d: null, drawdownPct: null, index30dReturn: null },
      { label: "empty" },
    ];

    it("matches the engine for every gapped input combination", () => {
      let touched = 0;
      for (const input of GAPPED) {
        const read = detectPolicyRegime(input);
        const blob = persist(read);
        for (const symbol of SYMBOLS) {
          const engine = engineNudge(symbol, read, FRESH_ROWS);
          const panel = panelExplain(symbol, blob, FRESH_ROWS);
          expect(panel.scale).toBe(engine.scale);
          expect(panel.explain.nudge).toBe(engine.nudge);
          assertSane(panel.scale, panel.explain.nudge);
          if (engine.nudge !== 0) touched += 1;
        }
      }
      expect(touched).toBeGreaterThan(0);
    });

    it("degrades to a neutral-ish read rather than throwing when everything is missing", () => {
      const read = detectPolicyRegime({ label: "empty" });
      expect(Number.isFinite(read.scale)).toBe(true);
      expect(read.scale).toBeGreaterThanOrEqual(SCALE_MIN);
      expect(read.scale).toBeLessThanOrEqual(SCALE_MAX);
    });

    it("does not let NaN risk inputs leak into the scale", () => {
      const read = detectPolicyRegime({
        label: "nan_feed",
        vix: Number.NaN,
        realisedVol20d: Number.NaN,
        drawdownPct: Number.NaN,
        index30dReturn: Number.NaN,
      });
      const panel = panelExplain("ISF.L", persist(read), FRESH_ROWS);
      assertSane(panel.scale, panel.explain.nudge);
      expect(panel.explain.nudge).toBe(engineNudge("ISF.L", read, FRESH_ROWS).nudge);
    });
  });

  // ---------------------------------------------------------- delayed tapes
  describe("delayed / stale tapes", () => {
    const READ = detectPolicyRegime({
      label: "risk_off",
      vix: 31,
      realisedVol20d: 0.29,
      drawdownPct: -14,
      index30dReturn: -0.09,
    });

    it("stays in parity as the tape ages out from fresh to beyond the window", () => {
      for (const ago of [0, 1, 3, 6, 7, 10, 30]) {
        const rows = tapeAgedBy(ago);
        for (const symbol of SYMBOLS) {
          const engine = engineNudge(symbol, READ, rows);
          const panel = panelExplain(symbol, persist(READ), rows);
          expect(panel.explain.nudge).toBe(engine.nudge);
          expect(panel.scale).toBe(engine.scale);
          assertSane(panel.scale, panel.explain.nudge);
        }
      }
    });

    it("decays the nudge as headlines age, and both sides decay identically", () => {
      const fresh = panelExplain("ISF.L", persist(READ), tapeAgedBy(0));
      const stale = panelExplain("ISF.L", persist(READ), tapeAgedBy(4));
      expect(Math.abs(stale.explain.nudge)).toBeLessThanOrEqual(Math.abs(fresh.explain.nudge));
      expect(stale.explain.nudge).toBe(engineNudge("ISF.L", READ, tapeAgedBy(4)).nudge);
    });

    it("goes silent — not wrong — once the tape is older than the relevance window", () => {
      const rows = tapeAgedBy(45);
      for (const symbol of SYMBOLS) {
        const engine = engineNudge(symbol, READ, rows);
        const panel = panelExplain(symbol, persist(READ), rows);
        expect(panel.explain.nudge).toBe(engine.nudge);
        assertSane(panel.scale, panel.explain.nudge);
      }
    });

    it("keeps parity when the panel replays a run_date behind today's tape", () => {
      // A late-running panel query resolves `asOf` from the decision row, which
      // can be days behind the newest headline in the cache.
      const rows = [...tapeAgedBy(0), ...tapeAgedBy(-3)]; // includes future-dated rows
      const asOf = AS_OF;
      for (const symbol of SYMBOLS) {
        const engine = engineNudge(symbol, READ, rows, asOf);
        const panel = panelExplain(symbol, persist(READ), rows, asOf);
        expect(panel.explain.nudge).toBe(engine.nudge);
        assertSane(panel.scale, panel.explain.nudge);
      }
    });

    it("ignores rows with missing or unparseable dates instead of poisoning the nudge", () => {
      const rows: PolicyRow[] = [
        ...tapeAgedBy(0),
        { headline: "Powell says policy is restrictive enough", source: "Reuters", date: null, sentiment: -0.2 },
        { headline: "Bailey signals cuts ahead", source: "FT", date: "not-a-date", sentiment: 0.2 },
      ];
      for (const symbol of SYMBOLS) {
        const engine = engineNudge(symbol, READ, rows);
        const panel = panelExplain(symbol, persist(READ), rows);
        expect(panel.explain.nudge).toBe(engine.nudge);
        assertSane(panel.scale, panel.explain.nudge);
      }
    });
  });

  // ------------------------------------------------------ partial blob shapes
  describe("partial / legacy persisted blobs", () => {
    const READ = detectPolicyRegime({
      label: "panic",
      vix: 46,
      realisedVol20d: 0.44,
      drawdownPct: -26,
      index30dReturn: -0.2,
    });
    const full = persist(READ);

    /** Blob shape → the read the panel is documented to default to. */
    const CASES: Array<{ name: string; blob: Blob; expected: RegimeRead }> = [
      {
        name: "posture missing (pre-posture engine build)",
        blob: { vol: full["vol"], scale: full["scale"], reason: "legacy" },
        expected: { ...READ, posture: "neutral", confidence: 0, reason: "legacy" },
      },
      {
        name: "vol band missing",
        blob: { posture: full["posture"], scale: full["scale"] },
        expected: { ...READ, vol: "normal", confidence: 0, reason: "" },
      },
      {
        name: "scale missing (only labels persisted)",
        blob: { posture: full["posture"], vol: full["vol"] },
        expected: { ...READ, scale: 1, confidence: 0, reason: "" },
      },
      {
        name: "empty object",
        blob: {},
        expected: { posture: "neutral", vol: "normal", scale: 1, confidence: 0, reason: "" },
      },
      {
        name: "scale persisted as a numeric string",
        blob: { posture: full["posture"], vol: full["vol"], scale: String(full["scale"]) },
        expected: { ...READ, confidence: 0, reason: "" },
      },
      {
        name: "unknown posture / vol labels from a newer writer",
        blob: { posture: "risk_sideways", vol: "extreme", scale: 1.3 },
        // Unknown labels hit no tilt branch, so the persisted scale passes through.
        expected: {
          posture: "risk_sideways" as RegimeRead["posture"],
          vol: "extreme" as RegimeRead["vol"],
          scale: 1.3,
          confidence: 0,
          reason: "",
        },
      },
      {
        name: "extra unknown fields alongside a valid read",
        blob: { ...full, sleeve: "policy", version: 7, nested: { a: 1 } },
        expected: { ...READ, confidence: 0 },
      },
    ];

    it.each(CASES)("matches the engine for: $name", ({ blob, expected }) => {
      for (const symbol of SYMBOLS) {
        const engine = engineNudge(symbol, expected, FRESH_ROWS);
        const panel = panelExplain(symbol, blob, FRESH_ROWS);
        expect(panel.scale).toBe(engine.scale);
        expect(panel.explain.nudge).toBe(engine.nudge);
        assertSane(panel.scale, panel.explain.nudge);
      }
    });

    it("never produces NaN for junk blob values", () => {
      const junk: Blob[] = [
        { posture: null, vol: null, scale: null },
        { posture: 42, vol: true, scale: "abc" },
        { posture: full["posture"], vol: full["vol"], scale: Number.POSITIVE_INFINITY },
        { posture: full["posture"], vol: full["vol"], scale: -12 },
        { posture: full["posture"], vol: full["vol"], scale: 1e9 },
        { scale: { nested: 1 } },
      ];
      for (const blob of junk) {
        for (const symbol of SYMBOLS) {
          const panel = panelExplain(symbol, blob, FRESH_ROWS);
          assertSane(panel.scale, panel.explain.nudge);
        }
      }
    });

    it("treats a JSON-null blob exactly like no regime at all (×1)", () => {
      for (const symbol of SYMBOLS) {
        const unscaled = policySentimentNudge(symbol, computePolicySignals(FRESH_ROWS, AS_OF));
        expect(panelExplain(symbol, null, FRESH_ROWS).explain.nudge).toBe(unscaled);
      }
    });
  });

  // --------------------------------------------------------- combined damage
  it("holds parity when a gapped read, a stale tape and a partial blob combine", () => {
    const read = detectPolicyRegime({ label: "no_vix", realisedVol20d: 0.33, drawdownPct: -17 });
    const rows = tapeAgedBy(5);
    // Legacy writer: labels only, no scale — the panel must default to ×1 and
    // the engine-equivalent read must be evaluated the same way.
    const blob = { posture: read.posture, vol: read.vol };
    const expected: RegimeRead = { ...read, scale: 1, confidence: 0, reason: "" };
    let compared = 0;
    for (const symbol of SYMBOLS) {
      const engine = engineNudge(symbol, expected, rows);
      const panel = panelExplain(symbol, blob, rows);
      expect(panel.explain.nudge).toBe(engine.nudge);
      expect(panel.scale).toBe(engine.scale);
      assertSane(panel.scale, panel.explain.nudge);
      compared += 1;
    }
    expect(compared).toBe(SYMBOLS.length);
  });
});
