import { describe, expect, it } from "vitest";
import {
  PULSE_ALERT_THRESHOLDS as T,
  evaluatePulseAlerts,
  pulseAlertsSignature,
} from "@/lib/market-pulse-alerts";
import type { MarketPulse, PulseQuote } from "@/lib/market-pulse";

function quote(symbol: string, over: Partial<PulseQuote> = {}): PulseQuote {
  return {
    symbol,
    label: symbol,
    group: "equities",
    close: 100,
    asOf: "2026-08-11",
    changePct1d: 0,
    changePct5d: 0,
    changePct1m: 0,
    changePct3m: 0,
    vsSma50Pct: 0,
    aboveSma50: true,
    spark: [],
    ...over,
  };
}

function pulse(over: Partial<MarketPulse> = {}): MarketPulse {
  return {
    asOf: "2026-08-11",
    tone: "neutral",
    toneScore: 55,
    toneReasons: [],
    quotes: [],
    sectors: [],
    breadth: {
      total: 10,
      advancers: 5,
      decliners: 5,
      aboveSma50: 6,
      aboveSma50Pct: 60,
      advancersPct: 50,
    },
    comparison: { days: 90, series: [], keys: [] },
    ...over,
  };
}

describe("market pulse alerts", () => {
  it("stays quiet in calm markets", () => {
    expect(evaluatePulseAlerts(pulse({ quotes: [quote("^VIX", { close: 13 })] }))).toEqual([]);
  });

  it("fires a VIX level alert with value and threshold", () => {
    const [a] = evaluatePulseAlerts(pulse({ quotes: [quote("^VIX", { close: 27 })] }));
    expect(a.id).toBe("vix_level");
    expect(a.severity).toBe("warning");
    expect(a.value).toBe(27);
    expect(a.threshold).toBe(T.vixLevelWarning);
    expect(a.valueText).toBe("27.0");
  });

  it("escalates an extreme VIX to critical", () => {
    const [a] = evaluatePulseAlerts(pulse({ quotes: [quote("^VIX", { close: 40 })] }));
    expect(a.severity).toBe("critical");
    expect(a.threshold).toBe(T.vixLevelCritical);
  });

  it("fires a spike alert on a one-day jump", () => {
    const alerts = evaluatePulseAlerts(
      pulse({ quotes: [quote("^VIX", { close: 20, changePct1d: 24 })] }),
    );
    expect(alerts.map((a) => a.id)).toContain("vix_spike");
  });

  it("fires on weak and collapsed breadth", () => {
    const weak = evaluatePulseAlerts(
      pulse({ breadth: { ...pulse().breadth, aboveSma50: 3, aboveSma50Pct: 30 } }),
    ).find((a) => a.id === "breadth_drop");
    expect(weak?.severity).toBe("warning");
    expect(weak?.valueText).toBe("30%");

    const collapsed = evaluatePulseAlerts(
      pulse({ breadth: { ...pulse().breadth, aboveSma50: 2, aboveSma50Pct: 20 } }),
    ).find((a) => a.id === "breadth_drop");
    expect(collapsed?.severity).toBe("critical");
  });

  it("detects gold/bitcoin divergence in both directions", () => {
    const safety = evaluatePulseAlerts(
      pulse({
        quotes: [
          quote("GLD", { changePct5d: 4 }),
          quote("BTC-USD", { changePct5d: -6 }),
        ],
      }),
    ).find((a) => a.id === "gold_bitcoin_divergence");
    expect(safety?.value).toBeCloseTo(10);
    expect(safety?.symbol).toBe("GLD");
    expect(safety?.title).toContain("flight to safety");

    const risk = evaluatePulseAlerts(
      pulse({
        quotes: [quote("GLD", { changePct5d: -1 }), quote("BTC-USD", { changePct5d: 18 })],
      }),
    ).find((a) => a.id === "gold_bitcoin_divergence");
    expect(risk?.severity).toBe("critical");
    expect(risk?.symbol).toBe("BTC-USD");
  });

  it("ignores a small gold/bitcoin gap", () => {
    const alerts = evaluatePulseAlerts(
      pulse({ quotes: [quote("GLD", { changePct5d: 1 }), quote("BTC-USD", { changePct5d: -2 })] }),
    );
    expect(alerts).toEqual([]);
  });

  it("flags credit stress and risk-off tone", () => {
    const alerts = evaluatePulseAlerts(
      pulse({ toneScore: 22, quotes: [quote("HYG", { changePct5d: -3 })] }),
    );
    expect(alerts.map((a) => a.id).sort()).toEqual(["credit_stress", "risk_off_tone"]);
    expect(alerts[0].severity).toBe("critical"); // critical sorts first
  });

  it("produces a stable signature for cool-down de-duping", () => {
    const p = pulse({ quotes: [quote("^VIX", { close: 27 })] });
    expect(pulseAlertsSignature(evaluatePulseAlerts(p))).toBe("vix_level:warning");
    expect(pulseAlertsSignature([])).toBe("");
  });
});
