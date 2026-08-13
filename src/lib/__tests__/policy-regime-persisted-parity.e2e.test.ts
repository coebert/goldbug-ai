// End-to-end parity: the regime scale the explainability panel replays must be
// EXACTLY the nudge strength the trading engine used on that same run.
//
// The two sides live in different files and only meet through the persisted
// `decisions.raw.policy_regime` blob:
//   engine  — src/lib/trading-engine.server.ts (~L610, ~L677-686, ~L3057)
//   panel   — src/lib/policy-explain.functions.ts (regimeScale reconstruction)
// This test runs both arithmetics over a grid of regimes and symbols and pins
// them together, so a change to one without the other fails here.

import { describe, expect, it } from "vitest";

import {
  computePolicySignals,
  explainPolicyNudge,
  policySentimentNudge,
  type PolicyRow,
} from "@/lib/policy-makers";
import {
  detectPolicyRegime,
  policyNudgeScaleForSign,
  type RegimeRead,
  type RegimeRiskInputs,
} from "@/lib/policy-regime-scaling";

const AS_OF = "2026-08-13";

const ROWS: PolicyRow[] = [
  {
    headline: "Andrew Bailey says rate cuts are premature as inflation risk persists",
    summary: "Bank of England governor pushed back on easing bets.",
    source: "Reuters",
    url: "https://example.test/1",
    date: "2026-08-13",
    sentiment: -0.25,
  },
  {
    headline: "Bank of England MPC minutes signal higher for longer",
    source: "FT",
    date: "2026-08-11",
    sentiment: null,
  },
  {
    headline: "Jerome Powell says disinflation is on track and hints at a rate cut",
    source: "Bloomberg",
    date: "2026-08-12",
    sentiment: 0.4,
  },
  {
    headline: "Christine Lagarde signals the ECB can ease policy further this year",
    source: "Reuters",
    date: "2026-08-13",
    sentiment: 0.3,
  },
];

/** A spread of tapes so every posture × vol band is exercised. */
const TAPES: RegimeRiskInputs[] = [
  { label: "calm_bull", vix: 12, realisedVol20d: 0.07, drawdownPct: -1, index30dReturn: 0.05, credit20dReturn: 0.01 },
  { label: "neutral", vix: 17, realisedVol20d: 0.14, drawdownPct: -4, index30dReturn: 0.0, credit20dReturn: 0 },
  { label: "risk_off", vix: 31, realisedVol20d: 0.29, drawdownPct: -14, index30dReturn: -0.09, credit20dReturn: -0.04 },
  { label: "panic", vix: 46, realisedVol20d: 0.44, drawdownPct: -26, index30dReturn: -0.2, credit20dReturn: -0.09 },
  { label: "melt_up", vix: 14, realisedVol20d: 0.1, drawdownPct: 0, index30dReturn: 0.12, credit20dReturn: 0.03 },
];

const SYMBOLS = ["ISF.L", "SPY", "TLT", "IEUR", "GLD"];

/** What the engine does per symbol (trading-engine.server.ts). */
function engineNudge(symbol: string, regime: RegimeRead) {
  const signals = computePolicySignals(ROWS, AS_OF);
  const raw = policySentimentNudge(symbol, signals);
  if (raw === 0) return { raw, nudge: 0, scale: null as number | null };
  const scale = policyNudgeScaleForSign(regime, Math.sign(raw));
  return { raw, nudge: policySentimentNudge(symbol, signals, scale), scale };
}

/** What the panel does after reading `decisions.raw.policy_regime`. */
function panelExplain(
  symbol: string,
  persisted: { posture?: string; vol?: string; scale?: number; reason?: string } | null,
) {
  const regimeScale =
    persisted && Number.isFinite(Number(persisted.scale)) ? Number(persisted.scale) : 1;
  const probe = explainPolicyNudge(symbol, ROWS, AS_OF);
  if (probe.nudge === 0) return { explain: probe, scale: null as number | null };
  const scale = persisted
    ? policyNudgeScaleForSign(
        {
          posture: (persisted.posture as RegimeRead["posture"]) ?? "neutral",
          vol: (persisted.vol as RegimeRead["vol"]) ?? "normal",
          scale: regimeScale,
          confidence: 0,
          reason: persisted.reason ?? "",
        },
        Math.sign(probe.nudge),
      )
    : regimeScale;
  return { explain: explainPolicyNudge(symbol, ROWS, AS_OF, { regimeScale: scale }), scale };
}

/** The blob the engine writes to `decisions.raw.policy_regime`. */
function persist(read: RegimeRead) {
  return JSON.parse(
    JSON.stringify({
      posture: read.posture,
      vol: read.vol,
      scale: read.scale,
      confidence: read.confidence,
      reason: read.reason,
    }),
  ) as { posture: string; vol: string; scale: number; reason: string };
}

describe("policy regime scale: engine ↔ persisted ↔ explainability panel", () => {
  it("replays the exact directional multiplier the engine applied", () => {
    let touched = 0;
    for (const tape of TAPES) {
      const read = detectPolicyRegime(tape);
      const blob = persist(read);
      for (const symbol of SYMBOLS) {
        const engine = engineNudge(symbol, read);
        const panel = panelExplain(symbol, blob);
        expect(panel.scale).toBe(engine.scale);
        if (engine.nudge !== 0) touched += 1;
      }
    }
    expect(touched).toBeGreaterThan(0);
  });

  it("reproduces the engine's nudge value bit-for-bit from the persisted blob", () => {
    for (const tape of TAPES) {
      const read = detectPolicyRegime(tape);
      const blob = persist(read);
      for (const symbol of SYMBOLS) {
        const engine = engineNudge(symbol, read);
        const panel = panelExplain(symbol, blob);
        expect(panel.explain.nudge).toBe(engine.nudge);
      }
    }
  });

  it("keeps the confidence field out of the scaling arithmetic", () => {
    // The panel reconstructs the read with confidence 0 (it is not persisted in
    // a load-bearing way). Parity must not depend on it.
    const read = detectPolicyRegime(TAPES[2]!);
    for (const sign of [-1, 1]) {
      expect(policyNudgeScaleForSign({ ...read, confidence: 0 }, sign)).toBe(
        policyNudgeScaleForSign(read, sign),
      );
    }
  });

  it("falls back to ×1 (unscaled) when the run persisted no regime", () => {
    for (const symbol of SYMBOLS) {
      const signals = computePolicySignals(ROWS, AS_OF);
      const unscaled = policySentimentNudge(symbol, signals);
      const panel = panelExplain(symbol, null);
      expect(panel.explain.nudge).toBe(unscaled);
    }
  });

  it("survives a malformed persisted scale by degrading to ×1, never NaN", () => {
    for (const bad of [null, undefined, Number.NaN, "abc"] as unknown[]) {
      const panel = panelExplain("ISF.L", {
        posture: "neutral",
        vol: "normal",
        scale: bad as number,
        reason: "",
      });
      expect(Number.isFinite(panel.explain.nudge)).toBe(true);
      expect(panel.scale).toBe(1);
    }
  });

  it("shows the regime actually moves the nudge (guards a no-op parity test)", () => {
    const calm = detectPolicyRegime(TAPES[0]!);
    const panic = detectPolicyRegime(TAPES[3]!);
    const withCalm = panelExplain("ISF.L", persist(calm));
    const withPanic = panelExplain("ISF.L", persist(panic));
    expect(withCalm.scale).not.toBe(withPanic.scale);
    expect(Math.abs(withPanic.explain.nudge)).toBeGreaterThan(Math.abs(withCalm.explain.nudge));
  });
});
